/**
 * Small maths / helper library shared by the whole add-on.
 * Everything here is pure and side-effect free so it is cheap to call every tick.
 */

export const TPS = 20;

/* ------------------------------------------------------------------ random */

let seed = 0x9e3779b9;

/** Deterministic-ish fast RNG. Good enough for combat jitter, cheaper than Math.random. */
export function rand() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 100000) / 100000;
}

export function randRange(min, max) {
  return min + rand() * (max - min);
}

export function randInt(min, max) {
  return Math.floor(randRange(min, max + 1));
}

/** Roughly normal-distributed noise in [-1, 1], used for aim error. */
export function gauss() {
  return (rand() + rand() + rand() - 1.5) / 1.5;
}

export function chance(p) {
  return rand() < p;
}

/**
 * A private random stream.
 *
 * Every bot gets its own, seeded from its entity id. Sharing one global generator made
 * desynchronisation a matter of luck: whether two bots ended up in phase depended on how many
 * numbers everything else in the add-on happened to have drawn first, so the same code could
 * look fine in one fight and produce two puppets moving as one in the next.
 */
export function makeRng(seedText) {
  let s = 2166136261 >>> 0;
  for (let i = 0; i < String(seedText).length; i++) {
    s ^= String(seedText).charCodeAt(i);
    s = Math.imul(s, 16777619) >>> 0;
  }
  if (s === 0) s = 0x9e3779b9;

  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };

  return {
    next,
    chance: (p) => next() < p,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    /** Roughly normal noise in [-1, 1]. */
    gauss: () => (next() + next() + next() - 1.5) / 1.5,
    sign: () => (next() < 0.5 ? 1 : -1),
  };
}

export function pick(list) {
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
}

/* ------------------------------------------------------------------ scalar */

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Shortest signed difference between two angles, in degrees. */
export function angleDelta(from, to) {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** Moves `from` towards `to` by at most `maxStep` degrees. */
export function approachAngle(from, to, maxStep) {
  const d = angleDelta(from, to);
  return from + clamp(d, -maxStep, maxStep);
}

/* ------------------------------------------------------------------ vector */

export const V = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  scale: (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
  dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
  length: (a) => Math.hypot(a.x, a.y, a.z),
  lengthXZ: (a) => Math.hypot(a.x, a.z),
  normalize(a) {
    const l = Math.hypot(a.x, a.y, a.z);
    return l < 1e-6 ? { x: 0, y: 0, z: 0 } : { x: a.x / l, y: a.y / l, z: a.z / l };
  },
  normalizeXZ(a) {
    const l = Math.hypot(a.x, a.z);
    return l < 1e-6 ? { x: 0, z: 0 } : { x: a.x / l, z: a.z / l };
  },
  distance: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
  distanceXZ: (a, b) => Math.hypot(a.x - b.x, a.z - b.z),
  floor: (a) => ({ x: Math.floor(a.x), y: Math.floor(a.y), z: Math.floor(a.z) }),
};

/** Converts a Minecraft yaw/pitch pair (degrees) into a unit direction vector. */
export function rotationToDirection(rot) {
  const yaw = (rot.y * Math.PI) / 180;
  const pitch = (rot.x * Math.PI) / 180;
  const cosPitch = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cosPitch,
    y: -Math.sin(pitch),
    z: Math.cos(yaw) * cosPitch,
  };
}

/** Converts a direction vector into a Minecraft yaw/pitch pair (degrees). */
export function directionToRotation(dir) {
  const n = V.normalize(dir);
  const yaw = (-Math.atan2(n.x, n.z) * 180) / Math.PI;
  const pitch = (-Math.asin(clamp(n.y, -1, 1)) * 180) / Math.PI;
  return { x: pitch, y: yaw };
}

/** Rotates a horizontal vector by `deg` degrees around the Y axis. */
export function rotateXZ(vec, deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: vec.x * c - vec.z * s, z: vec.x * s + vec.z * c };
}

/* ------------------------------------------------------------------ safety */

/** Runs `fn`, swallowing the "entity no longer valid" style errors that are normal in a tick loop. */
export function safe(fn, fallback = undefined) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function isAlive(entity) {
  return safe(() => {
    if (entity === undefined) return false;
    // isValid was a method in @minecraft/server 1.x and became a property in 2.x.
    return typeof entity.isValid === 'function' ? entity.isValid() : entity.isValid === true;
  }, false);
}
