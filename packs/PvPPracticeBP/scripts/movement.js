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

    const gain = speedGain(entity.id);
    vx *= gain;
    vz *= gain;

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

/* ------------------------------------------------------- closed-loop speed */

/**
 * Velocity written by script does not become distance travelled at a fixed exchange rate.
 * Where the script tick lands relative to the engine's own movement step decides whether the
 * velocity we set is used for this tick's displacement or is first multiplied by ground
 * friction - and the two answers differ by a factor of nearly two. Setting 0.2806 and hoping
 * is how a bot ends up sprinting at walking pace, which is exactly what it looked like.
 *
 * So the target is not trusted: the distance the bot actually covered is measured every tick
 * and the command is scaled until the two agree. Whatever the engine is doing underneath, the
 * bot ends up moving at real player speed.
 *
 * @type {Map<string, {gain: number, last?: {x:number,z:number}, want: number, tick: number}>}
 */
const speedLoop = new Map();

export const SPEED_GAIN_MIN = 0.8;
export const SPEED_GAIN_MAX = 2.4;

export function speedGain(entityId) {
  return speedLoop.get(entityId)?.gain ?? 1;
}

export function forgetSpeed(entityId) {
  speedLoop.delete(entityId);
}

/**
 * Call once per tick with the speed the bot was *asked* to move at. Compares it against the
 * ground actually covered since the last call and nudges the gain.
 */
