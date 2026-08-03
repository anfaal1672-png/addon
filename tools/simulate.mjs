/**
 * Headless duel simulator.
 *
 * Runs the real `BotBrain` against a fake but physically plausible world so the combat
 * logic can be exercised without launching Minecraft. This is what tells us the level
 * curve actually produces a curve, rather than five bots that all behave the same.
 *
 * Run:  npm run simulate
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const scripts = join(ROOT, 'packs', 'PvPPracticeBP', 'scripts');
const load = (name) => import(pathToFileURL(join(scripts, name)).href);

const { BotBrain } = await load('bot.js');
const { applyKit } = await load('kits.js');
const { ARROW_SPEED, IFRAME_TICKS, LEVELS } = await load('config.js');
const { PLACE_COOLDOWN, placeBlock } = await load('blocks.js');
const { consumeHeldItem, switchMainhand } = await load('kits.js');
const { jump } = await load('movement.js');
const { clearSuppressedErrors, suppressedErrors } = await load('util.js');
const manager = await load('manager.js');
const { getStats } = await load('state.js');
const { system, world } = await import('@minecraft/server');

/* ------------------------------------------------------------- fake world */

const GROUND_Y = 64;

const dimension = {
  id: 'overworld',
  entities: [],
  getBlock(pos) {
    const y = Math.floor(pos.y);
    const solid = y < GROUND_Y;
    return {
      typeId: solid ? 'minecraft:stone' : 'minecraft:air',
      isAir: !solid,
      isLiquid: false,
      setPermutation() {},
    };
  },
  // Flat arena with nothing to hide behind: every sight line is clear.
  getBlockFromRay() {
    return undefined;
  },
  // Supports the same option shapes the add-on actually uses: a radius query, and a
  // type-only query with no location at all (removeAllBots and rescanWorld use the latter).
  getEntities(options = {}) {
    const { location, maxDistance, type } = options;
    return this.entities
      .filter((e) => {
        if (!e.isValid) return false;
        if (type && e.typeId !== type) return false;
        if (!location || maxDistance === undefined) return true;
        const d = Math.hypot(e.location.x - location.x, e.location.y - location.y, e.location.z - location.z);
        return d <= maxDistance;
      })
      // The real script API returns a NEW Entity wrapper on every query - two wrappers for the
      // same entity are never ===. Handing back the same object hid a bug where the bot
      // treated each rescan as a brand new opponent.
      .map((e) => wrapEntity(e));
  },
  shots: [],
  spawnEntity(typeId, location) {
    // Real spawning, so the manager's own spawn path can be exercised end to end.
    if (typeId === 'pvp:bot') return wrapEntity(new FakeEntity('pvp:bot', location));
    if (typeId !== 'minecraft:arrow') return undefined;
    const record = { location: { ...location }, velocity: undefined };
    this.shots.push(record);
    return {
      isValid: true,
      getComponent: (id) =>
        id === 'minecraft:projectile'
          ? {
              set owner(_v) {},
              shoot: (v) => {
                record.velocity = { ...v };
              },
            }
          : undefined,
      applyImpulse: (v) => {
        record.velocity = { ...v };
      },
    };
  },
  // combat.js emits this particle on a critical, which gives us a free crit counter.
  crits: 0,
  particles: new Map(),
  spawnParticle(id) {
    if (id === 'minecraft:critical_hit_emitter') this.crits++;
    this.particles.set(id, (this.particles.get(id) ?? 0) + 1);
  },
  sounds: [],
  playSound(id) {
    this.sounds.push(id);
  },
};

/** A fresh proxy over the same underlying entity, mimicking the script API's wrappers. */
function wrapEntity(entity) {
  return new Proxy(entity, {});
}

let nextId = 1;

class FakeEntity {
  constructor(typeId, location, { health = 20, armour = 0 } = {}) {
    this.id = 'e' + nextId++;
    this.typeId = typeId;
    this.location = { ...location };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.rotation = { x: 0, y: 0 };
    this.isValid = true;
    this.isSprinting = false;
    this.isSneaking = false;
    this.isClimbing = false;
    this.isInWater = false;
    this.armour = armour;
    this.damageTaken = 0;
    this.hitsTaken = 0;
    this.tags = new Set();
    this.dynamic = new Map();
    this.properties = new Map();
    this.commands = [];
    this.swings = 0;
    this.nameTag = '';
    this.equipment = new Map();
    this.slots = new Array(36).fill(undefined);
    this._health = health;
    this._maxHealth = health;
    this.dimension = dimension;
    dimension.entities.push(this);
  }

  get isOnGround() {
    return this.location.y <= GROUND_Y + 1e-6 && this.velocity.y <= 0;
  }

  getVelocity() {
    return { ...this.velocity };
  }

  clearVelocity() {
    this.velocity = { x: 0, y: 0, z: 0 };
  }

  applyImpulse(v) {
    this.velocity.x += v.x;
    this.velocity.y += v.y;
    this.velocity.z += v.z;
  }

  applyKnockback(force, vertical) {
    this.velocity.x += force.x;
    this.velocity.z += force.z;
    this.velocity.y += vertical;
  }

  getRotation() {
    return { ...this.rotation };
  }

  setRotation(r) {
    this.rotation = { ...r };
  }

  getHeadLocation() {
    return { x: this.location.x, y: this.location.y + 1.62, z: this.location.z };
  }

  getViewDirection() {
    return { x: 0, y: 0, z: 1 };
  }

  applyDamage(amount) {
    // The behaviour pack's damage sensor negates melee and projectile damage while the
    // pvp:blocking property is set, so the harness has to honour it too or the shield would
    // "work" in the test and do nothing in game.
    if (this.properties.get('pvp:blocking') === true) {
      this.blockedHits = (this.blockedHits ?? 0) + 1;
      return false;
    }
    // Crude armour model, only so the simulation is not wildly unrealistic.
    const reduced = amount * (1 - Math.min(0.8, this.armour * 0.04));
    this.damageTaken += reduced;
    this.hitsTaken++;
    if (this.invincible) return true;
    this._health = Math.max(0, this._health - reduced);
    if (this._health <= 0) this.isValid = false;
    return true;
  }

