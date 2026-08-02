/**
 * The bot brain.
 *
 * One instance per living bot, ticked 20 times a second. Everything the bot does is
 * decided here and then carried out through the movement / combat / blocks / ranged
 * modules. The bot has no stat advantages of any kind: 20 hearts, player speed, player
 * reach, real items. The only thing that changes between level 1 and level 5 is how
 * well it plays.
 */

import { BASE_REACH, IFRAME_TICKS, SPRINT_SPEED, levelProfile } from './config.js';
import {
  getHeldItem,
  hasLineOfSight,
  isCriticalPosition,
  swing,
  ticksSinceDamage,
} from './combat.js';
import {
  blockOff,
  bridgeForward,
  cleanupBlocks,
  consumeItem,
  countItem,
  forgetPlacements,
  mlgWater,
  towerUp,
} from './blocks.js';
import { consumeHeldItem, forgetHand, hasItem, switchMainhand } from './kits.js';
import { USING_BOW, USING_ITEM, USING_NONE, playSwing, setUsing } from './anim.js';
import {
  combatVelocity,
  driveHorizontal,
  jump,
  moveSpeed,
  setBodyRotation,
  stepWithTerrain,
  stopHorizontal,
  voidBelow,
} from './movement.js';
import { AimAxis, Delayed, HumanState, aimTuning, sampleLatency } from './human.js';
import { drawTime, incomingThreat, shootArrow } from './ranged.js';
import { getSettings } from './state.js';
import {
  V,
  angleDelta,
  approachAngle,
  clamp,
  directionToRotation,
  isAlive,
  makeRng,
  rotateXZ,
  safe,
} from './util.js';

const MELEE_ITEMS = new Set([
  'minecraft:wooden_sword',
  'minecraft:stone_sword',
  'minecraft:golden_sword',
  'minecraft:iron_sword',
  'minecraft:diamond_sword',
  'minecraft:netherite_sword',
  'minecraft:wooden_axe',
  'minecraft:stone_axe',
  'minecraft:golden_axe',
  'minecraft:iron_axe',
  'minecraft:diamond_axe',
  'minecraft:netherite_axe',
  'minecraft:trident',
  'minecraft:mace',
]);

export class BotBrain {
  /**
   * @param {import('@minecraft/server').Entity} entity
   * @param {{level: number, kit: string, home: {location: object, dimensionId: string}}} opts
   */
  constructor(entity, { level, kit, home }) {
    this.entity = entity;
    this.id = entity.id;
    this.level = clamp(Math.round(level), 1, 5);
    this.profile = levelProfile(this.level);
    this.kit = kit;
    this.home = home;

    /**
     * This bot's own random stream, seeded from its entity id.
     *
     * Everything personal - phase, timing error, strafe flips, misplays, tremor - draws from
     * here rather than a shared generator, so two bots can never fall into the same sequence
     * no matter what order they are ticked in or what else drew numbers first.
     */
    this.rng = makeRng(entity.id);

    /** @type {import('@minecraft/server').Entity | undefined} */
    this.target = undefined;
    this.perceived = undefined;
    // Every timer gets a random phase.
    //
    // Two bots created on the same tick, running identical code, otherwise decide identical
    // things on identical ticks forever: they swing in unison, flip strafe direction in
    // unison and read as one entity rendered twice. Real opponents are never in phase.
    this.phase = this.rng.int(0, 19);

    /** Reaction times, attention lapses, drift, tilt and hand tremor all live here. */
    this.human = new HumanState(this.profile, this.rng);
    /** Target state the bot is entitled to know about, delayed by smooth-pursuit lag. */
    this.perceptionQueue = new Delayed();
    this.nextGlance = -999 + this.phase;
    /** One entry per thing the bot might notice; each carries its own choice-reaction delay. */
    this.stimuli = Object.create(null);

    this.aimYawAxis = new AimAxis(safe(() => entity.getRotation().y, 0) ?? 0, { wrap: true });
    this.aimPitchAxis = new AimAxis(0);

    this.lastSwingTick = -999 + this.phase;
    this.lastAirSwing = -999 + this.phase;
    this.airSwingInterval = this.rng.int(2, 5);
    this.placeFocus = undefined;
    /**
     * How many ticks past the end of the target's invulnerability this bot actually swings.
     *
     * Even a frame-perfect player feels the window rather than reading it. Without this every
     * bot fighting the same opponent swings on precisely the same tick, so two of them move
     * as one object rendered twice.
     */
    this.swingBias = this.rng.int(0, 2);
    this.lastTargetScan = -999 + this.phase;
    this.critWaitUntil = 0;
    this.sprintPauseUntil = 0;
    this.comboUntil = 0;

    this.strafeSign = this.rng.sign();
    this.strafeUntil = 0;
    this.wanderAngle = 0;
    this.wanderUntil = 0;
    this.aimNoise = { x: 0, y: 0 };
    this.aimNoiseUntil = 0;
    this.threat = undefined;
    this.lastThreatScan = -999;

    this.bow = { charging: false, startTick: 0, goalTicks: 20, nextShotTick: 0 };
    this.eatingUntil = 0;
    this.eatingItem = undefined;
    this.eatingSwapBack = undefined;
    this.lastHealTick = -999;
    this.retreatUntil = 0;
    this.retreatFrom = Infinity;
    this.recentHits = [];

    /** Sprint state lives here: Entity.isSprinting is read-only, so the engine never has it. */
    this.sprinting = false;
    /** Yaw the body is currently facing, lerped rather than snapped. */
    this.bodyYaw = safe(() => entity.getRotation().y, 0) ?? 0;

    /** @type {{x:number,y:number,z:number,dimensionId:string,water?:boolean}[]} */
    this.placed = [];
  }

