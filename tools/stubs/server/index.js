// Minimal stub of @minecraft/server, only enough to load the add-on for static checks.
const listeners = () => ({ subscribe: () => {}, unsubscribe: () => {} });
export const system = {
  currentTick: 0,
  run: (fn) => fn(),
  runInterval: () => 1,
  runTimeout: () => 1,
  clearRun: () => {},
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
  getDimension: () => ({ id: 'overworld', getEntities: () => [], getBlock: () => undefined }),
  getAllPlayers: () => [],
  getDynamicProperty: () => undefined,
  setDynamicProperty: () => {},
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
