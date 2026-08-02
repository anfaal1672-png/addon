/**
 * Movement layer.
 *
 * The bot's vanilla AI is switched off apart from `behavior.float`, so everything you see
 * it do - walking, sprinting, strafing, jumping, sprint-jumping, stepping up, backing off
 * a ledge - is produced here by rewriting its velocity once per tick. Impulse units are
 * blocks/tick, the same units vanilla uses, which is what lets the bot move at exactly
 * player speed rather than "mob speed".
 */

import { JUMP_POWER, SPRINT_JUMP_BOOST, SPRINT_SPEED, WALK_SPEED } from './config.js';
import { V, clamp, safe } from './util.js';

/**
 * How fast horizontal velocity may change in one tick.
 *
 * Vanilla movement is an acceleration model, not a "set your speed" model. Overwriting the
 * velocity outright every tick is what made the bot stop dead in mid-air the instant it was
 * knocked back - a player cannot do that, and it is the single most obvious tell. So the
 * change is capped: generous on the ground where friction dominates, tiny in the air where
 * a player only has a sliver of control.
 */
export const GROUND_ACCEL = 0.16;
export const AIR_ACCEL = 0.022;

/**
 * Steers the entity's horizontal velocity towards (vx, vz), leaving gravity alone.
 * @param {object} [opts]
 * @param {number} [opts.airControl] 0..1 - how well this bot uses its air time. Bad players
 *   barely influence their trajectory once knocked into the air; good ones air-strafe.
 */
export function driveHorizontal(entity, vx, vz, { airControl = 1 } = {}) {
  safe(() => {
    const v = entity.getVelocity();
    const onGround = entity.isOnGround;
    const limit = onGround ? GROUND_ACCEL : AIR_ACCEL * clamp(0.25 + 0.75 * airControl, 0, 1);

    let dx = vx - v.x;
    let dz = vz - v.z;
    const mag = Math.hypot(dx, dz);
    if (mag > limit) {
      dx = (dx / mag) * limit;
      dz = (dz / mag) * limit;
    }
    entity.applyImpulse({ x: dx, y: 0, z: dz });
  });
}

export function stopHorizontal(entity) {
  driveHorizontal(entity, 0, 0);
}

/**
 * Sets body yaw and head pitch.
 *
 * `setRotation`'s y component is the *body* rotation, not the head - so pointing it at the
 * opponent every tick makes the whole torso snap around, which no player does. The body is
 * therefore aimed along the direction of travel (as vanilla does) and the head is left to
 * the `minecraft:behavior.look_at_player` goal, which tracks the opponent independently.
 */
export function setBodyRotation(entity, yaw, pitch) {
  safe(() => entity.setRotation({ x: clamp(pitch, -89, 89), y: yaw }));
}

export function jump(entity, { sprinting = false, forward } = {}) {
  return (
    safe(() => {
      if (!entity.isOnGround) return false;
      const boost = sprinting && forward ? SPRINT_JUMP_BOOST : 0;
      entity.applyImpulse({
        x: forward ? forward.x * boost : 0,
        y: JUMP_POWER,
        z: forward ? forward.z * boost : 0,
      });
      return true;
    }, false) ?? false
  );
}

export function moveSpeed(sprinting) {
  return sprinting ? SPRINT_SPEED : WALK_SPEED;
}

/* --------------------------------------------------------------- terrain read */

function blockAt(dimension, x, y, z) {
  return safe(() => dimension.getBlock({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }));
}

function isSolid(block) {
  if (!block) return false;
  return safe(() => !block.isAir && !block.isLiquid, false) ?? false;
}

/**
 * Looks one step ahead along `dir` and reports what the bot is about to walk into.
 * @returns {{wall: boolean, step: boolean, gap: number, hazard: boolean}}
 *  - wall   something blocking at head height that a jump will not clear
 *  - step   a one-block rise the bot can hop up
 *  - gap    how far down the floor is ahead (0 = flat, large = a drop or the void)
 *  - hazard lava / fire / a cactus directly ahead
 */