  getComponent(id) {
    if (id === 'minecraft:health') {
      return {
        currentValue: this._health,
        effectiveMax: this._maxHealth,
        resetToMaxValue: () => {
          this._health = this._maxHealth;
        },
      };
    }
    if (id === 'minecraft:equippable') {
      if (this.noEquippable) return undefined;
      return {
        getEquipment: (slot) => this.equipment.get(slot),
        setEquipment: (slot, item) => {
          if (item === undefined) this.equipment.delete(slot);
          else this.equipment.set(slot, item);
          return true;
        },
      };
    }
    if (id === 'minecraft:inventory') {
      const slots = this.slots;
      return {
        container: {
          size: slots.length,
          getItem: (i) => slots[i],
          setItem: (i, item) => {
            slots[i] = item;
          },
          addItem: (item) => {
            const free = slots.indexOf(undefined);
            if (free >= 0) slots[free] = item;
          },
          clearAll: () => slots.fill(undefined),
        },
      };
    }
    return undefined;
  }

  addEffect() {}
  playAnimation() {}
  getProperty(k) {
    return this.properties.get(k);
  }
  setProperty(k, v) {
    this.properties.set(k, v);
    if (k === 'pvp:swing_id') this.swings++;
  }
  runCommand(command) {
    this.commands.push(command);
    return { successCount: 1 };
  }
  hasTag(t) {
    return this.tags.has(t);
  }
  getDynamicProperty(k) {
    return this.dynamic.get(k);
  }
  setDynamicProperty(k, v) {
    this.dynamic.set(k, v);
  }
  teleport(loc) {
    this.location = { ...loc };
  }
  lookAt() {}
  remove() {
    this.isValid = false;
  }
}

/**
 * One tick of vanilla-shaped physics: gravity, then movement, then drag.
 *
 * Ground and air drag are deliberately different. Vanilla multiplies horizontal velocity by
 * slipperiness*0.91 on the ground (0.546 on stone) but only 0.91 in the air, which is why
 * momentum carries you through a jump. Using ground friction everywhere - as this simulator
 * originally did - makes anything airborne stop dead and wrongly punishes jump-critting.
 */
function physics(entity) {
  const onGround = entity.location.y <= GROUND_Y + 1e-6 && entity.velocity.y <= 0;

  // Vanilla order: move first, *then* apply gravity and drag. Applying gravity before the
  // first move eats part of the launch velocity and makes every jump measure short, which
  // hid the fact that jump height was wrong in the add-on too.
  entity.location.x += entity.velocity.x;
  entity.location.y += entity.velocity.y;
  entity.location.z += entity.velocity.z;

  if (entity.location.y < GROUND_Y) {
    entity.location.y = GROUND_Y;
    entity.velocity.y = 0;
  } else {
    entity.velocity.y = (entity.velocity.y - 0.08) * 0.98;
  }

  const drag = onGround ? 0.546 : 0.91;
  entity.velocity.x *= drag;
  entity.velocity.z *= drag;
}

/**
 * The height a vanilla player's jump reaches: launch at 0.42 blocks/tick, then
 * v = (v - 0.08) * 0.98 each tick. Summing the positive velocities gives ~1.2522 blocks,
 * which is why a player clears a single block and nothing more.
 */
function vanillaJumpApex() {
  let v = 0.42;
  let y = 0;
  while (v > 0) {
    y += v;
    v = (v - 0.08) * 0.98;
  }
  return y;
}

/* --------------------------------------------------------------- the duel */

/**
 * @param {number} level
 * @param {object} opts
 * @param {'still'|'strafe'|'flee'} opts.behaviour how the practice dummy moves
 */
function duel(level, { behaviour = 'still', ticks = 600, kit = 'diamond', dummyArmour = 0 } = {}) {
  dimension.entities.length = 0;
  dimension.crits = 0;

  const botEntity = new FakeEntity('pvp:bot', { x: 0, y: GROUND_Y, z: 0 });
  const dummy = new FakeEntity('minecraft:player', { x: 8, y: GROUND_Y, z: 0 }, { armour: dummyArmour });
  // The dummy records damage but never dies, so every level gets the same sample window.
  dummy.invincible = true;

  applyKit(botEntity, kit);

  const brain = new BotBrain(botEntity, {
    level,
    kit,
    home: { location: { x: 0, y: GROUND_Y, z: 0 }, dimensionId: 'overworld' },
  });

  let closestApproach = Infinity;
  let tickedWithinReach = 0;

  for (let tick = 1; tick <= ticks; tick++) {
    brain.tick(tick);

    // The dummy is driven by velocity rather than teleported, so knockback from the
    // bot's hits actually composes with its own movement.
    //
    // Except when it is meant to be a punching bag: an invincible dummy that never resists
    // gets launched hundreds of blocks over thirty seconds of sprint hits, and then the
    // "stationary target" scenario is really measuring a chase.
    if (behaviour === 'still') {
      dummy.location = { x: 8, y: GROUND_Y, z: 0 };
      dummy.velocity = { x: 0, y: 0, z: 0 };
    }
    if (behaviour === 'strafe') {
      dummy.velocity.x = Math.cos(tick / 12) * 0.2159;
      dummy.velocity.z = -Math.sin(tick / 12) * 0.2159;
    } else if (behaviour === 'flee') {
      const dx = dummy.location.x - botEntity.location.x;
      const dz = dummy.location.z - botEntity.location.z;
      const len = Math.hypot(dx, dz) || 1;
      dummy.velocity.x = (dx / len) * 0.2159;
      dummy.velocity.z = (dz / len) * 0.2159;
    }

    physics(botEntity);
    physics(dummy);

    const d = Math.hypot(
      botEntity.location.x - dummy.location.x,
      botEntity.location.z - dummy.location.z
    );
    closestApproach = Math.min(closestApproach, d);
    if (d <= 3.0) tickedWithinReach++;
  }

  const seconds = ticks / 20;
  return {
    level,
    dps: dummy.damageTaken / seconds,
    hits: dummy.hitsTaken,
    hitsPerSecond: dummy.hitsTaken / seconds,
    critRate: dummy.hitsTaken ? dimension.crits / dummy.hitsTaken : 0,
    closestApproach,
    engagement: tickedWithinReach / ticks,
  };
}