  /* ------------------------------------------------------------- accessors */

  get health() {
    return safe(() => this.entity.getComponent('minecraft:health')?.currentValue, 0) ?? 0;
  }

  get maxHealth() {
    return safe(() => this.entity.getComponent('minecraft:health')?.effectiveMax, 20) ?? 20;
  }

  get healthFraction() {
    const max = this.maxHealth || 20;
    return clamp(this.health / max, 0, 1);
  }

  setLevel(level) {
    this.level = clamp(Math.round(level), 1, 5);
    this.profile = levelProfile(this.level);
    this.human.setProfile(this.profile);
    this.refreshName();
  }

  refreshName() {
    const s = getSettings();
    safe(() => {
      this.entity.nameTag = s.showLevelInName ? `${s.botName} §7[Lv${this.level}]` : s.botName;
    });
  }

  info() {
    return {
      id: this.id,
      level: this.level,
      kit: this.kit,
      health: Math.round(this.health * 10) / 10,
      maxHealth: this.maxHealth,
      location: safe(() => this.entity.location),
    };
  }

  /** Called by the manager whenever this bot takes damage, so it can react. */
  onHurt(tick, source) {
    this.recentHits.push(tick);
    if (this.recentHits.length > 12) this.recentHits.shift();

    // Getting hit from behind by someone else pulls the bot's attention across.
    if (source && source.id !== this.target?.id && this.level >= 3) {
      const stickiness = 1 - this.profile.jitter;
      if (this.rng.chance(0.35 * stickiness)) this.target = source;
    }
    // Being hit rattles people: latencies rise and aim gets shakier for a moment.
    this.human.rattle(tick);

    // Deciding to disengage is a decision, so it lands a reaction time later rather than on
    // the same tick as the hit that prompted it.
    if (this.beingCombod(tick) && this.profile.retreatSkill > 0.4) {
      const delay = Math.round(this.human.decisionLatency(tick));
      this.retreatFrom = tick + delay;
      this.retreatUntil = tick + delay + Math.round(20 + 40 * this.profile.retreatSkill);
    }
  }

  /**
   * Options handed to every block placement: the tick (for the one-block-at-a-time
   * cooldown) and a callback that turns the bot to face the block it is about to place.
   * A player has to be looking at the face they are placing against; a bot that builds a
   * wall while staring somewhere else is instantly wrong.
   */
  placeOpts(tick) {
    return {
      tick,
      onPlace: (pos) => {
        this.placeFocus = {
          // Aim at the centre of the block.
          pos: { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 },
          until: tick + 6,
        };
      },
    };
  }

  /**
   * Choice reaction time, applied to any yes/no decision.
   *
   * Pass whether the condition is true *right now*; this returns whether the bot has had
   * time to notice it and pick a response. Letting go of the condition resets the clock, so
   * a stimulus that flickers on and off never gets acted on - which is also what happens to
   * people.
   */
  noticed(key, tick, active) {
    let s = this.stimuli[key];
    if (!s) {
      s = this.stimuli[key] = { readyAt: undefined };
    }
    if (!active) {
      s.readyAt = undefined;
      return false;
    }
    if (s.readyAt === undefined) {
      s.readyAt = tick + Math.round(this.human.decisionLatency(tick));
    }
    return tick >= s.readyAt;
  }

  beingCombod(tick) {
    return this.recentHits.filter((t) => tick - t < 40).length >= 3;
  }

  dispose(dimensionLookup) {
    cleanupBlocks(dimensionLookup, this.placed);
    forgetPlacements(this.id);
    forgetHand(this.id);
  }

  /* ------------------------------------------------------------------ tick */

  tick(tick) {
    if (!isAlive(this.entity)) return false;

    // Finishing a meal is not conditional on still having an opponent. Driving this from
    // act() meant a bot that killed or lost its target mid-bite stayed frozen holding an
    // apple, and never swapped its weapon back.
    if (this.eatingItem && tick >= this.eatingUntil) this.finishEating(tick);

    this.human.update(tick);

    // Compared by id, not by object identity: the script API hands out a *new* Entity wrapper
    // every time you query the world, so `!==` is true even when it is the same opponent.
    // Getting this wrong made the bot re-engage on every rescan and stand frozen through the
    // reaction delay again and again - which looked like "it never runs".
    const hadTargetId = this.target?.id;
    this.acquireTarget(tick);

    if (!this.target) {
      this.idle(tick);
      return true;
    }

    // Noticing a new opponent costs a full choice reaction before anything else happens.
    if (this.target.id !== hadTargetId) {
      this.human.engage(tick);
      this.engageReadyAt = tick + Math.round(this.human.decisionLatency(tick));
      this.perceptionQueue.clear();
    }

    this.perceive(tick);
    if (!this.perceived) return true;

    this.aim(tick);
    this.act(tick);
    return true;
  }

