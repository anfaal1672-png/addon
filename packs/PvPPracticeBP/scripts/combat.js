/**
 * Survival-accurate melee resolution.
 *
 * The bot's vanilla `minecraft:attack` is set to 0 damage on purpose: every hit it lands
 * goes through this module instead, so the numbers come out of the same table a player's
 * weapon uses (base damage + sharpness + critical multiplier), Bedrock's 10-tick
 * invulnerability window is respected rather than bypassed by script damage, and - like a
 * player - the bot cannot hit anything it does not have a clear line to.
 */

import { EquipmentSlot, system, world } from '@minecraft/server';
import { playSwing } from './anim.js';
import {
  CRIT_MULTIPLIER,
  FIST_DAMAGE,
  IFRAME_TICKS,
  SHARPNESS_PER_LEVEL,
  WEAPON_DAMAGE,
} from './config.js';
import { damageEquipment, getEquipment, getHeldStack } from './kits.js';
import { record } from './diagnostics.js';
import { getSettings } from './state.js';
import { V, chance, safe } from './util.js';

/** entityId -> tick at which it last took damage, so we never bypass i-frames. */
const lastDamaged = new Map();

export function noteDamaged(entityId, tick) {
  lastDamaged.set(entityId, tick);
}

export function ticksSinceDamage(entityId, tick) {
  const last = lastDamaged.get(entityId);
  return last === undefined ? Number.MAX_SAFE_INTEGER : tick - last;
}

export function isInvulnerable(entityId, tick) {
  return ticksSinceDamage(entityId, tick) < IFRAME_TICKS;
}

/** Drops bookkeeping for entities that no longer exist. Cheap to call occasionally. */
export function pruneDamageTable(tick) {
  for (const [id, t] of lastDamaged) {
    if (tick - t > 200) lastDamaged.delete(id);
  }
}

/* ------------------------------------------------------------------ equipment */

export function getHeldItem(entity) {
  return getHeldStack(entity);
}

export function enchantLevel(item, enchantId) {
  if (!item) return 0;
  return (
    safe(() => {
      const comp = item.getComponent('minecraft:enchantable');
      if (!comp) return 0;
      const e = comp.getEnchantment(enchantId);
      return e ? e.level : 0;
    }, 0) ?? 0
  );
}

/* -------------------------------------------------------------------- armour */

/**
 * Bedrock armour point values. These are the numbers the vanilla damage formula uses, and
 * they are the difference between a duel lasting seven seconds and lasting one.
 */
export const ARMOUR_POINTS = {
  'minecraft:leather_helmet': 1,
  'minecraft:leather_chestplate': 3,
  'minecraft:leather_leggings': 2,
  'minecraft:leather_boots': 1,
  'minecraft:golden_helmet': 2,
  'minecraft:golden_chestplate': 5,
  'minecraft:golden_leggings': 3,
  'minecraft:golden_boots': 1,
  'minecraft:chainmail_helmet': 2,
  'minecraft:chainmail_chestplate': 5,
  'minecraft:chainmail_leggings': 4,
  'minecraft:chainmail_boots': 1,
  'minecraft:iron_helmet': 2,
  'minecraft:iron_chestplate': 6,
  'minecraft:iron_leggings': 5,
  'minecraft:iron_boots': 2,
  'minecraft:turtle_helmet': 2,
  'minecraft:diamond_helmet': 3,
  'minecraft:diamond_chestplate': 8,
  'minecraft:diamond_leggings': 6,
  'minecraft:diamond_boots': 3,
  'minecraft:netherite_helmet': 3,
  'minecraft:netherite_chestplate': 8,
  'minecraft:netherite_leggings': 6,
  'minecraft:netherite_boots': 3,
};

const ARMOUR_SLOTS = ['Head', 'Chest', 'Legs', 'Feet'];
const PROTECTIONS = ['protection', 'projectile_protection', 'blast_protection', 'fire_protection'];

/** Armour points and total protection levels currently worn. */
export function armourOf(entity) {
  return (
    safe(() => {
      const eq = entity.getComponent('minecraft:equippable');
      if (!eq) return { points: 0, protection: 0, known: false };
      let points = 0;
      let protection = 0;
      for (const slot of ARMOUR_SLOTS) {
        const item = safe(() => eq.getEquipment(EquipmentSlot[slot]));
        if (!item) continue;
        points += ARMOUR_POINTS[item.typeId] ?? 0;
        // Only generic Protection counts against a sword; the others are situational, and
        // treating them all as equal would make a fire-protection set tank melee.
        protection += enchantLevel(item, PROTECTIONS[0]);
      }
      return { points, protection, known: true };
    }, { points: 0, protection: 0, known: false }) ?? { points: 0, protection: 0, known: false }
  );
}

