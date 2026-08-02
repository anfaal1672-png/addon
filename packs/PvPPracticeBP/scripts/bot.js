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
  mlgWater,
  towerUp,
} from './blocks.js';
import { hasItem, switchMainhand } from './kits.js';
import { combatVelocity, moveSpeed, stepWithTerrain, stopHorizontal, voidBelow } from './movement.js';
import { drawTime, incomingThreat, shootArrow } from './ranged.js';
import { getSettings } from './state.js';
import {
  V,
  approachAngle,
  chance,
  clamp,
  directionToRotation,
  gauss,
  isAlive,
  randInt,
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

    /** @type {import('@minecraft/server').Entity | undefined} */
    this.target = undefined;
    this.perceived = undefined;
    this.lastPerceptionTick = -999;
    this.lastTargetScan = -999;

    this.lastSwingTick = -999;
    this.critWaitUntil = 0;
    this.sprintPauseUntil = 0;
    this.comboUntil = 0;

    this.strafeSign = chance(0.5) ? 1 : -1;
    this.strafeUntil = 0;
    this.aimNoise = { x: 0, y: 0 };
    this.aimNoiseUntil = 0;
    this.threat = undefined;
    this.lastThreatScan = -999;

    this.bow = { charging: false, startTick: 0, goalTicks: 20, nextShotTick: 0 };
    this.eatingUntil = 0;
    this.lastHealTick = -999;
    this.retreatUntil = 0;
    this.recentHits = [];

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
      if (chance(0.35 * stickiness)) this.target = source;
    }
    // A bot that just ate a big combo starts thinking about disengaging.
    if (this.beingCombod(tick) && this.profile.retreatSkill > 0.4) {
      this.retreatUntil = tick + Math.round(20 + 40 * this.profile.retreatSkill);
    }
  }

  beingCombod(tick) {
    return this.recentHits.filter((t) => tick - t < 40).length >= 3;
  }

  dispose(dimensionLookup) {
    cleanupBlocks(dimensionLookup, this.placed);
  }

  /* ------------------------------------------------------------------ tick */

  tick(tick) {
    if (!isAlive(this.entity)) return false;

    this.acquireTarget(tick);

    if (!this.target) {
      this.idle(tick);
      return true;
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
    if (tick - this.lastPerceptionTick < this.profile.reactionTicks) return;
    this.lastPerceptionTick = tick;
    this.perceived = safe(() => ({
      location: { ...this.target.location },
      head: this.target.getHeadLocation ? { ...this.target.getHeadLocation() } : { ...this.target.location },
      velocity: { ...this.target.getVelocity() },
      onGround: this.target.isOnGround,
    }));
  }

  /* ---------------------------------------------------------------- aiming */

  aim(tick) {
    if (tick > this.aimNoiseUntil) {
      const e = this.profile.aimError;
      this.aimNoise = { x: gauss() * e * 0.6, y: gauss() * e };
      this.aimNoiseUntil = tick + randInt(4, 12);
    }

    safe(() => {
      const from = this.entity.getHeadLocation();
      // Predict where the target is heading - only the good bots do this properly.
      const lead = V.scale(this.perceived.velocity, 2 * this.profile.comboSkill);
      const to = V.add(this.perceived.head, lead);
      const want = directionToRotation(V.sub(to, from));

      const current = this.entity.getRotation();
      const speed = this.profile.turnSpeed;
      const next = {
        x: clamp(approachAngle(current.x, want.x + this.aimNoise.x, speed), -89, 89),
        y: approachAngle(current.y, want.y + this.aimNoise.y, speed),
      };
      this.entity.setRotation(next);
    });
  }

  /** How far off the bot's crosshair currently is, in degrees. Gates whether a swing lands. */
  aimOffBy() {
    return (
      safe(() => {
        const from = this.entity.getHeadLocation();
        const want = directionToRotation(V.sub(this.perceived.head, from));
        const cur = this.entity.getRotation();
        const dy = Math.abs(((want.y - cur.y + 540) % 360) - 180);
        const dx = Math.abs(want.x - cur.x);
        return Math.hypot(dx, dy);
      }, 180) ?? 180
    );
  }

  /* ----------------------------------------------------------------- idling */

  idle(tick) {
    // No opponent: stand still, face forward, occasionally shuffle so it does not look frozen.
    if (tick % 40 === 0 && chance(0.3)) {
      this.strafeSign = chance(0.5) ? 1 : -1;
    }
    stopHorizontal(this.entity);
    this.bow.charging = false;
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

    const retreating = tick < (this.retreatUntil ?? 0) && p.retreatSkill > 0.3;
    if (retreating) approach = -1;

    // Circle strafing: the sign flips on a timer that gets tighter with skill.
    if (tick > this.strafeUntil) {
      this.strafeSign = chance(0.5) ? 1 : -1;
      this.strafeUntil = tick + randInt(Math.round(24 - 14 * p.strafe), Math.round(46 - 22 * p.strafe));
    }
    // Strafing is a spacing tool, not a travel tool: it fades out the further away the
    // opponent is, otherwise the sideways component eats the closing speed and the bot
    // can never catch anyone who simply runs away.
    const rangeFactor = clamp(1 - (dist - desired) / 2, 0, 1);
    let strafe = this.strafeSign * p.strafe * rangeFactor;
    // Committing to a chase: you cannot circle someone and outrun them at the same time.
    if (approach > 0.5) strafe *= 0.35;

    // Arrow / projectile dodging overrides the strafe direction entirely.
    // The scan is throttled: it is the most expensive call in the tick, and an arrow
    // in flight is still there three ticks later.
    if (p.dodgeSkill > 0.05) {
      if (tick - this.lastThreatScan >= 3) {
        this.lastThreatScan = tick;
        this.threat = incomingThreat(this.entity, 14);
      }
      const threat = this.threat;
      if (threat && isAlive(threat.entity) && chance(p.dodgeSkill)) {
        strafe = 0;
        const dodge = threat.dodge;
        stepWithTerrain(
          this.entity,
          { x: dodge.x * SPRINT_SPEED, z: dodge.z * SPRINT_SPEED },
          { sprinting: true }
        );
        if (threat.ticks < 6 && chance(p.dodgeSkill * 0.5)) {
          safe(() => this.entity.isOnGround && this.entity.applyImpulse({ x: 0, y: 0.42, z: 0 }));
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
      dist > 1.4 &&
      approach > 0 &&
      chance(0.6 + 0.4 * p.sprintSkill) &&
      p.sprintSkill > 0.05;

    safe(() => {
      this.entity.isSprinting = sprinting;
    });

    // Incoming knockback control: better bots counter-strafe back into you.
    let speedScale = 1;
    if (p.kbControl > 0 && this.recentHits.length) {
      const sinceHit = tick - this.recentHits[this.recentHits.length - 1];
      if (sinceHit < 6) speedScale = 1 + 0.5 * p.kbControl;
    }
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

    const vel = combatVelocity({ toTarget: flat, approach, strafe, sprinting, speedScale });
    const terrain = stepWithTerrain(this.entity, vel, { sprinting, allowFall: p.jitter > 0.3 });

    // Gap in the way: bridge across it rather than giving up the chase.
    if (settings.allowBuilding && terrain.gap >= 3 && p.buildSkill > 0.3 && chance(p.buildSkill)) {
      bridgeForward(this.entity, flat, this.placed);
    }

    // Under pressure with blocks in the bag: tower or wall off, exactly like a real clutch.
    if (settings.allowBuilding && this.beingCombod(tick) && p.buildSkill > 0.5) {
      if (chance(p.buildSkill * 0.25)) {
        if (this.healthFraction < 0.4) {
          safe(() => this.entity.isOnGround && this.entity.applyImpulse({ x: 0, y: 0.42, z: 0 }));
          towerUp(this.entity, this.placed);
        } else {
          blockOff(this.entity, flat, this.placed);
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

  meleeRoutine(tick, dist, vertical) {
    const p = this.profile;
    const reach = Math.min(p.reach, BASE_REACH + 0.05);
    const inRange = dist <= reach && Math.abs(vertical) <= 2.0;

    const melee = this.preferredMelee();
    if (melee) switchMainhand(this.entity, melee);

    if (!inRange) {
      this.critWaitUntil = 0;
      return;
    }

    const interval = Math.max(1, Math.round(20 / p.cps));
    if (tick - this.lastSwingTick < interval) return;

    const since = ticksSinceDamage(this.target.id, tick);
    const disciplined = chance(p.iframeAwareness);
    const onGround = safe(() => this.entity.isOnGround, false) ?? false;
    const canCrit = p.critSkill > 0 && dist < reach - 0.2;

    if (this.critWaitUntil > tick) {
      // A jump is already set up: hold the swing until the fall starts, which is what
      // turns it into a 1.5x critical rather than a wasted hop.
      if (!isCriticalPosition(this.entity)) return;
    } else if (since < IFRAME_TICKS) {
      // The target is invulnerable. A good bot spends the window setting up the next
      // jump-crit so that the apex lines up with the moment invulnerability ends;
      // a bad bot just mashes through it for nothing.
      if (canCrit && onGround && since >= 4 && since <= 7 && chance(p.critSkill)) {
        safe(() => this.entity.applyImpulse({ x: 0, y: 0.42, z: 0 }));
        this.critWaitUntil = tick + 8;
        return;
      }
      if (disciplined) return;
    } else if (canCrit && onGround && chance(p.critSkill)) {
      // Opening hit of an exchange: hop first, connect on the way down.
      safe(() => this.entity.applyImpulse({ x: 0, y: 0.42, z: 0 }));
      this.critWaitUntil = tick + 8;
      return;
    }

    // Aim gate: if the crosshair is not on the target the swing simply misses.
    const off = this.aimOffBy();
    const aimPenalty = clamp(off / 45, 0, 1);
    const hitChance = clamp(p.hitChance * (1 - aimPenalty * 0.8), 0.02, 1);

    this.lastSwingTick = tick;
    this.critWaitUntil = 0;
    const result = swing(this.entity, this.target, {
      tick,
      missChance: 1 - hitChance,
      wtap: p.wtapSkill,
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

    const retreating = tick < (this.retreatUntil ?? 0);
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
      this.strafeSign = chance(0.5) ? 1 : -1;
      this.strafeUntil = tick + randInt(20, 40);
    }
    const vel = combatVelocity({
      toTarget: flat,
      approach,
      strafe: this.strafeSign * p.strafe * 0.8,
      sprinting: false,
      speedScale: 0.85,
    });
    stepWithTerrain(this.entity, vel, { sprinting: false });

    if (!this.bow.charging) {
      if (tick < this.bow.nextShotTick) return;
      this.bow.charging = true;
      this.bow.startTick = tick;
      this.bow.goalTicks = drawTime(p.bowSkill);
      safe(() => this.entity.playAnimation('animation.humanoid.bow_and_arrow'));
      return;
    }

    const charged = tick - this.bow.startTick;
    if (charged < this.bow.goalTicks) return;

    const fired = shootArrow(this.entity, this.target, this.perceived.velocity, {
      skill: p.bowSkill,
      chargeTicks: charged,
      spreadDegrees: 16,
    });
    this.bow.charging = false;
    this.bow.nextShotTick = tick + randInt(4, 10) + Math.round(10 * (1 - p.bowSkill));
    if (!fired) this.bow.nextShotTick = tick + 20;
  }

  /* ------------------------------------------------------------- survival */

  /** Golden apples, exactly as a player would use them: back off, wall up, then eat. */
  maybeHeal(tick, flat) {
    const p = this.profile;
    if (p.healThreshold <= 0) return false;

    if (tick < this.eatingUntil) {
      // Committed to the animation: retreat and hold still-ish while it finishes.
      const vel = combatVelocity({
        toTarget: flat,
        approach: -1,
        strafe: this.strafeSign * p.strafe * 0.5,
        sprinting: false,
      });
      stepWithTerrain(this.entity, vel, { sprinting: false });
      return true;
    }

    if (this.healthFraction > p.healThreshold) return false;
    if (tick - this.lastHealTick < 100) return false;

    const enchanted = countItem(this.entity, 'minecraft:enchanted_golden_apple') > 0;
    const normal = countItem(this.entity, 'minecraft:golden_apple') > 0;
    if (!enchanted && !normal) return false;

    if (getSettings().allowBuilding && p.buildSkill > 0.4) blockOff(this.entity, flat, this.placed);

    const item = enchanted ? 'minecraft:enchanted_golden_apple' : 'minecraft:golden_apple';
    if (!consumeItem(this.entity, item, 1)) return false;

    this.lastHealTick = tick;
    this.eatingUntil = tick + 32; // vanilla eat time
    safe(() => this.entity.dimension.playSound('random.eat', this.entity.location));

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
    return true;
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
      if (getSettings().allowBuilding && p.buildSkill > 0.5 && chance(p.buildSkill)) {
        const dir = safe(() => {
          const v = this.entity.getVelocity();
          return V.normalizeXZ({ x: -v.x, z: -v.z });
        }, { x: 0, z: 0 });
        if (bridgeForward(this.entity, dir, this.placed)) return true;
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
