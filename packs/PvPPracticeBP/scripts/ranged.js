/**
 * Ranged combat: drawing a bow, leading a moving target, and reading incoming arrows.
 *
 * Arrows are real `minecraft:arrow` entities owned by the bot, so the engine applies
 * the normal projectile damage curve, armour reduction and Projectile Protection.
 */

import { ARROW_GRAVITY, ARROW_SPEED } from './config.js';
import { consumeItem, countItem } from './blocks.js';
import { V, clamp, gauss, safe } from './util.js';

/**
 * Solves the launch direction for a target that keeps moving.
 *
 * `skill` (0..1) controls how much of the physics the bot actually accounts for:
 * a level 1 bot fires flat and straight at where you stand right now, a level 5 bot
 * leads your velocity and compensates gravity, so it hits you mid-strafe at 30 blocks.
 */
export function solveArrow(from, target, targetVelocity, skill) {
  const aimAt = { x: target.x, y: target.y + 1.4, z: target.z };
  let delta = V.sub(aimAt, from);
  let flightTicks = V.length(delta) / ARROW_SPEED;

  // Two refinement passes are plenty for the distances Minecraft PvP happens at.
  for (let i = 0; i < 2; i++) {
    const lead = V.scale(targetVelocity, flightTicks * skill);
    delta = V.sub(V.add(aimAt, lead), from);
    flightTicks = V.length(delta) / ARROW_SPEED;
  }

  // Gravity compensation: raise the shot by half a-t^2, scaled by skill.
  const drop = 0.5 * ARROW_GRAVITY * flightTicks * flightTicks;
  delta = { x: delta.x, y: delta.y + drop * skill, z: delta.z };

  return { direction: V.normalize(delta), flightTicks };
}

/** How long the bot should hold the draw before releasing, in ticks. */
export function drawTime(skill) {
  // A full-power shot needs 20 ticks. Weak players release early and lose damage.
  return Math.round(20 * (0.55 + 0.45 * skill));
}

/**
 * Fires one arrow. Returns false when the bot is out of ammunition.
 * `chargeTicks` scales both speed and damage, exactly like an under-drawn bow.
 */
export function shootArrow(bot, target, targetVelocity, { skill, chargeTicks = 20, spreadDegrees = 0 }) {
  if (countItem(bot, 'minecraft:arrow') <= 0) return false;

  const from = safe(() => bot.getHeadLocation()) ?? bot.location;
  const { direction } = solveArrow(from, target.location, targetVelocity, skill);

  // Aim error: a cone whose width shrinks as skill rises.
  const spread = spreadDegrees * (1 - skill);
  const jittered = V.normalize({
    x: direction.x + (gauss() * spread) / 90,
    y: direction.y + (gauss() * spread) / 180,
    z: direction.z + (gauss() * spread) / 90,
  });

  const power = clamp(chargeTicks / 20, 0.15, 1);
  const speed = ARROW_SPEED * power;

  const spawnAt = V.add(from, V.scale(jittered, 0.8));
  const arrow = safe(() => bot.dimension.spawnEntity('minecraft:arrow', spawnAt));
  if (!arrow) return false;

  const ok =
    safe(() => {
      const proj = arrow.getComponent('minecraft:projectile');
      if (!proj) return false;
      proj.owner = bot;
      proj.shoot(V.scale(jittered, speed), { uncertainty: 0 });
      return true;
    }, false) ?? false;

  if (!ok) {
    // Older builds without a usable projectile component: fall back to a raw impulse.
    safe(() => arrow.applyImpulse(V.scale(jittered, speed)));
  }

  consumeItem(bot, 'minecraft:arrow', 1);
  safe(() => bot.dimension.playSound('random.bow', bot.location, { volume: 1, pitch: 1 }));
  return true;
}

/* ----------------------------------------------------------------- dodging */

const PROJECTILES = new Set([
  'minecraft:arrow',
  'minecraft:trident',
  'minecraft:snowball',
  'minecraft:egg',
  'minecraft:fireball',
  'minecraft:small_fireball',
  'minecraft:splash_potion',
  'minecraft:lingering_potion',
  'minecraft:dragon_fireball',
  'minecraft:wither_skull',
]);

/**
 * Finds the most threatening projectile heading at the bot within `radius`.
 * Returns the sideways unit vector the bot should strafe along to get out of the way.
 */
export function incomingThreat(bot, radius = 12) {
  return safe(() => {
    const loc = bot.location;
    const nearby = bot.dimension.getEntities({ location: loc, maxDistance: radius });
    let best;
    let bestScore = 0;

    for (const e of nearby) {
      if (!PROJECTILES.has(e.typeId)) continue;
      const vel = e.getVelocity();
      const speed = V.length(vel);
      if (speed < 0.15) continue;

      const toBot = V.sub(loc, e.location);
      const dist = V.length(toBot);
      if (dist < 0.5) continue;

      // How directly is it pointed at us? 1 = dead on.
      const aim = V.dot(V.normalize(vel), V.normalize(toBot));
      if (aim < 0.9) continue;

      const score = aim * (1 - dist / radius);
      if (score > bestScore) {
        bestScore = score;
        const flat = V.normalizeXZ(vel);
        best = { entity: e, dodge: { x: -flat.z, z: flat.x }, ticks: dist / Math.max(speed, 0.01) };
      }
    }
    return best;
  });
}