export function calibrateSpeed(entity, wantSpeed, tick) {
  safe(() => {
    const id = entity.id;
    let s = speedLoop.get(id);
    if (!s) {
      s = { gain: 1, want: 0, tick: -1 };
      speedLoop.set(id, s);
    }
    const here = { x: entity.location.x, z: entity.location.z };

    // Only a tick that follows directly on from the last one, spent running on the ground at
    // a meaningful speed, says anything about the exchange rate. Knockback, jumps, collisions
    // and stationary ticks are all noise.
    const usable =
      s.last !== undefined &&
      tick === s.tick + 1 &&
      s.want > 0.05 &&
      (safe(() => entity.isOnGround, false) ?? false);

    if (usable) {
      const moved = Math.hypot(here.x - s.last.x, here.z - s.last.z);
      // A tick where the bot was walled in covers no ground for reasons that have nothing to
      // do with the gain, so only believe readings in a plausible band.
      if (moved > s.want * 0.25 && moved < s.want * 2.5) {
        const ratio = s.want / moved;
        // Slew-limited: a jumpy gain would make the bot surge and stall.
        s.gain = clamp(s.gain * clamp(ratio, 0.94, 1.06), SPEED_GAIN_MIN, SPEED_GAIN_MAX);
      }
    }

    s.last = here;
    s.want = wantSpeed;
    s.tick = tick;
  });
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

/** entityId -> tick of that entity's last jump, so nothing can jump twice in one tick. */
const lastJumpTick = new Map();

export function forgetJumps(entityId) {
  lastJumpTick.delete(entityId);
}

/**
 * Jumps with exactly a player's launch velocity, which is what makes the apex land at the
 * vanilla 1.25 blocks.
 *
 * Two things have to be right:
 *
 * `applyImpulse` *adds* to the current velocity, and an entity resting on the ground is not
 * at rest vertically - it still carries the small negative y velocity from the gravity that
 * was applied before the collision stopped it. Adding 0.42 to that produced a jump visibly
 * short of a player's, so the residual is cancelled out first.
 *
 * And only one jump may happen per tick. `getVelocity()` reports the velocity as of the start
 * of the tick, so a second jump in the same tick cannot see the first one's impulse: it
 * cancels a residual that is no longer there and adds a second full launch on top, sending
 * the bot roughly twice as high. Terrain handling, the dodge and the crit set-up can all fire
 * on the same tick, which is exactly how that happened.
 */
export function jump(entity, { sprinting = false, forward, tick } = {}) {
  return (
    safe(() => {
      if (!entity.isOnGround) return false;
      if (tick !== undefined) {
        if (lastJumpTick.get(entity.id) === tick) return false;
        lastJumpTick.set(entity.id, tick);
      }
      const boost = sprinting && forward ? SPRINT_JUMP_BOOST : 0;
      const vy = entity.getVelocity().y;
      entity.applyImpulse({
        x: forward ? forward.x * boost : 0,
        y: JUMP_POWER - vy,
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

const HAZARD_IDS = new Set([
  'minecraft:lava',
  'minecraft:flowing_lava',
  'minecraft:fire',
  'minecraft:soul_fire',
  'minecraft:cactus',
  'minecraft:magma',
  'minecraft:sweet_berry_bush',
]);

/**
 * Looks one step ahead along `dir` and reports what the bot is about to walk into.
 *
 * The important number here is `height`: how many blocks of solid obstacle are stacked in
 * front of the bot. Reporting only "wall or not" - and defining a wall as three solid blocks,
 * which is what this used to do - left the most common obstacle in the game, a two-block
 * pillar, classed as neither a step nor a wall. The bot walked straight into it and kept
 * walking. Anyone who ever placed two blocks in front of it saw exactly that.
 *
 * @returns {{height: number, wall: boolean, step: boolean, gap: number, hazard: boolean}}
 *  - height how many solid blocks are stacked ahead, from foot level up (0 = clear path)
 *  - step   a one-block rise, which a jump clears
 *  - wall   two or more, which it does not
 *  - gap    how far down the floor is ahead (0 = flat, large = a drop or the void)
 *  - hazard lava / fire / a cactus directly ahead
 */
export function probeAhead(entity, dir, distance = 0.9) {
  const dim = entity.dimension;
  const loc = entity.location;
  const ax = loc.x + dir.x * distance;
  const az = loc.z + dir.z * distance;

  const feet = blockAt(dim, ax, loc.y, az);
  const feetSolid = isSolid(feet);

  // Count the stack. Anything past head height plus one cannot be jumped anyway, so three
  // is as far as this needs to look.
  let height = 0;
  if (feetSolid) {
    height = 1;
    for (let d = 1; d <= 2; d++) {
      if (!isSolid(blockAt(dim, ax, loc.y + d, az))) break;
      height = d + 1;
    }
  }

  let gap = 0;
  if (!feetSolid) {
    for (let d = 1; d <= 5; d++) {
      if (isSolid(blockAt(dim, ax, loc.y - d, az))) break;
      gap = d;
    }
  }

  const hazard =
    (safe(() => HAZARD_IDS.has(feet?.typeId ?? ''), false) ?? false) ||
    (safe(() => HAZARD_IDS.has(blockAt(dim, ax, loc.y - 1, az)?.typeId ?? ''), false) ?? false);

  return {
    height,
    // A single block is a hop; the bot also needs headroom to make it, which is what the
    // second test is for - hopping into a one-block hole with a ceiling is not a plan.
    step: height === 1 && !isSolid(blockAt(dim, ax, loc.y + 2, az)),
    wall: height >= 2,
    gap,
    hazard,
  };
}

/**
 * Walkability of one step in `dir`: can the bot travel that way without a wall, a hazard or
 * a fall in the way.
 */
function walkable(entity, dir, distance = 1.1) {
  const p = probeAhead(entity, dir, distance);
  return !p.wall && !p.hazard && p.gap < 3;
}

/**
 * Finds a direction that gets the bot to somewhere it can actually see its opponent from.
 *
 * A wall taller than a jump is not a thing to shuffle sideways against - it is a thing to go
 * round. Candidate headings are fanned out either side of the direct line and scored on
 * whether a step that way is walkable and whether the line to the opponent opens up from
 * there. The result is a bot that peels off around a pillar instead of grinding into it.
 *
 * @param {{x:number,z:number}} toTarget unit vector towards the opponent
 * @returns {{x:number,z:number} | undefined}
 */
export function findOpening(entity, toTarget, { losTest, probeDistance = 1.1, lookAhead = 2.2 } = {}) {
  const angles = [35, -35, 60, -60, 90, -90, 125, -125, 155, -155];
  let best;
  let bestScore = -Infinity;

  for (const deg of angles) {
    const dir = rotateUnit(toTarget, deg);
    if (!walkable(entity, dir, probeDistance)) continue;

    // Prefer headings that keep making progress towards the opponent, and strongly prefer
    // ones that restore the line of sight - that is the whole point of moving.
    let score = -Math.abs(deg) / 180;
    if (losTest) {
      const from = safe(() => entity.location);
      if (from) {
        const spot = { x: from.x + dir.x * lookAhead, y: from.y, z: from.z + dir.z * lookAhead };
        if (safe(() => losTest(spot), false)) score += 2;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = dir;
    }
  }
  return best;
}

function rotateUnit(dir, degrees) {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: dir.x * c - dir.z * s, z: dir.x * s + dir.z * c };
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
export function stepWithTerrain(entity, velocity, { sprinting, allowFall = false, airControl = 1, tick, losTest }) {
  const dir = V.normalizeXZ(velocity);
  let jumped = false;
  let blocked = false;

  const clear = { height: 0, wall: false, step: false, gap: 0, hazard: false };
  const probe = dir.x === 0 && dir.z === 0 ? clear : probeAhead(entity, dir);
  const speed = Math.max(V.lengthXZ(velocity), 1e-4);

  if (probe.hazard || (!allowFall && probe.gap >= 3)) {
    // Refuse the step: slide sideways instead of walking into lava or off a ledge.
    const side = { x: -dir.z, z: dir.x };
    const walk = moveSpeed(false);
    driveHorizontal(entity, side.x * walk, side.z * walk, { airControl });
    return { blocked: true, height: probe.height, gap: probe.gap, hazard: probe.hazard, jumped: false, detour: false };
  }

  if (probe.step) {
    // One block: hop it, now. No roll, no delay - a player does not stop to consider a
    // single block, they are already over it.
    jumped = jump(entity, { sprinting, forward: dir, tick });
  } else if (probe.gap > 0 && probe.gap < 3) {
    jumped = jump(entity, { sprinting: true, forward: dir, tick });
  } else if (probe.wall) {
    blocked = true;
    // Two or more: no jump clears it, so go and stand somewhere the opponent is visible from
    // instead of grinding into the masonry.
    const open = findOpening(entity, dir, { losTest });
    if (open) {
      // A little forward lean so it hugs the corner rather than sliding off at a right angle.
      driveHorizontal(entity, (open.x * 0.92 + dir.x * 0.25) * speed, (open.z * 0.92 + dir.z * 0.25) * speed, {
        airControl,
      });
      return {
        blocked,
        height: probe.height,
        gap: probe.gap,
        hazard: probe.hazard,
        jumped: false,
        detour: true,
        detourDir: open,
      };
    }
    // Boxed in on every heading: a jump is the only thing left to try.
    jumped = jump(entity, { sprinting, forward: dir, tick });
  }

  driveHorizontal(entity, velocity.x, velocity.z, { airControl });
  return { blocked, height: probe.height, gap: probe.gap, hazard: probe.hazard, jumped, detour: false };
}