/**
 * The fraction of raw damage that survives armour, using Bedrock's formula: 4% per armour
 * point and 4% per protection level, each capped at 80%.
 */
export function armourMultiplier(entity) {
  const { points, protection } = armourOf(entity);
  const fromArmour = 1 - Math.min(0.8, points * 0.04);
  const fromEnchant = 1 - Math.min(0.8, protection * 0.04);
  return fromArmour * fromEnchant;
}

/**
 * Whether the engine reduces script damage by the target's armour.
 *
 * The docs do not say, and it decides whether a netherite duel lasts seven seconds or half
 * of one - so rather than guessing, the first hit that lands on an armoured target is
 * measured: the health actually lost is compared against the number that was passed in. One
 * hit settles it, and every hit after that is correct.
 *
 * @type {boolean | undefined}
 */
let engineAppliesArmour;

export function armourCalibration() {
  return engineAppliesArmour;
}

export function resetArmourCalibration(value = undefined) {
  engineAppliesArmour = value;
}

function healthOf(entity) {
  return safe(() => entity.getComponent('minecraft:health')?.currentValue);
}

/**
 * Applies `raw` damage, pre-reducing it by the target's armour when the engine does not.
 * @returns {{dealt: boolean, amount: number}}
 */
export function applyMeleeDamage(attacker, target, raw) {
  const keep = armourMultiplier(target);
  const amount = engineAppliesArmour === false ? raw * keep : raw;

  const before = engineAppliesArmour === undefined ? healthOf(target) : undefined;
  const dealt =
    safe(() => target.applyDamage(amount, { cause: 'entityAttack', damagingEntity: attacker }), false) ?? false;

  // Calibrate only on a hit that carries real information: the target has to be wearing
  // enough armour for the two hypotheses to give visibly different answers, and the health
  // reading has to have actually moved.
  if (dealt && engineAppliesArmour === undefined && keep < 0.75 && before !== undefined) {
    const after = healthOf(target);
    if (after !== undefined) {
      const lost = before - after;
      if (lost > 0.05) {
        const expectedRaw = Math.abs(lost - amount);
        const expectedReduced = Math.abs(lost - amount * keep);
        engineAppliesArmour = expectedReduced < expectedRaw;
        record(
          'combat.armour',
          true,
          engineAppliesArmour
            ? 'the engine reduces script damage by armour - damage is passed raw'
            : 'the engine does not reduce script damage - armour is applied here'
        );
      }
    }
  }

  return { dealt, amount };
}

/* --------------------------------------------------------------- damage maths */

/**
 * Base + sharpness for whatever the entity is holding, exactly like a survival hit.
 * Armour and protection are deliberately *not* applied here - the engine does that
 * when `applyDamage` runs, so a diamond-armoured target really does tank the hit.
 */
export function meleeDamage(item, { critical = false } = {}) {
  const base = item ? (WEAPON_DAMAGE[item.typeId] ?? FIST_DAMAGE) : FIST_DAMAGE;
  const sharp = enchantLevel(item, 'sharpness') * SHARPNESS_PER_LEVEL;
  const raw = base + sharp;
  return critical ? raw * CRIT_MULTIPLIER : raw;
}

/**
 * Bedrock criticals: you must be falling, not on the ground, not climbing, not in water.
 * Sprinting does *not* cancel a crit on Bedrock, which is why sprint-jump-crit is the
 * bread and butter of the format.
 */
export function isCriticalPosition(entity) {
  return safe(() => {
    if (entity.isOnGround) return false;
    if (entity.isInWater) return false;
    if (entity.isClimbing) return false;
    return entity.getVelocity().y < -0.05;
  }, false);
}

/* ---------------------------------------------------------------- line of sight */

/**
 * A player can only hit what they can actually see. Without this the bot happily swings
 * through a wall, which is one of the fastest ways to tell it is not a player.
 *
 * The ray is cast eye-to-eye and again eye-to-feet, because a target standing behind a
 * half-height obstacle is still hittable in the head.
 */
export function hasLineOfSight(attacker, target) {
  const from = safe(() => attacker.getHeadLocation());
  if (!from) return true;
  return lineOfSightFrom(attacker.dimension, from, target);
}

/**
 * The same test from an arbitrary point, so the bot can ask "would I be able to see them if I
 * stood over there?" - which is what turns walking round a wall into walking round it towards
 * somewhere useful.
 */
