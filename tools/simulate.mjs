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
const { ARROW_SPEED, IFRAME_TICKS } = await load('config.js');

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
  getEntities({ location, maxDistance }) {
    return this.entities.filter((e) => {
      if (!e.isValid) return false;
      const d = Math.hypot(e.location.x - location.x, e.location.y - location.y, e.location.z - location.z);
      return d <= maxDistance;
    });
  },
  shots: [],
  spawnEntity(typeId, location) {
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
  spawnParticle(id) {
    if (id === 'minecraft:critical_hit_emitter') this.crits++;
  },
  playSound() {},
};

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

  entity.velocity.y -= 0.08;
  entity.velocity.y *= 0.98;
  entity.location.x += entity.velocity.x;
  entity.location.y += entity.velocity.y;
  entity.location.z += entity.velocity.z;
  if (entity.location.y < GROUND_Y) {
    entity.location.y = GROUND_Y;
    entity.velocity.y = 0;
  }

  const drag = onGround ? 0.546 : 0.91;
  entity.velocity.x *= drag;
  entity.velocity.z *= drag;
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
  };
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

console.log('');
if (failures) {
  console.error(`${failures} simulation check(s) failed.`);
  process.exit(1);
}
console.log('Simulation checks passed.');