  /* --------------------------------------------------------------- targeting */

  acquireTarget(tick) {
    const settings = getSettings();

    if (this.target && isAlive(this.target)) {
      const d = safe(() => V.distance(this.entity.location, this.target.location), 999) ?? 999;
      const sameDim = safe(() => this.target.dimension.id === this.entity.dimension.id, false);
      if (sameDim && d <= settings.targetRange * 1.5) {
        // Keep the current target unless a rescan is due.
        if (tick - this.lastTargetScan < 20) return;
      } else {
        this.target = undefined;
      }
    }

    if (tick - this.lastTargetScan < 5) return;
    this.lastTargetScan = tick;

    const candidates = safe(() => {
      const found = [];
      const near = this.entity.dimension.getEntities({
        location: this.entity.location,
        maxDistance: settings.targetRange,
      });
      for (const e of near) {
        if (e.id === this.id) continue;
        if (e.typeId === 'minecraft:player') {
          if (safe(() => e.hasTag('pvp:ignore'), false)) continue;
          if (settings.ignoreCreative) {
            const mode = String(safe(() => e.getGameMode?.() ?? e.gameMode) ?? '').toLowerCase();
            if (mode === 'creative' || mode === 'spectator') continue;
          }
          found.push(e);
        } else if (settings.botVsBot && e.typeId === 'pvp:bot') {
          found.push(e);
        }
      }
      return found;
    }, []);

    if (!candidates?.length) {
      this.target = undefined;
      return;
    }

    const origin = this.entity.location;
    let best;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const dist = V.distance(origin, c.location);
      // Better players focus the weakest opponent; beginners just chase the closest body.
      const hp = safe(() => c.getComponent('minecraft:health')?.currentValue, 20) ?? 20;
      const focus = this.profile.comboSkill;
      const score = -dist - focus * hp * 0.6 + (c.id === this.target?.id ? 2 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    this.target = best;
  }

  /**
   * Reaction time. The bot only refreshes its picture of the fight every
   * `reactionTicks` ticks, so a level 1 bot is aiming at where you were 0.6 s ago
   * while a level 5 bot is effectively frame-perfect.
   */
  perceive(tick) {
    // Two separate things happen here. The bot looks at its opponent at irregular intervals
    // rather than on a fixed clock, and what it sees only becomes usable after the smooth-
    // pursuit lag. A fixed sampling period is machine-like on its own, and zero lag makes
    // even a "slow" bot able to punish something the instant it happens.
    if (tick >= this.nextGlance) {
      const interval = sampleLatency(this.profile.reactionTicks, this.profile.reactionJitter, this.rng);
      this.nextGlance = tick + Math.max(1, Math.round(interval));

      const snapshot = safe(() => ({
        location: { ...this.target.location },
        head: this.target.getHeadLocation ? { ...this.target.getHeadLocation() } : { ...this.target.location },
        velocity: { ...this.target.getVelocity() },
        onGround: this.target.isOnGround,
      }));
      if (snapshot) {
        this.perceptionQueue.push(tick, snapshot, Math.round(this.human.trackingLatency(tick)));
      }
    }

    const seen = this.perceptionQueue.read(tick);
    if (seen) this.perceived = seen;
  }

  /* ---------------------------------------------------------------- aiming */

  /**
   * Aim is tracked in the brain, not in the entity's rotation.
   *
   * `Entity.setRotation` moves the *body*, and a body that snaps to face you every tick is
   * the clearest possible tell that something is not a player. So the brain keeps its own
   * aim yaw/pitch (used for hit detection), the head is left to the look-at goal in the
   * behaviour pack, and the body is turned separately in `faceBody`.
   */
  aim(tick) {
    if (tick > this.aimNoiseUntil) {
      const e = this.profile.aimError;
      this.aimNoise = { x: this.rng.gauss() * e * 0.6, y: this.rng.gauss() * e };
      this.aimNoiseUntil = tick + this.rng.int(4, 12);
    }

    safe(() => {
      const from = this.entity.getHeadLocation();

      // Placing a block takes priority over tracking the opponent, for as long as the
      // placement lasts - that is what a player's view does too.
      const placing = this.placeFocus && tick < this.placeFocus.until;
      const to = placing
        ? this.placeFocus.pos
        : V.add(this.perceived.head, V.scale(this.perceived.velocity, 2 * this.profile.comboSkill));
      const want = directionToRotation(V.sub(to, from));

      // The hand is a spring-damper with momentum, not a linear tracker. It overshoots and
      // corrects, and it never fully stops moving - both of which a perfect tracker cannot do.
      const tuning = aimTuning(this.profile, this.human.formFactor(tick));
      this.aimYaw = this.aimYawAxis.step(want.y + this.aimNoise.y, tuning, this.rng);
      this.aimPitch = clamp(this.aimPitchAxis.step(want.x + this.aimNoise.x, tuning, this.rng), -89, 89);
    });
  }

  /**
   * Turns the body the way a player's body turns: towards where it is walking, catching up
   * to where the head is looking only when it drifts too far or the bot is standing still.
   */
  faceBody(moveDir, moving, tick) {
    const aimYaw = this.aimYaw ?? this.bodyYaw;
    let wantYaw = aimYaw;

    // While placing a block the body squares up to it, like a player's does.
    const placing = this.placeFocus && tick !== undefined && tick < this.placeFocus.until;

    if (!placing && moving && (moveDir.x !== 0 || moveDir.z !== 0)) {
      wantYaw = directionToRotation({ x: moveDir.x, y: 0, z: moveDir.z }).y;

      // A head can only twist so far off the shoulders; past that the body follows. The clamp
      // is skipped while disengaging, because holding it there is exactly what produced the
      // backwards-shuffle: the body stayed pointed at the opponent while the bot ran away.
      if (!this.disengaging) {
        const off = angleDelta(wantYaw, aimYaw);
        if (Math.abs(off) > 50) wantYaw = aimYaw - Math.sign(off) * 50;
      }
    }

    // Turning while sprinting away is quicker than a shoulder check.
    const turnRate = this.disengaging ? 40 : 22;
    this.bodyYaw = approachAngle(this.bodyYaw, wantYaw, turnRate);
    setBodyRotation(this.entity, this.bodyYaw, this.aimPitch ?? 0);
  }

  /** How far off the bot's aim currently is from the target, in degrees. */
  aimOffBy() {
    return (
      safe(() => {
        const from = this.entity.getHeadLocation();
        const want = directionToRotation(V.sub(this.perceived.head, from));
        const dy = Math.abs(angleDelta(this.aimYaw ?? 0, want.y));
        const dx = Math.abs((this.aimPitch ?? 0) - want.x);
        return Math.hypot(dx, dy);
      }, 180) ?? 180
    );
  }

  /* ----------------------------------------------------------------- idling */

  idle(tick) {
    // No opponent: stand still, face forward, occasionally shuffle so it does not look frozen.
    if (tick % 40 === 0 && this.rng.chance(0.3)) {
      this.strafeSign = this.rng.sign();
    }
    stopHorizontal(this.entity);
    this.sprinting = false;
    this.bow.charging = false;
    setUsing(this.entity, USING_NONE);
    this.maybeSelfPreserve(tick);
  }

  /* ------------------------------------------------------------- main brain */

  act(tick) {
    const p = this.profile;
    const settings = getSettings();
    const self = this.entity.location;
    const targetLoc = this.perceived.location;

    const flat = V.normalizeXZ(V.sub(targetLoc, self));
    const dist = V.distanceXZ(self, targetLoc);
    const vertical = targetLoc.y - self.y;

    if (this.maybeSelfPreserve(tick)) return;

    // Still reacting to the opponent showing up: stand there like a person who has not
    // processed it yet, rather than snapping into a perfect duel stance on frame one.
    if (tick < (this.engageReadyAt ?? -1)) {
      stopHorizontal(this.entity);
      this.faceBody(flat, false, tick);
      return;
    }

    if (this.maybeHeal(tick, flat)) return;

    const wantsBow = this.shouldUseBow(dist, tick);
    if (wantsBow) {
      this.rangedRoutine(tick, flat, dist);
      return;
    }
    if (this.bow.charging) {
      this.bow.charging = false;
      const melee = this.preferredMelee();
      if (melee) switchMainhand(this.entity, melee);
    }

    /* ---- movement ---- */

    const desired = this.desiredRange();
    let approach = 0;
    if (dist > desired + 0.35) approach = 1;
    else if (dist < desired - 0.7) approach = -0.6;
    // "Holding" still means pushing forward: the opponent is usually backing away, and a
    // bot that idles at its preferred range simply gets walked out of reach.
    else approach = 0.5;

    // Disengaging is not the same as backing off a step. Small spacing adjustments are made
    // walking backwards while watching the opponent, but a real retreat means turning round
    // and sprinting, so `disengaging` unlocks both the sprint and the full body turn.
    const disengaging =
      tick >= (this.retreatFrom ?? Infinity) && tick < (this.retreatUntil ?? 0) && p.retreatSkill > 0.3;
    if (disengaging) approach = -1;
    this.disengaging = disengaging;

    // Circle strafing: the sign flips on a timer that gets tighter with skill.
    if (tick > this.strafeUntil) {
      this.strafeSign = this.rng.sign();
      this.strafeUntil = tick + this.rng.int(Math.round(24 - 14 * p.strafe), Math.round(46 - 22 * p.strafe));
    }
    // Strafing is a spacing tool, not a travel tool: it fades out the further away the
    // opponent is, otherwise the sideways component eats the closing speed and the bot
    // can never catch anyone who simply runs away.
    const rangeFactor = clamp(1 - (dist - desired) / 2, 0, 1);
    let strafe = this.strafeSign * p.strafe * rangeFactor;
    // Committing to a chase: you cannot circle someone and outrun them at the same time.
    if (approach > 0.5) strafe *= 0.35;

    // Mid-air the bot is committed to the arc it jumped along - a player does not circle
    // while airborne either, and pretending to only wastes the little air control there is.
    const airborne = !(safe(() => this.entity.isOnGround, true) ?? true);
    if (airborne) {
      strafe *= 0.3;
      approach = Math.max(approach, 0.7);
    }

    // Arrow / projectile dodging overrides the strafe direction entirely.
    // The scan is throttled: it is the most expensive call in the tick, and an arrow
    // in flight is still there three ticks later.
    if (p.dodgeSkill > 0.05) {
      if (tick - this.lastThreatScan >= 3) {
        this.lastThreatScan = tick;
        const found = incomingThreat(this.entity, 14);
        if (found && found.entity?.id !== this.threat?.entity?.id) {
          // Roll the reaction once, when this projectile is first seen. Re-rolling it every
          // tick let the bot keep trying until a low sample came up, so nothing was ever
          // really too fast to dodge.
          found.noticeAt = tick + Math.round(this.human.decisionLatency(tick));
          this.threat = found;
        } else if (found && this.threat) {
          this.threat = { ...found, noticeAt: this.threat.noticeAt };
        } else {
          this.threat = found;
        }
      }
      const threat = this.threat;
      // A projectile that lands before the bot has finished reacting cannot be dodged, which
      // is why point-blank arrows hit and long-range ones do not.
      const canSee = threat && tick >= (threat.noticeAt ?? Infinity);
      if (canSee && isAlive(threat.entity) && this.rng.chance(p.dodgeSkill)) {
        strafe = 0;
        const dodge = threat.dodge;
        stepWithTerrain(
          this.entity,
          { x: dodge.x * SPRINT_SPEED, z: dodge.z * SPRINT_SPEED },
          { sprinting: true }
        );
        if (threat.ticks < 6 && this.rng.chance(p.dodgeSkill * 0.5)) {
          jump(this.entity);
        }
        return;
      }
    }

    // Chasing knockback: right after landing a hit, good bots run their opponent down -
    // but only far enough to get back into reach, not into their face.
    if (tick < this.comboUntil) {
      if (dist > desired - 0.5) approach = 1;
      strafe *= 0.4;
    }

    const sprinting =
      tick > this.sprintPauseUntil &&
      p.sprintSkill > 0.05 &&
      this.rng.chance(0.6 + 0.4 * p.sprintSkill) &&
      // Sprinting away is just as much a thing as sprinting in - a bot that only ever
      // sprints towards you crawls backwards whenever it wants distance.
      ((approach > 0 && dist > 1.4) || disengaging);
    this.sprinting = sprinting;
    this.closing = approach > 0.5;

    let speedScale = 1;
    if (vertical > 1.2) speedScale *= 1.05;

    // A circling player cannot also outrun someone sprinting away: the sideways component
    // costs forward speed. Work out how much forward speed is needed just to keep pace with
    // the opponent's radial velocity, and cap the strafe at whatever is left over. Bots with
    // a slow reaction time do this badly because `perceived.velocity` is out of date.
    const radial = this.perceived.velocity.x * flat.x + this.perceived.velocity.z * flat.z;
    if (radial > 0 && approach > 0) {
      const speed = moveSpeed(sprinting) * speedScale;
      const needForward = clamp((radial + 0.02) / Math.max(speed, 1e-4), 0, 0.98);
      if (needForward > 0) {
        const maxStrafe = Math.abs(approach) * Math.sqrt(1 / (needForward * needForward) - 1);
        strafe = clamp(strafe, -maxStrafe, maxStrafe);
      }
    }

    let vel = combatVelocity({ toTarget: flat, approach, strafe, sprinting, speedScale });

    // Nobody holds a perfectly straight line. A slowly wandering heading error, largest at low
    // skill, is what stops a beginner from walking at you like a rail-guided trolley - and it
    // was the reason two level 1 bots stayed exact mirror images of each other all fight.
    if (tick > this.wanderUntil) {
      this.wanderAngle = this.rng.range(-1, 1) * 35 * p.jitter;
      this.wanderUntil = tick + this.rng.int(10, 30);
    }
    if (this.wanderAngle !== 0) {
      const turned = rotateXZ(vel, this.wanderAngle);
      vel = { x: turned.x, z: turned.z, dir: V.normalizeXZ(turned) };
    }
    // Knockback control is real air-strafing now, not a fake speed bonus: a bot with low
    // kbControl barely steers while airborne, so it takes the full ride from every hit.
    const terrain = stepWithTerrain(this.entity, vel, {
      sprinting,
      allowFall: p.jitter > 0.3,
      airControl: p.kbControl,
    });
    this.faceBody(vel.dir, V.lengthXZ(vel) > 0.02, tick);
    setUsing(this.entity, USING_NONE);

    // Gap in the way: bridge across it rather than giving up the chase.
    if (settings.allowBuilding && terrain.gap >= 3 && p.buildSkill > 0.3 && this.rng.chance(p.buildSkill)) {
      bridgeForward(this.entity, flat, this.placed, this.placeOpts(tick));
    }

    // Under pressure with blocks in the bag: tower or wall off, exactly like a real clutch.
    if (settings.allowBuilding && this.beingCombod(tick) && p.buildSkill > 0.5) {
      if (this.rng.chance(p.buildSkill * 0.25)) {
        if (this.healthFraction < 0.4) {
          jump(this.entity);
          towerUp(this.entity, this.placed, this.placeOpts(tick));
        } else {
          blockOff(this.entity, flat, this.placed, this.placeOpts(tick));
        }
      }
    }

    /* ---- attacking ---- */

    this.meleeRoutine(tick, dist, vertical);
  }

  /* -------------------------------------------------------------- melee */

  desiredRange() {
    // Skilled bots hold the edge of their reach; beginners walk straight into your face.
    // Kept comfortably inside `reach` so the top of the hold band is still a hittable
    // distance - a bot that "spaces" itself out of its own range is just standing around.
    return 1.4 + 0.9 * this.profile.strafe + 0.2 * this.profile.comboSkill;
  }

  preferredMelee() {
    return (
      safe(() => {
        const container = this.entity.getComponent('minecraft:inventory')?.container;
        const held = getHeldItem(this.entity);
        if (held && MELEE_ITEMS.has(held.typeId)) return held.typeId;
        if (!container) return undefined;
        for (let i = 0; i < container.size; i++) {
          const stack = container.getItem(i);
          if (stack && MELEE_ITEMS.has(stack.typeId)) return stack.typeId;
        }
        return undefined;
      }) ?? undefined
    );
  }

  /**
   * The set-up hop for a jump-crit.
   *
   * It is a *sprint*-jump only while closing the distance: the vanilla forward boost is what
   * lets the bot crit someone who is running away. Used at point-blank range it makes the bot
   * lunge straight past its opponent and, with almost no air control to correct with, spend
   * the whole fight overshooting - so at range it is a plain vertical hop, which is what a
   * player actually does to crit someone standing in front of them.
   */
  critJump() {
    const closing = this.closing === true;
    const flat = this.perceived
      ? V.normalizeXZ(V.sub(this.perceived.location, this.entity.location))
      : { x: 0, z: 0 };

    // Point the run-up at the opponent before leaving the ground. Circle-strafing puts most
    // of the bot's speed on a tangent, and with only a sliver of air control it would sail
    // off that tangent for the whole jump and land out of reach. This is the last tick where
    // full ground acceleration is available, so it is the only chance to aim the arc.
    const speed = moveSpeed(closing && this.sprinting) * (closing ? 1 : 0.55);
    driveHorizontal(this.entity, flat.x * speed, flat.z * speed);

    jump(this.entity, { sprinting: closing && this.sprinting, forward: closing ? flat : undefined });
  }

  meleeRoutine(tick, dist, vertical) {
    const p = this.profile;
    const reach = Math.min(p.reach, BASE_REACH + 0.05);
    const inRange = dist <= reach && Math.abs(vertical) <= 2.0;

    const melee = this.preferredMelee();
    if (melee) switchMainhand(this.entity, melee);

    if (!inRange) {
      this.critWaitUntil = 0;
      // Bedrock has no attack cooldown, so players spam-click the whole fight - including
      // while closing the gap. A bot whose arm only moves when a hit is guaranteed to land
      // telegraphs its exact reach.
      // The interval is re-rolled every swing. Nobody clicks on a perfectly fixed period,
      // and a fixed period is also what made two bots spam in perfect unison.
      if (dist < 6 && tick - this.lastAirSwing >= this.airSwingInterval) {
        this.lastAirSwing = tick;
        this.airSwingInterval = Math.max(2, Math.round(20 / p.cps)) + this.rng.int(0, 3);
        playSwing(this.entity);
      }
      return;
    }

    // A little jitter on the interval: perfectly periodic clicking is machine-like, and two
    // bots on the same cadence attack in lockstep.
    const interval = Math.max(1, Math.round(20 / p.cps) + (this.rng.chance(0.35 * p.jitter + 0.15) ? 1 : 0));
    if (tick - this.lastSwingTick < interval) return;

    // A player cannot hit through a wall, so neither can the bot. Checked before the swing
    // rather than inside it so that the bot does not flail at masonry either.
    if (!hasLineOfSight(this.entity, this.target)) return;

    const since = ticksSinceDamage(this.target.id, tick);
    const disciplined = this.rng.chance(p.iframeAwareness);
    const onGround = safe(() => this.entity.isOnGround, false) ?? false;
    const canCrit = p.critSkill > 0 && dist < reach - 0.2;

    if (this.critWaitUntil > tick) {
      // A jump is already set up: hold the swing until the fall starts, which is what
      // turns it into a 1.5x critical rather than a wasted hop.
      if (!isCriticalPosition(this.entity)) return;
    } else if (since < IFRAME_TICKS + this.swingBias) {
      // The target is invulnerable. A good bot spends the window setting up the next
      // jump-crit so that the apex lines up with the moment invulnerability ends;
      // a bad bot just mashes through it for nothing.
      if (canCrit && onGround && since >= 4 && since <= 7 && this.rng.chance(p.critSkill)) {
        this.critJump();
        this.critWaitUntil = tick + 8;
        return;
      }
      if (disciplined) return;
    } else if (canCrit && onGround && this.rng.chance(p.critSkill)) {
      // Opening hit of an exchange: hop first, connect on the way down. Same aimed run-up as
      // the in-combo case, otherwise this one sails off whatever tangent the strafe was on.
      this.critJump();
      this.critWaitUntil = tick + 8;
      return;
    }

    // Aim gate: if the crosshair is not on the target the swing simply misses.
    const off = this.aimOffBy();
    const aimPenalty = clamp(off / 45, 0, 1);
    const hitChance = clamp(p.hitChance * (1 - aimPenalty * 0.8), 0.02, 1);

    this.lastSwingTick = tick;
    this.critWaitUntil = 0;
    // Re-roll the human timing error for the next exchange. Two ticks is about 100 ms, which
    // is roughly the spread a real player has even when they know the window exactly.
    this.swingBias = this.rng.int(0, 2 + Math.round(2 * p.jitter));
    const result = swing(this.entity, this.target, {
      tick,
      missChance: 1 - hitChance,
      wtap: p.wtapSkill,
      sprinting: this.sprinting,
      rng: this.rng,
    });

    if (result === 'hit') {
      // w-tap: drop sprint for a couple of ticks so the next hit carries sprint knockback again.
      if (p.wtapSkill > 0.2) this.sprintPauseUntil = tick + Math.round(1 + 2 * p.wtapSkill);
      if (p.comboSkill > 0.1) this.comboUntil = tick + Math.round(6 + 10 * p.comboSkill);
    }
  }

  /* --------------------------------------------------------------- ranged */

  shouldUseBow(dist, tick) {
    const p = this.profile;
    if (p.bowSkill < 0.1) return false;
    if (!hasItem(this.entity, 'minecraft:bow')) return false;
    if (countItem(this.entity, 'minecraft:arrow') <= 0) return false;

    const retreating = tick >= (this.retreatFrom ?? Infinity) && tick < (this.retreatUntil ?? 0);
    const noMelee = !this.preferredMelee();
    const far = dist > 7.5;
    return far || retreating || noMelee;
  }

  rangedRoutine(tick, flat, dist) {
    const p = this.profile;
    switchMainhand(this.entity, 'minecraft:bow');

    // Keep moving while drawing: back away if too close, strafe otherwise.
    const approach = dist < 6 ? -1 : dist > 22 ? 0.7 : 0;
    if (tick > this.strafeUntil) {
      this.strafeSign = this.rng.sign();
      this.strafeUntil = tick + this.rng.int(20, 40);
    }
    const vel = combatVelocity({
      toTarget: flat,
      approach,
      strafe: this.strafeSign * p.strafe * 0.8,
      sprinting: false,
      // Drawing a bow slows a player to a crawl. Gliding around at nearly full speed with
      // the bow pulled back is not something a player can do.
      speedScale: this.bow.charging ? 0.3 : 0.9,
    });
    stepWithTerrain(this.entity, vel, { sprinting: false, airControl: p.kbControl });
    this.faceBody(vel.dir, V.lengthXZ(vel) > 0.02, tick);
    this.sprinting = false;

    if (!this.bow.charging) {
      if (tick < this.bow.nextShotTick) {
        setUsing(this.entity, USING_NONE);
        return;
      }
      this.bow.charging = true;
      this.bow.startTick = tick;
      this.bow.goalTicks = drawTime(p.bowSkill);
      setUsing(this.entity, USING_BOW);
      return;
    }

    setUsing(this.entity, USING_BOW);
    const charged = tick - this.bow.startTick;
    if (charged < this.bow.goalTicks) return;

    const fired = shootArrow(this.entity, this.target, this.perceived.velocity, {
      skill: p.bowSkill,
      chargeTicks: charged,
      spreadDegrees: 16,
    });
    this.bow.charging = false;
    setUsing(this.entity, USING_NONE);
    this.bow.nextShotTick = tick + this.rng.int(4, 10) + Math.round(10 * (1 - p.bowSkill));
    if (!fired) this.bow.nextShotTick = tick + 20;
  }

  /* ------------------------------------------------------------- survival */

  /**
   * Golden apples, exactly as a player uses them: hold the apple in hand, wall up, spend the
   * full 32-tick eating animation exposed, and only then get the effects. Applying the buff
   * the instant the decision is made - which is what this used to do - gives the bot a heal
   * no player can match and no animation to go with it.
   */
  maybeHeal(tick, flat) {
    const p = this.profile;
    if (p.healThreshold <= 0) return false;

    if (tick < this.eatingUntil) {
      setUsing(this.entity, USING_ITEM);
      // Vanilla plays the eat sound repeatedly through the animation.
      if ((this.eatingUntil - tick) % 5 === 0) {
        safe(() => this.entity.dimension.playSound('random.eat', this.entity.location, { volume: 0.7 }));
      }
      // Committed: back away while it finishes, and keep facing the threat.
      const vel = combatVelocity({
        toTarget: flat,
        approach: -1,
        strafe: this.strafeSign * p.strafe * 0.5,
        sprinting: false,
        speedScale: 0.3,
      });
      stepWithTerrain(this.entity, vel, { sprinting: false, airControl: p.kbControl });
      this.faceBody(vel.dir, true, tick);
      this.sprinting = false;
      return true;
    }

    if (this.eatingItem) {
      this.finishEating(tick);
      return true;
    }

    // Deciding to eat is a choice reaction, not a threshold trip: a player watches their
    // health bar drop, thinks about it, and only then commits.
    if (!this.noticed('heal', tick, this.healthFraction <= p.healThreshold)) return false;
    if (tick - this.lastHealTick < 100) return false;

    const enchanted = countItem(this.entity, 'minecraft:enchanted_golden_apple') > 0;
    const normal = countItem(this.entity, 'minecraft:golden_apple') > 0;
    if (!enchanted && !normal) return false;

    if (getSettings().allowBuilding && p.buildSkill > 0.4) blockOff(this.entity, flat, this.placed, this.placeOpts(tick));

    const item = enchanted ? 'minecraft:enchanted_golden_apple' : 'minecraft:golden_apple';

    // Put the apple in hand so it is visible for the whole animation, then start eating.
    this.eatingSwapBack = getHeldItem(this.entity)?.typeId;
    if (!switchMainhand(this.entity, item)) return false;

    this.eatingItem = item;
    this.lastHealTick = tick;
    this.eatingUntil = tick + 32; // vanilla eat time, 1.6 s
    setUsing(this.entity, USING_ITEM);
    return true;
  }

  /** Runs when the 32-tick eat animation completes: consume the item, then apply the effects. */
  finishEating(tick) {
    const item = this.eatingItem;
    this.eatingItem = undefined;
    setUsing(this.entity, USING_NONE);

    // The apple is only spent once the animation actually finished - interrupt it and the
    // bot keeps the apple, same as a player. It is eaten out of the hand, falling back to
    // the inventory only if the hand somehow no longer holds it.
    if (!consumeHeldItem(this.entity, item, 1) && !consumeItem(this.entity, item, 1)) {
      this.restoreHand();
      return;
    }

    const enchanted = item === 'minecraft:enchanted_golden_apple';
    safe(() => {
      if (enchanted) {
        this.entity.addEffect('absorption', 2400, { amplifier: 3, showParticles: true });
        this.entity.addEffect('regeneration', 400, { amplifier: 1, showParticles: true });
        this.entity.addEffect('resistance', 6000, { amplifier: 0, showParticles: true });
        this.entity.addEffect('fire_resistance', 6000, { amplifier: 0, showParticles: true });
      } else {
        this.entity.addEffect('absorption', 2400, { amplifier: 0, showParticles: true });
        this.entity.addEffect('regeneration', 100, { amplifier: 1, showParticles: true });
      }
    });
    safe(() => this.entity.dimension.playSound('random.burp', this.entity.location, { volume: 0.6 }));
    this.restoreHand();
  }

  restoreHand() {
    const saved = this.eatingSwapBack;
    this.eatingSwapBack = undefined;
    // Prefer whatever was in hand before the meal, but fall back to any weapon still in the
    // bag - the saved item may have been the last of its kind, or may never have existed.
    if (saved && switchMainhand(this.entity, saved)) return;
    const melee = this.preferredMelee();
    if (melee) switchMainhand(this.entity, melee);
  }

  /**
   * Keeps the bot out of the void and out of lava: bridges, MLGs, or as a last resort
   * teleports back to its arena point rather than vanishing into a hole forever.
   */
  maybeSelfPreserve(tick) {
    const p = this.profile;
    const falling = safe(() => this.entity.getVelocity().y < -0.55, false);

    if (falling && p.buildSkill > 0.3) {
      if (mlgWater(this.entity, this.placed)) return true;
    }

    if (voidBelow(this.entity, 5)) {
      if (getSettings().allowBuilding && p.buildSkill > 0.5 && this.rng.chance(p.buildSkill)) {
        const dir = safe(() => {
          const v = this.entity.getVelocity();
          return V.normalizeXZ({ x: -v.x, z: -v.z });
        }, { x: 0, z: 0 });
        if (bridgeForward(this.entity, dir, this.placed, this.placeOpts(tick))) return true;
      }
      const home = this.home;
      if (home && safe(() => this.entity.location.y < home.location.y - 25, false)) {
        safe(() => this.entity.teleport(home.location, { dimension: this.entity.dimension }));
        return true;
      }
    }

    // Standing on a ledge with nowhere good to go: sneak so we do not walk off it.
    safe(() => {
      this.entity.isSneaking = false;
    });
    return false;
  }
}