export function probeAhead(entity, dir, distance = 0.9) {
  const dim = entity.dimension;
  const loc = entity.location;
  const ax = loc.x + dir.x * distance;
  const az = loc.z + dir.z * distance;

  const feet = blockAt(dim, ax, loc.y, az);
  const head = blockAt(dim, ax, loc.y + 1, az);
  const above = blockAt(dim, ax, loc.y + 2, az);

  const feetSolid = isSolid(feet);
  const headSolid = isSolid(head);

  let gap = 0;
  if (!feetSolid) {
    for (let d = 1; d <= 5; d++) {
      if (isSolid(blockAt(dim, ax, loc.y - d, az))) break;
      gap = d;
    }
  }

  const hazardIds = new Set([
    'minecraft:lava',
    'minecraft:flowing_lava',
    'minecraft:fire',
    'minecraft:soul_fire',
    'minecraft:cactus',
    'minecraft:magma',
    'minecraft:sweet_berry_bush',
  ]);
  const hazard =
    (safe(() => hazardIds.has(feet?.typeId ?? ''), false) ?? false) ||
    (safe(() => hazardIds.has(blockAt(dim, ax, loc.y - 1, az)?.typeId ?? ''), false) ?? false);

  return {
    wall: feetSolid && headSolid && isSolid(above),
    step: feetSolid && !headSolid,
    gap,
    hazard,
  };
}

/** True when there is nothing under the entity for `depth` blocks - i.e. it is over a hole. */
export function voidBelow(entity, depth = 4) {
  const dim = entity.dimension;
  const loc = entity.location;
  for (let d = 1; d <= depth; d++) {
    if (isSolid(blockAt(dim, loc.x, loc.y - d, loc.z))) return false;
  }
  return true;
}

/* ----------------------------------------------------------------- navigation */

/**
 * Produces the horizontal velocity for one tick of combat movement.
 *
 * @param {object} opts
 * @param {{x:number,z:number}} opts.toTarget  unit vector towards the opponent
 * @param {number} opts.approach   -1 back off, 0 hold the line, 1 close the distance
 * @param {number} opts.strafe     -1 .. 1 sideways component (circle strafing)
 * @param {boolean} opts.sprinting
 * @param {number} opts.speedScale extra multiplier (sneaking, water, damage recovery)
 */
export function combatVelocity({ toTarget, approach, strafe, sprinting, speedScale = 1 }) {
  const side = { x: -toTarget.z, z: toTarget.x };
  const raw = {
    x: toTarget.x * approach + side.x * strafe,
    z: toTarget.z * approach + side.z * strafe,
  };
  const dir = V.normalizeXZ(raw);
  const speed = moveSpeed(sprinting) * clamp(speedScale, 0, 2);
  return { x: dir.x * speed, z: dir.z * speed, dir };
}

/**
 * Applies one tick of movement and deals with the terrain in front of the bot:
 * hops up single blocks, jumps small gaps, and refuses to walk into lava or off a cliff.
 * @returns {{blocked: boolean, gap: number, hazard: boolean, jumped: boolean}}
 */
export function stepWithTerrain(entity, velocity, { sprinting, allowFall = false, airControl = 1 }) {
  const dir = V.normalizeXZ(velocity);
  let jumped = false;
  let blocked = false;

  const probe = dir.x === 0 && dir.z === 0 ? { wall: false, step: false, gap: 0, hazard: false } : probeAhead(entity, dir);

  if (probe.hazard || (!allowFall && probe.gap >= 3)) {
    // Refuse the step: slide sideways instead of walking into lava or off a ledge.
    const side = { x: -dir.z, z: dir.x };
    const speed = moveSpeed(false);
    driveHorizontal(entity, side.x * speed, side.z * speed, { airControl });
    return { blocked: true, gap: probe.gap, hazard: probe.hazard, jumped: false };
  }

  if (probe.step) {
    jumped = jump(entity, { sprinting, forward: dir });
  } else if (probe.gap > 0 && probe.gap < 3) {
    jumped = jump(entity, { sprinting: true, forward: dir });
  } else if (probe.wall) {
    blocked = true;
    // Two blocks tall or more: jumping will not clear it, so go round. Whichever side is
    // open gets picked; without this the bot walks into a wall and stays there, which is
    // what happens the moment an opponent blocks it off.
    const side = { x: -dir.z, z: dir.x };
    const speed = moveSpeed(sprinting);
    const left = probeAhead(entity, side, 1.1);
    const right = probeAhead(entity, { x: -side.x, z: -side.z }, 1.1);
    const open = !left.wall && left.gap < 3 ? side : !right.wall && right.gap < 3 ? { x: -side.x, z: -side.z } : undefined;

    if (open) {
      // Slide along the wall, keeping a little forward lean so it hugs the corner.
      driveHorizontal(entity, (open.x * 0.9 + dir.x * 0.3) * speed, (open.z * 0.9 + dir.z * 0.3) * speed, {
        airControl,
      });
      return { blocked, gap: probe.gap, hazard: probe.hazard, jumped: false, detour: true };
    }
    jumped = jump(entity, { sprinting, forward: dir });
  }

  driveHorizontal(entity, velocity.x, velocity.z, { airControl });
  return { blocked, gap: probe.gap, hazard: probe.hazard, jumped, detour: false };
}