export function lineOfSightFrom(dimension, from, target) {
  const aims = [];
  safe(() => aims.push(target.getHeadLocation()));
  safe(() => aims.push({ x: target.location.x, y: target.location.y + 0.9, z: target.location.z }));
  safe(() => aims.push({ ...target.location }));
  if (!aims.length) return true;

  for (const aim of aims) {
    const delta = V.sub(aim, from);
    const distance = V.length(delta);
    if (distance < 0.05) return true;

    const blocked = safe(() => {
      const hit = dimension.getBlockFromRay(from, V.normalize(delta), {
        maxDistance: distance,
        includeLiquidBlocks: false,
        includePassableBlocks: false,
      });
      return hit !== undefined;
    }, false);

    if (!blocked) return true;
  }
  return false;
}

/* ------------------------------------------------------------------- knockback */

/**
 * Extra knockback on top of the engine's, for sprint hits and the Knockback enchantment.
 *
 * `sprinting` is passed in rather than read from `entity.isSprinting`, because that property
 * is read-only on Entity - the bot's sprint state only exists in the brain.
 */
export function applyExtraKnockback(target, fromLocation, { sprinting = false, knockbackLevel = 0, wtap = 0 }) {
  const scale = getSettings().knockbackScale;
  let strength = 0;
  if (sprinting) strength += 0.35 + 0.25 * wtap;
  strength += knockbackLevel * 0.5;
  if (strength <= 0) return;

  safe(() => {
    const dir = V.normalizeXZ(V.sub(target.location, fromLocation));
    if (dir.x === 0 && dir.z === 0) return;
    const h = strength * scale;
    applyKnockbackCompat(target, dir.x * h, dir.z * h, 0.18 * scale);
  });
}

/**
 * `applyKnockback` changed shape between @minecraft/server 1.x and 2.x.
 * 2.x: applyKnockback({x, z}, verticalStrength)
 * 1.x: applyKnockback(directionX, directionZ, horizontalStrength, verticalStrength)
 */
export function applyKnockbackCompat(entity, x, z, vertical) {
  try {
    entity.applyKnockback({ x, z }, vertical);
  } catch {
    safe(() => {
      const len = Math.hypot(x, z) || 1;
      entity.applyKnockback(x / len, z / len, len, vertical);
    });
  }
}

/* ------------------------------------------------------------------ the swing */

/**
 * Resolves one melee swing from `attacker` against `target`.
 *
 * The arm animation plays for every swing including misses - a player's arm moves whether
 * or not they connect, and a bot whose arm only moves on a hit reads as fake immediately.
 *
 * @returns {'hit'|'iframe'|'miss'|'blocked'}
 */
export function swing(attacker, target, { tick, missChance = 0, forceNoCrit = false, wtap = 0, sprinting = false, rng }) {
  // Always swing the arm, then work out what the swing hit.
  playSwing(attacker);

  if (isInvulnerable(target.id, tick)) return 'iframe';
  if (!hasLineOfSight(attacker, target)) return 'blocked';
  // Rolled on the attacker's own stream, so two bots swinging at once miss independently.
  if (missChance > 0 && (rng ? rng.chance(missChance) : chance(missChance))) return 'miss';

  const item = getHeldItem(attacker);
  const critical = !forceNoCrit && isCriticalPosition(attacker);
  const amount = meleeDamage(item, { critical });

  const { dealt } = applyMeleeDamage(attacker, target, amount);

  if (!dealt) return 'miss';

  noteDamaged(target.id, tick);
  applyExtraKnockback(target, attacker.location, {
    sprinting,
    knockbackLevel: enchantLevel(item, 'knockback'),
    wtap,
  });

  // Weapons wear out. The engine does not charge durability for script damage.
  damageEquipment(attacker, EquipmentSlot.Mainhand, 1);

  // Fire Aspect: the engine does not apply weapon enchantments to script damage, so a bot
  // swinging a Fire Aspect sword would otherwise never set anything alight.
  const fireAspect = enchantLevel(item, 'fire_aspect');
  if (fireAspect > 0) safe(() => target.setOnFire(fireAspect * 4, true));

  safe(() =>
    attacker.dimension.playSound(critical ? 'game.player.attack.strong' : 'game.player.attack.weak', target.location, {
      volume: 0.9,
    })
  );

  if (critical) {
    safe(() =>
      attacker.dimension.spawnParticle('minecraft:critical_hit_emitter', {
        x: target.location.x,
        y: target.location.y + 1.0,
        z: target.location.z,
      })
    );
  }
  return 'hit';
}

/* --------------------------------------------------------------- event wiring */

/**
 * Mirrors *every* damage event into the i-frame table, so hits dealt by players,
 * fall damage, arrows and so on all correctly block the bot's next swing.
 */
export function installDamageTracking() {
  world.afterEvents.entityHurt.subscribe((ev) => {
    safe(() => noteDamaged(ev.hurtEntity.id, system.currentTick));
  });
}
