// Minimal stub of @minecraft/server, only enough to load the add-on for static checks.
// Events keep their subscribers and can be fired, so tests can exercise the add-on's real
// event wiring (spawn, hurt, death, respawn, clean-up) instead of only its tick loop.
const listeners = () => {
  const subs = new Set();
  return {
    subscribe: (fn) => (subs.add(fn), fn),
    unsubscribe: (fn) => subs.delete(fn),
    dispatch: (ev) => {
      for (const fn of subs) fn(ev);
    },
    get size() {
      return subs.size;
    },
  };
};
export const system = {
  currentTick: 0,
  run: (fn) => fn(),
  runInterval: (fn) => {
    system.intervals.push(fn);
    return system.intervals.length;
  },
  // Timeouts are collected rather than dropped, so respawn scheduling can be inspected.
  runTimeout: (fn, delay) => {
    system.timeouts.push({ fn, delay });
    return system.timeouts.length;
  },
  clearRun: () => {},
  intervals: [],
  timeouts: [],
  /** Fires every pending timeout, as the engine would once the delay elapsed. */
  flushTimeouts() {
    const pending = system.timeouts.splice(0);
    for (const t of pending) t.fn();
    return pending.length;
  },
  beforeEvents: { startup: listeners() },
};
export const world = {
  afterEvents: {
    entityHurt: listeners(),
    entityDie: listeners(),
    entitySpawn: listeners(),
    entityLoad: listeners(),
    playerSpawn: listeners(),
    playerLeave: listeners(),
    itemUse: listeners(),
  },
  beforeEvents: { chatSend: listeners() },
  dimensions: new Map(),
  getDimension: (id) => world.dimensions.get(id) ?? ({
    id: 'overworld',
    getEntities: () => [],
    getBlock: () => undefined,
    getBlockFromRay: () => undefined,
    spawnEntity: () => undefined,
    spawnParticle: () => {},
    playSound: () => {},
  }),
  getAllPlayers: () => [],
  dynamic: new Map(),
  getDynamicProperty: (k) => world.dynamic.get(k),
  setDynamicProperty: (k, v) => {
    if (v === undefined) world.dynamic.delete(k);
    else world.dynamic.set(k, v);
  },
};
export const EquipmentSlot = {
  Head: 'Head', Chest: 'Chest', Legs: 'Legs', Feet: 'Feet', Mainhand: 'Mainhand', Offhand: 'Offhand',
};
export class ItemStack { constructor(t, a = 1) { this.typeId = t; this.amount = a; } getComponent() { return undefined; } }
export const BlockPermutation = { resolve: (id) => ({ id }) };
export const EnchantmentTypes = { get: (id) => id };
export const CustomCommandParamType = { Integer: 'Integer', String: 'String' };
export const CommandPermissionLevel = { Any: 0 };
export const CustomCommandStatus = { Success: 0 };