/* --------------------------------------------------------------- archery */

const { solveArrow } = await load('ranged.js');

/**
 * Puts a bow-kit bot at long range against a strafing target and measures how far its
 * shots land from the ideal lead solution.
 */
function archery(level, { ticks = 600, range = 20 } = {}) {
  dimension.entities.length = 0;
  dimension.shots = [];

  const botEntity = new FakeEntity('pvp:bot', { x: 0, y: GROUND_Y, z: 0 });
  const dummy = new FakeEntity('minecraft:player', { x: range, y: GROUND_Y, z: 0 });
  dummy.invincible = true;

  applyKit(botEntity, 'bow');
  const brain = new BotBrain(botEntity, {
    level,
    kit: 'bow',
    home: { location: { x: 0, y: GROUND_Y, z: 0 }, dimensionId: 'overworld' },
  });

  const errors = [];
  const speeds = [];
  let drawTicks = 0;

  for (let tick = 1; tick <= ticks; tick++) {
    const before = dimension.shots.length;
    brain.tick(tick);

    if (dimension.shots.length > before) {
      const shot = dimension.shots[dimension.shots.length - 1];
      if (shot.velocity) {
        const ideal = solveArrow(botEntity.getHeadLocation(), dummy.location, dummy.getVelocity(), 1);
        const len = Math.hypot(shot.velocity.x, shot.velocity.y, shot.velocity.z) || 1;
        speeds.push(len);
        const dot =
          (shot.velocity.x / len) * ideal.direction.x +
          (shot.velocity.y / len) * ideal.direction.y +
          (shot.velocity.z / len) * ideal.direction.z;
        errors.push((Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI);
      }
    }

    if (botEntity.properties.get('pvp:using') === 2) drawTicks++;

    dummy.velocity.x = Math.cos(tick / 10) * 0.2159;
    dummy.velocity.z = -Math.sin(tick / 10) * 0.2159;

    physics(botEntity);
    physics(dummy);
  }

  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  return {
    level,
    shots: errors.length,
    shotsPerSecond: errors.length / (ticks / 20),
    meanErrorDeg: mean(errors),
    // Arrow speed is proportional to draw strength, which is proportional to damage.
    meanCharge: mean(speeds) / ARROW_SPEED,
    drawTicks,
  };
}

/* ------------------------------------------------------------ desync test */

/**
 * Two identical bots fighting the same opponent must not act in lockstep. Running the same
 * deterministic code from the same starting tick made them swing, strafe and jump on exactly
 * the same ticks, so they moved as one object rendered twice.
 */
function twinSync(level = 5, ticks = 400) {
  dimension.entities.length = 0;

  const dummy = new FakeEntity('minecraft:player', { x: 0, y: GROUND_Y, z: 0 });
  dummy.invincible = true;

  const bots = [-4, 4].map((x) => {
    const e = new FakeEntity('pvp:bot', { x, y: GROUND_Y, z: 0 });
    applyKit(e, 'diamond');
    return {
      entity: e,
      brain: new BotBrain(e, {
        level,
        kit: 'diamond',
        home: { location: { x, y: GROUND_Y, z: 0 }, dimensionId: 'overworld' },
      }),
      swingTicks: new Set(),
    };
  });

  // Mirror-image starting positions, so any divergence comes from the bots, not the setup.
  const mirrorGaps = [];

  for (let tick = 1; tick <= ticks; tick++) {
    for (const bot of bots) {
      const before = bot.entity.swings;
      bot.brain.tick(tick);
      if (bot.entity.swings > before) bot.swingTicks.add(tick);
    }
    for (const bot of bots) physics(bot.entity);
    physics(dummy);

    // Compare each bot against its own mirror image: identical behaviour would keep them
    // exactly reflected about the dummy for the whole fight.
    const [p0, p1] = bots.map((b) => b.entity.location);
    mirrorGaps.push(Math.hypot(p0.x + p1.x, p0.z + p1.z));
  }

  const [a, b] = bots;
  const shared = [...a.swingTicks].filter((t) => b.swingTicks.has(t)).length;
  const total = Math.min(a.swingTicks.size, b.swingTicks.size);
  return {
    shared,
    total,
    overlap: total ? shared / total : 0,
    mirrorDivergence: mirrorGaps.reduce((x, y) => x + y, 0) / mirrorGaps.length,
  };
}

/* ------------------------------------------------------------ jump height */

/** Measures how high the bot actually gets off the ground when it jumps. */
function jumpHeight() {
  dimension.entities.length = 0;
  const bot = new FakeEntity('pvp:bot', { x: 0, y: GROUND_Y, z: 0 });

  // Settle so the entity carries the same residual downward velocity a grounded entity has.
  for (let i = 0; i < 5; i++) physics(bot);
  const residual = bot.velocity.y;

  jump(bot);
  let apex = bot.location.y;
  for (let i = 0; i < 40; i++) {
    physics(bot);
    apex = Math.max(apex, bot.location.y);
    if (bot.location.y <= GROUND_Y && i > 2) break;
  }
  return { apex: apex - GROUND_Y, residual };
}

/* ------------------------------------------------- movement and behaviour */

/**
 * Watches a fight and reports the things that were reported wrong in play testing:
 * how much of the time the bot sprints, how straight it runs, how high it ever gets off the
 * ground, whether the shield goes up and comes back down, and whether eating and drawing look
 * like a player doing those things.
 */
function behaviourProfile(level, { kit = 'netherite', ticks = 900 } = {}) {
  dimension.entities.length = 0;
  dimension.particles.clear();
  dimension.sounds.length = 0;

  const bot = new FakeEntity('pvp:bot', { x: 0, y: GROUND_Y, z: 0 });
  applyKit(bot, kit);
  const brain = new BotBrain(bot, {
    level,
    kit,
    home: { location: { x: 0, y: GROUND_Y, z: 0 }, dimensionId: 'overworld' },
  });

  const dummy = new FakeEntity('minecraft:player', { x: 8, y: GROUND_Y, z: 0 });
  dummy.invincible = true;

  let sprintTicks = 0;
  let freeTicks = 0;
  let blockTicks = 0;
  let attackedWhileBlocking = 0;
  let maxApex = 0;
  let usingBow = 0;
  let usingItem = 0;
  const headings = [];

  for (let tick = 1; tick <= ticks; tick++) {
    const swingsBefore = bot.swings;
    brain.tick(tick);

    const free = bot.properties.get('pvp:using') !== 1 && bot.properties.get('pvp:blocking') !== true;
    if (free) {
      freeTicks++;
      if (brain.sprinting) sprintTicks++;
    }
    if (bot.properties.get('pvp:blocking') === true) {
      blockTicks++;
      if (bot.swings > swingsBefore) attackedWhileBlocking++;
    }
    if (bot.properties.get('pvp:using') === 2) usingBow++;
    if (bot.properties.get('pvp:using') === 1) usingItem++;

    // Circle the opponent and keep hitting the bot so it wants its shield and its apples.
    dummy.velocity.x = Math.cos(tick / 18) * 0.2159;
    dummy.velocity.z = -Math.sin(tick / 18) * 0.2159;
    if (tick % 11 === 0) {
      bot.applyDamage(4);
      brain.onHurt(tick, dummy);
    }
    if (bot._health < 6) bot._health = 12;

    physics(bot);
    physics(dummy);

    maxApex = Math.max(maxApex, bot.location.y - GROUND_Y);
    const speed = Math.hypot(bot.velocity.x, bot.velocity.z);
    if (speed > 0.05) headings.push((Math.atan2(bot.velocity.x, bot.velocity.z) * 180) / Math.PI);
  }

  // How much the heading actually varies: a bot on rails produces almost none.
  let headingChange = 0;
  for (let i = 1; i < headings.length; i++) {
    let d = ((headings[i] - headings[i - 1] + 540) % 360) - 180;
    headingChange += Math.abs(d);
  }

  return {
    level,
    sprintFraction: freeTicks ? sprintTicks / freeTicks : 0,
    blockFraction: blockTicks / ticks,
    attackedWhileBlocking,
    blockedHits: bot.blockedHits ?? 0,
    maxApex,
    usingBow,
    usingItem,
    headingVariance: headings.length > 1 ? headingChange / (headings.length - 1) : 0,
    crumbs: dimension.particles.get('pvp:eat_crumbs') ?? 0,
  };
}

/**
 * Two jumps requested on the same tick must produce one jump.
 *
 * `getVelocity()` reports the velocity from the start of the tick, so the second call cannot
 * see the first one's impulse: it cancels a residual that is no longer there and adds a whole
 * second launch. That is the "sometimes it flies really high" bug.
 */
function doubleJump() {
  dimension.entities.length = 0;
  const bot = new FakeEntity('pvp:bot', { x: 0, y: GROUND_Y, z: 0 });
  for (let i = 0; i < 5; i++) physics(bot);

  jump(bot, { tick: 100 });
  jump(bot, { tick: 100 });
  jump(bot, { tick: 100 });

  let apex = bot.location.y;
  for (let i = 0; i < 40; i++) {
    physics(bot);
    apex = Math.max(apex, bot.location.y);
    if (bot.location.y <= GROUND_Y && i > 2) break;
  }
  return apex - GROUND_Y;
}

/* ---------------------------------------------------------- human factors */

/**
 * Measures how long the bot takes to start responding to something new.
 *
 * The dummy is teleported to a completely different bearing after the bot has settled, and
 * we count ticks until the aim actually starts moving. This picks up the whole chain -
 * glance interval, smooth-pursuit lag and the inertia of the hand - rather than any one
 * number in the config, which is the point: a bot that reacts on the tick the world changes
 * is the single most inhuman thing it can do.
 */
function reactionTest(level, { settle = 80, samples = 24 } = {}) {
  const measurements = [];

  for (let s = 0; s < samples; s++) {
    dimension.entities.length = 0;

    const bot = new FakeEntity('pvp:bot', { x: 0, y: GROUND_Y, z: 0 });
    const dummy = new FakeEntity('minecraft:player', { x: 0, y: GROUND_Y, z: 6 });
    dummy.invincible = true;
    applyKit(bot, 'diamond');

    const brain = new BotBrain(bot, {
      level,
      kit: 'diamond',
      home: { location: { x: 0, y: GROUND_Y, z: 0 }, dimensionId: 'overworld' },
    });

    let tick = 0;
    for (; tick < settle; tick++) {
      brain.tick(tick);
      physics(bot);
    }

    // Teleport the opponent somewhere completely different and count ticks until the bot's
    // internal picture of the world catches up. Measuring the aim instead would be polluted
    // by the bot's own movement, which changes the bearing every tick anyway.
    // Still well inside the bot's target range - the point is to change where the opponent
    // is, not to make it disappear.
    const moved = { x: -6, y: GROUND_Y, z: 0 };
    dummy.location = moved;
    const jumpTick = tick;
    let responded;

    for (; tick < jumpTick + 80; tick++) {
      brain.tick(tick);
      physics(bot);
      const seen = brain.perceived?.location;
      if (seen && Math.hypot(seen.x - moved.x, seen.z - moved.z) < 0.001) {
        responded = tick - jumpTick;
        break;
      }
    }
    if (responded !== undefined) measurements.push(responded);
  }

  measurements.sort((a, b) => a - b);
  if (measurements.length === 0) throw new Error(`reactionTest: level ${level} never perceived the move`);
  const mean = measurements.reduce((a, b) => a + b, 0) / measurements.length;
  return {
    level,
    samples: measurements.length,
    meanTicks: mean,
    meanMs: mean * 50,
    spread: measurements.length ? measurements[measurements.length - 1] - measurements[0] : 0,
  };
}

/* ------------------------------------------------------------- lifecycle */

/**
 * The whole entity lifecycle through the add-on's own event handlers.
 *
 * Spawning, hurting, dying, respawning, statistics and block clean-up are all wired to
 * world events, and none of that had ever been executed by a test - only the tick loop had.
 */
function lifecycle() {
  dimension.entities.length = 0;
  clearSuppressedErrors();
  world.dimensions.set('overworld', dimension);
  system.timeouts.length = 0;

  manager.installEvents();

  // A player to summon from and fight with.
  const player = new FakeEntity('minecraft:player', { x: 0, y: GROUND_Y, z: 0 });
  player.invincible = true;
  player.getGameMode = () => 'survival';
  player.sendMessage = () => {};

  const made = manager.spawnBotsNear(player, { level: 4, kit: 'diamond', count: 2, distance: 5 });
  const brains = manager.listBrains();
  const bot = brains[0];

  // Armour must have been applied through the manager's own spawn path, not just applyKit.
  const helmet = bot?.entity.equipment.get('Head')?.typeId;

  // Hurt it: statistics, tilt and the hurt sound all hang off this event.
  world.afterEvents.entityHurt.dispatch({
    hurtEntity: bot.entity,
    damageSource: { damagingEntity: player },
    damage: 5,
  });
  const statsAfterHit = { ...getStats(player.id) };

  // Give it a placed block so clean-up has something to do.
  bot.placed.push({ x: 5, y: GROUND_Y, z: 5, dimensionId: 'overworld' });

  // Kill it.
  bot.entity.isValid = false;
  world.afterEvents.entityDie.dispatch({
    deadEntity: bot.entity,
    damageSource: { damagingEntity: player },
  });
  const statsAfterKill = { ...getStats(player.id) };
  const brainsAfterDeath = manager.listBrains().length;
  const blocksLeft = bot.placed.length;

  // The respawn is scheduled, not immediate.
  const scheduled = system.timeouts.length;
  system.flushTimeouts();
  const brainsAfterRespawn = manager.listBrains().length;

  const removed = manager.removeAllBots();

  return {
    made,
    helmet,
    damageDealt: statsAfterHit.damageDealt,
    hits: statsAfterHit.hits,
    botKills: statsAfterKill.botKills,
    brainsAfterDeath,
    blocksLeft,
    scheduled,
    brainsAfterRespawn,
    removed,
    remaining: manager.listBrains().length,
    errors: suppressedErrors(),
  };
}

/* ----------------------------------------------------------- full fight */

/**
 * A long fight with everything switched on, asserting that nothing threw.
 *
 * `safe()` swallows exceptions on purpose - entities go invalid mid-tick and that is normal -
 * but silent swallowing is how every bug so far managed to ship looking like "it just does
 * not do the thing". Now that suppressed errors are counted, a clean run is something the
 * suite can actually require.
 */
function fullFight({ level = 5, kit = 'uhc', ticks = 1200 } = {}) {
  dimension.entities.length = 0;
  clearSuppressedErrors();

  const bot = new FakeEntity('pvp:bot', { x: 0, y: GROUND_Y, z: 0 });
  applyKit(bot, kit);
  const brain = new BotBrain(bot, {
    level,
    kit,
    home: { location: { x: 0, y: GROUND_Y, z: 0 }, dimensionId: 'overworld' },
  });

  const dummy = new FakeEntity('minecraft:player', { x: 10, y: GROUND_Y, z: 0 });
  dummy.invincible = true;

  let hurtBot = 0;
  for (let tick = 1; tick <= ticks; tick++) {
    brain.tick(tick);

    // The opponent fights back: circling, and landing a hit every so often so the bot has to
    // heal, tilt, retreat and clutch rather than just walking forward for a minute.
    dummy.velocity.x = Math.cos(tick / 15) * 0.2159;
    dummy.velocity.z = -Math.sin(tick / 15) * 0.2159;
    if (tick % 40 === 0) {
      bot.applyDamage(4);
      brain.onHurt(tick, dummy);
      hurtBot++;
    }
    // Keep it alive so the whole run is exercised.
    if (bot._health < 6) bot._health = 20;

    physics(bot);
    physics(dummy);
  }

  return {
    hurtBot,
    swings: bot.swings,
    placed: brain.placed.length,
    errors: suppressedErrors(),
  };
}

/* ------------------------------------------- equipment without a component */

/**
 * Everything the bot does with items has to work on builds where the entity exposes no
 * `minecraft:equippable` component and the add-on falls back to /replaceitem.
 *
 * That fallback path had never been executed by a single test, because the fake entity here
 * always provided the component - so every bug in it shipped.
 */
function noComponentPath() {
  dimension.entities.length = 0;

  const bot = new FakeEntity('pvp:bot', { x: 0, y: GROUND_Y, z: 0 });
  bot.noEquippable = true;
  applyKit(bot, 'diamond');

  const container = bot.getComponent('minecraft:inventory').container;
  const count = (typeId) => {
    let n = 0;
    for (let i = 0; i < container.size; i++) {
      const st = container.getItem(i);
      if (st?.typeId === typeId) n += st.amount;
    }
    return n;
  };

  const cobbleBefore = count('minecraft:cobblestone');
  const placed = [];
  const didPlace = placeBlock(bot, { x: 3, y: GROUND_Y, z: 3 }, 'minecraft:cobblestone', placed, { tick: 50 });
  const cobbleAfter = count('minecraft:cobblestone');

  const applesBefore = count('minecraft:golden_apple');
  const swappedToApple = switchMainhand(bot, 'minecraft:golden_apple');
  // The reported symptom was precisely this pair: the apple *was* visibly in the bot's hand,
  // and it still never got eaten. So assert the visible half separately from the effect.
  const appleShown = bot.commands.some((c) => c.includes('slot.weapon.mainhand') && c.includes('golden_apple'));
  const ateApple = consumeHeldItem(bot, 'minecraft:golden_apple', 1);
  const applesAfter = count('minecraft:golden_apple');

  // Holding the same item again must not re-issue the command; meleeRoutine calls this every
  // tick, which would be twenty commands a second per bot.
  const beforeRepeat = bot.commands.length;
  switchMainhand(bot, 'minecraft:golden_apple');
  switchMainhand(bot, 'minecraft:golden_apple');
  const repeatCommands = bot.commands.length - beforeRepeat;

  const backToSword = switchMainhand(bot, 'minecraft:diamond_sword');
  const swordShown = bot.commands.some((c) => c.includes('slot.weapon.mainhand') && c.includes('diamond_sword'));

  return {
    didPlace,
    cobbleSpent: cobbleBefore - cobbleAfter,
    swappedToApple,
    appleShown,
    ateApple,
    applesSpent: applesBefore - applesAfter,
    repeatCommands,
    backToSword,
    swordShown,
    commands: bot.commands.length,
  };
}

/* ------------------------------------------------------- placement rules */

/**
 * Survival placement rules, exercised directly rather than through a whole fight because
 * they are absolute: no floating blocks, one block at a time, and look at what you place.
 */
function placementRules() {
  dimension.entities.length = 0;

  const bot = new FakeEntity('pvp:bot', { x: 0, y: GROUND_Y, z: 0 });
  const container = bot.getComponent('minecraft:inventory').container;
  container.addItem({ typeId: 'minecraft:cobblestone', amount: 64 });

  const placed = [];
  const looked = [];
  const opts = (tick) => ({ tick, onPlace: (pos) => looked.push(pos) });

  // Ground is everything below GROUND_Y, so a block at head height with nothing around it
  // is unsupported; one resting on the ground is not.
  const floating = placeBlock(bot, { x: 20, y: GROUND_Y + 5, z: 20 }, 'minecraft:cobblestone', placed, opts(100));
  const supported = placeBlock(bot, { x: 20, y: GROUND_Y, z: 20 }, 'minecraft:cobblestone', placed, opts(100));

  // Immediately afterwards, a second placement must be refused.
  const immediate = placeBlock(bot, { x: 21, y: GROUND_Y, z: 20 }, 'minecraft:cobblestone', placed, opts(100));
  const tooSoon = placeBlock(
    bot,
    { x: 22, y: GROUND_Y, z: 20 },
    'minecraft:cobblestone',
    placed,
    opts(100 + PLACE_COOLDOWN - 1)
  );
  const afterCooldown = placeBlock(
    bot,
    { x: 23, y: GROUND_Y, z: 20 },
    'minecraft:cobblestone',
    placed,
    opts(100 + PLACE_COOLDOWN)
  );

  return { floating, supported, immediate, tooSoon, afterCooldown, looked: looked.length };
}

/* ---------------------------------------------------------------- reports */

function table(title, rows) {
  console.log('\n' + title);
  console.log('  Lv   DPS    hits/s  crit%  engaged  closest');
  for (const r of rows) {
    console.log(
      `  ${r.level}   ${r.dps.toFixed(2).padStart(5)}  ${r.hitsPerSecond.toFixed(2).padStart(6)}  ` +
        `${(r.critRate * 100).toFixed(0).padStart(4)}%  ` +
        `${(r.engagement * 100).toFixed(0).padStart(6)}%  ${r.closestApproach.toFixed(2).padStart(6)}`
    );
  }
}

const still = [1, 2, 3, 4, 5].map((l) => duel(l, { behaviour: 'still' }));
const strafing = [1, 2, 3, 4, 5].map((l) => duel(l, { behaviour: 'strafe' }));
const fleeing = [1, 2, 3, 4, 5].map((l) => duel(l, { behaviour: 'flee' }));

table('Stationary target (30 s, diamond kit)', still);
table('Strafing target (30 s)', strafing);
table('Fleeing target (30 s)', fleeing);

console.log(`\nTheoretical DPS ceiling with a 10-tick i-frame window: one hit every ${IFRAME_TICKS} ticks.`);

const bows = [1, 2, 3, 4, 5].map((l) => archery(l));
console.log('\nArchery vs a strafing target at 20 blocks (30 s, bow kit)');
console.log('  Lv   shots  shots/s  mean aim error  mean draw');
for (const r of bows) {
  console.log(
    `  ${r.level}   ${String(r.shots).padStart(5)}  ${r.shotsPerSecond.toFixed(2).padStart(7)}  ` +
      `${r.meanErrorDeg.toFixed(2).padStart(9)}°  ${(r.meanCharge * 100).toFixed(0).padStart(8)}%`
  );
}

/* ------------------------------------------------------------- assertions */

let failures = 0;
const expect = (cond, msg) => {
  if (cond) {
    console.log('  ✓ ' + msg);
  } else {
    failures++;
    console.error('  ✗ ' + msg);
  }
};

console.log('\nChecks');

expect(still.every((r) => r.hits > 0), 'every level lands hits on a stationary target');
expect(
  still[4].dps > still[0].dps * 1.5,
  `level 5 out-damages level 1 by a wide margin (${still[0].dps.toFixed(2)} -> ${still[4].dps.toFixed(2)} DPS)`
);
expect(
  still.every((r, i) => i === 0 || r.dps >= still[i - 1].dps * 0.85),
  'DPS does not go backwards as the level rises'
);
expect(
  still.every((r) => r.hitsPerSecond <= 20 / IFRAME_TICKS + 0.05),
  'no level exceeds the i-frame hit-rate ceiling (invulnerability is respected)'
);
expect(strafing[4].dps > strafing[0].dps, 'level 5 still tracks a strafing target far better than level 1');
expect(
  fleeing[4].engagement > fleeing[0].engagement,
  `level 5 keeps a fleeing target in reach more of the time ` +
    `(${(fleeing[0].engagement * 100).toFixed(0)}% -> ${(fleeing[4].engagement * 100).toFixed(0)}%)`
);
expect(still.every((r) => r.closestApproach < 3.0), 'every level actually closes to melee range');
expect(still[0].critRate < 0.05, `level 1 essentially never crits (${(still[0].critRate * 100).toFixed(0)}%)`);
expect(bows.every((r) => r.shots > 0), 'every level actually fires its bow at long range');
expect(
  bows.every((r) => r.drawTicks > 0),
  // The resource pack turns this into the player's draw pose and ramps the vanilla bow
  // attachable, which is what puts the arrow on the string.
  `the drawing state reaches the client (${bows.map((r) => r.drawTicks).join('/')} ticks)`
);
expect(
  bows[4].meanErrorDeg < bows[0].meanErrorDeg,
  `bow aim tightens with level (${bows[0].meanErrorDeg.toFixed(1)}° -> ${bows[4].meanErrorDeg.toFixed(1)}°)`
);
expect(
  bows[4].meanCharge > bows[0].meanCharge + 0.2,
  `higher levels draw the bow fully instead of spamming weak shots ` +
    `(${(bows[0].meanCharge * 100).toFixed(0)}% -> ${(bows[4].meanCharge * 100).toFixed(0)}%)`
);
expect(
  still[4].critRate > 0.6,
  `level 5 lands jump-crits on most hits (${(still[4].critRate * 100).toFixed(0)}%)`
);

// Every level, not just one: the first version of this only checked level 5, and the result
// turned out to depend on how many numbers the rest of the suite had drawn beforehand.
// Averaged over several independent pairs. A single pair is a single pair of random seeds,
// and measuring one of those told us more about the seed than about the bots - the same code
// scored 22% in isolation and 91% inside the suite purely because entity ids differed.
const twinsByLevel = [1, 2, 3, 4, 5].map((level) => {
  const trials = Array.from({ length: 6 }, () => twinSync(level));
  const mean = (pick) => trials.reduce((a, t) => a + pick(t), 0) / trials.length;
  return {
    level,
    shared: Math.round(mean((t) => t.shared)),
    total: Math.round(mean((t) => t.total)),
    overlap: mean((t) => t.overlap),
    worstOverlap: Math.max(...trials.map((t) => t.overlap)),
    mirrorDivergence: mean((t) => t.mirrorDivergence),
  };
});
console.log('\nTwin bots on one opponent (identical level, identical start)');
console.log('  Lv   same-tick swings  divergence');
for (const t of twinsByLevel) {
  console.log(
    `  ${t.level}   ${String(t.shared).padStart(3)}/${String(t.total).padEnd(3)} ` +
      `${((t.overlap * 100).toFixed(0) + '%').padStart(9)} (worst ${(t.worstOverlap * 100).toFixed(0)}%)  ` +
      `${t.mirrorDivergence.toFixed(2)} blocks`
  );
}
expect(
  twinsByLevel.every((t) => t.overlap < 0.5),
  `no level fights in lockstep on average (worst ${(Math.max(
    ...twinsByLevel.map((t) => t.overlap)
  ) * 100).toFixed(0)}%)`
);
expect(
  twinsByLevel.every((t) => t.worstOverlap < 0.85),
  `not even the unluckiest pairing is fully in lockstep (worst ${(Math.max(
    ...twinsByLevel.map((t) => t.worstOverlap)
  ) * 100).toFixed(0)}%)`
);
// Only asserted for the levels that circle-strafe. A bot with no strafing walks straight at
// its opponent and stands there, so two of them ending up in the same place is the correct
// behaviour rather than a symptom - and in game they would shove each other apart anyway,
// which this harness does not model.
const strafers = twinsByLevel.filter((t) => LEVELS[t.level - 1].strafe > 0);
expect(
  strafers.every((t) => t.mirrorDivergence > 1.5),
  `strafing levels do not move as mirror images (worst ${Math.min(
    ...strafers.map((t) => t.mirrorDivergence)
  ).toFixed(2)} blocks)`
);

const behaviours = [1, 3, 5].map((l) => behaviourProfile(l));
console.log('\nBehaviour over a 45-second fight (netherite kit, opponent hits back)');
console.log('  Lv   sprint  heading var  shield  blocked  apex   bow   eat  crumbs');
for (const b of behaviours) {
  console.log(
    `  ${b.level}   ${(b.sprintFraction * 100).toFixed(0).padStart(5)}%  ` +
      `${b.headingVariance.toFixed(1).padStart(9)}°  ` +
      `${(b.blockFraction * 100).toFixed(0).padStart(5)}%  ${String(b.blockedHits).padStart(7)}  ` +
      `${b.maxApex.toFixed(2).padStart(4)}  ${String(b.usingBow).padStart(4)}  ` +
      `${String(b.usingItem).padStart(4)}  ${b.crumbs}`
  );
}

expect(
  behaviours.filter((b) => b.level > 1).every((b) => b.sprintFraction > 0.6),
  `sprinting is the default above level 1 (${behaviours.map((b) => (b.sprintFraction * 100).toFixed(0) + '%').join(', ')})`
);
expect(
  behaviours.every((b) => b.headingVariance > 1),
  `no level runs in a dead straight line (${behaviours.map((b) => b.headingVariance.toFixed(1) + '°').join(', ')})`
);
expect(
  behaviours.every((b) => b.maxApex < 1.35),
  `nothing ever jumps higher than a player can (highest ${Math.max(...behaviours.map((b) => b.maxApex)).toFixed(2)} blocks)`
);
expect(
  behaviours.find((b) => b.level === 5).blockFraction > 0.02,
  `a skilled bot actually uses its shield (${(behaviours.find((b) => b.level === 5).blockFraction * 100).toFixed(0)}% of ticks)`
);
expect(
  behaviours.every((b) => b.blockFraction < 0.3),
  `the shield is not parked up (highest ${(Math.max(...behaviours.map((b) => b.blockFraction)) * 100).toFixed(0)}% of ticks)`
);
expect(
  behaviours.find((b) => b.level === 5).blockedHits > 0,
  `blocking actually stops damage (${behaviours.find((b) => b.level === 5).blockedHits} hits blocked)`
);
expect(
  behaviours.find((b) => b.level === 1).blockFraction === 0,
  'a beginner never touches the shield'
);
expect(
  behaviours.every((b) => b.attackedWhileBlocking === 0),
  'no bot swings while its own shield is up'
);
expect(
  behaviours.some((b) => b.usingItem > 0) && behaviours.some((b) => b.crumbs > 0),
  `eating shows the animation state and throws crumbs (${behaviours.map((b) => b.crumbs).join('/')})`
);
expect(
  !dimension.sounds.includes('game.player.hurt'),
  'no script-played hurt sound - the engine already plays one, two was the bug'
);

const doubleApex = doubleJump();
console.log(`\nThree jumps on one tick reach ${doubleApex.toFixed(4)} blocks`);
expect(
  Math.abs(doubleApex - vanillaJumpApex()) < 0.02,
  `jumping repeatedly in one tick still only jumps once (${doubleApex.toFixed(3)} vs ${vanillaJumpApex().toFixed(3)})`
);

const jumpResult = jumpHeight();
const expectedApex = vanillaJumpApex();
console.log(
  `\nJump apex ${jumpResult.apex.toFixed(4)} blocks ` +
    `(vanilla ${expectedApex.toFixed(4)}, grounded residual velocity ${jumpResult.residual.toFixed(4)})`
);
expect(
  Math.abs(jumpResult.apex - expectedApex) < 0.02,
  `jump reaches the vanilla apex (${jumpResult.apex.toFixed(3)} vs ${expectedApex.toFixed(3)} blocks)`
);

const reactions = [1, 2, 3, 4, 5].map((l) => reactionTest(l));
console.log('\nPerception latency: ticks until the bot knows the opponent moved');
console.log('  Lv   mean      spread');
for (const r of reactions) {
  console.log(
    `  ${r.level}   ${r.meanTicks.toFixed(1).padStart(4)}t ${String(Math.round(r.meanMs)).padStart(4)}ms  ` +
      `${String(r.spread).padStart(2)}t`
  );
}
expect(
  reactions.every((r) => r.meanTicks >= 2),
  'no level perceives a change on the tick it happens'
);
expect(
  reactions.every((r, i) => i === 0 || r.meanTicks <= reactions[i - 1].meanTicks * 1.1),
  'perception latency falls monotonically with level'
);
expect(
  reactions[4].meanTicks < reactions[0].meanTicks,
  `reaction time improves with level (${Math.round(reactions[0].meanMs)}ms -> ${Math.round(reactions[4].meanMs)}ms)`
);
expect(
  reactions.every((r) => r.spread > 0),
  'reaction times vary between attempts rather than being a fixed constant'
);
expect(
  reactions[4].meanMs > 80,
  `even the best level is not superhuman (${Math.round(reactions[4].meanMs)}ms)`
);

const life = lifecycle();
console.log('\nEntity lifecycle through the add-on\'s own event handlers');
console.log(
  `  spawned ${life.made}, helmet ${life.helmet ?? 'none'}, ` +
    `stats ${life.hits} hit / ${life.damageDealt} dmg / ${life.botKills} kill, ` +
    `respawn scheduled ${life.scheduled}, bots after respawn ${life.brainsAfterRespawn}, ` +
    `errors ${life.errors.total}`
);
expect(life.made === 2, `spawnBotsNear creates the requested bots (made ${life.made})`);
expect(Boolean(life.helmet), `the spawn path equips armour (helmet ${life.helmet ?? 'none'})`);
expect(life.hits === 1 && life.damageDealt === 5, 'hitting a bot records damage and a hit');
expect(life.botKills === 1, 'killing a bot records a kill');
expect(life.brainsAfterDeath === 1, `the dead bot's brain is dropped (${life.brainsAfterDeath} left)`);
expect(life.blocksLeft === 0, 'blocks placed by the dead bot are cleaned up');
expect(life.scheduled === 1, `a respawn is scheduled, not immediate (${life.scheduled})`);
expect(life.brainsAfterRespawn === 2, `the bot comes back (${life.brainsAfterRespawn} bots)`);
expect(life.remaining === 0, `removeAllBots clears everything (${life.remaining} left)`);
expect(
  life.errors.total === 0,
  `the lifecycle throws nothing internally (${life.errors.total}` +
    (life.errors.total ? ': ' + life.errors.byMessage.map(([m, n]) => `${m} x${n}`).join('; ') : '') +
    ')'
);

const fights = [1, 3, 5].map((level) => ({ level, ...fullFight({ level }) }));
console.log('\nSixty-second fight with a hostile opponent (UHC kit)');
console.log('  Lv   swings  blocks  suppressed errors');
for (const f of fights) {
  console.log(
    `  ${f.level}   ${String(f.swings).padStart(6)}  ${String(f.placed).padStart(6)}  ${f.errors.total}` +
      (f.errors.total ? '  ' + f.errors.byMessage.map(([m, n]) => `${m} (x${n})`).join('; ') : '')
  );
}
expect(
  fights.every((f) => f.errors.total === 0),
  'a full fight throws nothing internally (all levels)'
);
expect(fights.every((f) => f.swings > 0), 'the bot attacks throughout a long fight');

const noComp = noComponentPath();
console.log('\nItem handling without a minecraft:equippable component');
expect(noComp.didPlace, 'blocks are still placed');
expect(noComp.cobbleSpent === 1, `exactly one cobblestone is spent (spent ${noComp.cobbleSpent})`);
expect(noComp.swappedToApple, 'the bot can switch to a golden apple');
expect(noComp.appleShown, 'the apple is visibly placed in the hand');
expect(noComp.ateApple, 'the apple is actually consumed, not just held');
expect(
  noComp.repeatCommands === 0,
  `re-selecting the item already held issues no command (issued ${noComp.repeatCommands})`
);
expect(noComp.applesSpent === 1, `exactly one apple is spent (spent ${noComp.applesSpent})`);
expect(noComp.backToSword, 'the bot switches back to its sword afterwards');
expect(noComp.swordShown, 'the sword is visibly back in the hand');
expect(noComp.commands > 0, 'the /replaceitem fallback was actually exercised');

const rules = placementRules();
console.log('\nBlock placement rules');
expect(!rules.floating, 'a block with nothing adjacent is refused (no mid-air placement)');
expect(rules.supported, 'a block resting against the ground is allowed');
expect(!rules.immediate, 'a second block in the same tick is refused');
expect(!rules.tooSoon, `a second block before the ${PLACE_COOLDOWN}-tick cooldown is refused`);
expect(rules.afterCooldown, 'placement resumes once the cooldown has passed');
expect(rules.looked > 0, 'the bot is pointed at each block it places');

console.log('');
if (failures) {
  console.error(`${failures} simulation check(s) failed.`);
  process.exit(1);
}
console.log('Simulation checks passed.');
