/**
 * Block clutching.
 *
 * A bot places blocks out of its own inventory using the same rules a player has:
 * it can only place what it is carrying, only into air, and only within reach. The
 * blocks it puts down are remembered so the arena can be tidied up afterwards.
 */

import { BlockPermutation } from '@minecraft/server';
import { getSettings } from './state.js';
import { V, safe } from './util.js';

const PLACEABLE_PRIORITY = [
  'minecraft:obsidian',
  'minecraft:cobblestone',
  'minecraft:stone',
  'minecraft:dirt',
  'minecraft:oak_planks',
  'minecraft:netherrack',
  'minecraft:end_stone',
];

/** Removes one of `typeId` from the entity's inventory. Returns false if it has none. */
export function consumeItem(entity, typeId, amount = 1) {
  return (
    safe(() => {
      const inv = entity.getComponent('minecraft:inventory');
      const container = inv?.container;
      if (!container) return false;
      let needed = amount;
      for (let i = 0; i < container.size && needed > 0; i++) {
        const stack = container.getItem(i);
        if (!stack || stack.typeId !== typeId) continue;
        const take = Math.min(stack.amount, needed);
        needed -= take;
        if (stack.amount - take <= 0) {
          container.setItem(i, undefined);
        } else {
          stack.amount -= take;
          container.setItem(i, stack);
        }
      }
      return needed === 0;
    }, false) ?? false
  );
}

export function countItem(entity, typeId) {
  return (
    safe(() => {
      const container = entity.getComponent('minecraft:inventory')?.container;
      if (!container) return 0;
      let n = 0;
      for (let i = 0; i < container.size; i++) {
        const stack = container.getItem(i);
        if (stack?.typeId === typeId) n += stack.amount;
      }
      return n;
    }, 0) ?? 0
  );
}

/** The best building block the bot is currently carrying, or undefined. */
export function bestBuildingBlock(entity) {
  for (const id of PLACEABLE_PRIORITY) {
    if (countItem(entity, id) > 0) return id;
  }
  return undefined;
}

/* ------------------------------------------------------------------ placement */

function canPlaceAt(dimension, pos) {
  return (
    safe(() => {
      const block = dimension.getBlock(pos);
      if (!block) return false;
      return block.isAir || block.isLiquid;
    }, false) ?? false
  );
}

/**
 * Places one block, consuming it from the bot's inventory.
 * @returns {boolean} true if a block was actually placed.
 */
export function placeBlock(bot, pos, typeId, tracker) {
  if (!getSettings().allowBuilding) return false;
  const dim = bot.dimension;
  if (!canPlaceAt(dim, pos)) return false;
  if (!consumeItem(bot, typeId, 1)) return false;

  const ok =
    safe(() => {
      dim.getBlock(pos).setPermutation(BlockPermutation.resolve(typeId));
      return true;
    }, false) ?? false;

  if (ok) {
    tracker?.push({ x: pos.x, y: pos.y, z: pos.z, dimensionId: dim.id });
    safe(() => dim.playSound('use.stone', pos, { volume: 0.8 }));
  }
  return ok;
}

/* ------------------------------------------------------------------- clutches */

/**
 * "Block off": drops a wall segment between the bot and its opponent so incoming
 * arrows and sprint hits stop. Used at high skill levels when retreating or healing.
 */
export function blockOff(bot, towardsDir, tracker) {
  const type = bestBuildingBlock(bot);
  if (!type) return false;
  const base = bot.location;
  const fx = Math.floor(base.x + towardsDir.x * 1.4);
  const fz = Math.floor(base.z + towardsDir.z * 1.4);
  const fy = Math.floor(base.y);
  let placed = false;
  for (const dy of [0, 1]) {
    placed = placeBlock(bot, { x: fx, y: fy + dy, z: fz }, type, tracker) || placed;
  }
  return placed;
}

/** Towers straight up one block, jumping and placing underneath - the classic anti-melee escape. */
export function towerUp(bot, tracker) {
  const type = bestBuildingBlock(bot);
  if (!type) return false;
  const loc = bot.location;
  const below = { x: Math.floor(loc.x), y: Math.floor(loc.y) - 1, z: Math.floor(loc.z) };
  const v = safe(() => bot.getVelocity(), { x: 0, y: 0, z: 0 });
  // Place only at the top of the jump arc, exactly like a player timing a tower.
  if (v.y > 0.02 || v.y < -0.25) return false;
  return placeBlock(bot, { x: below.x, y: Math.floor(loc.y), z: below.z }, type, tracker);
}

/** Bridges one block forward so the bot can cross a gap instead of falling in. */
export function bridgeForward(bot, dir, tracker) {
  const type = bestBuildingBlock(bot);
  if (!type) return false;
  const loc = bot.location;
  const pos = {
    x: Math.floor(loc.x + dir.x * 1.0),
    y: Math.floor(loc.y) - 1,
    z: Math.floor(loc.z + dir.z * 1.0),
  };
  return placeBlock(bot, pos, type, tracker);
}

/**
 * MLG water bucket: when falling far enough to die, drop water on the landing spot and
 * pick it straight back up. Requires a water bucket in the inventory.
 */
export function mlgWater(bot, tracker) {
  if (countItem(bot, 'minecraft:water_bucket') <= 0) return false;
  const loc = bot.location;
  const v = safe(() => bot.getVelocity(), { x: 0, y: 0, z: 0 });
  if (v.y > -0.6) return false;

  const dim = bot.dimension;
  // Find the floor we are about to hit.
  let groundY;
  for (let d = 1; d <= 8; d++) {
    const b = safe(() => dim.getBlock({ x: Math.floor(loc.x), y: Math.floor(loc.y) - d, z: Math.floor(loc.z) }));
    if (b && !b.isAir && !b.isLiquid) {
      groundY = Math.floor(loc.y) - d + 1;
      break;
    }
  }
  if (groundY === undefined) return false;
  if (loc.y - groundY > 4) return false; // still too high, wait for the right moment

  const pos = { x: Math.floor(loc.x), y: groundY, z: Math.floor(loc.z) };
  if (!canPlaceAt(dim, pos)) return false;
  if (!consumeItem(bot, 'minecraft:water_bucket', 1)) return false;

  safe(() => dim.getBlock(pos).setPermutation(BlockPermutation.resolve('minecraft:water')));
  tracker?.push({ ...pos, dimensionId: dim.id, water: true });
  safe(() => dim.playSound('bucket.empty_water', pos));
  return true;
}

/* -------------------------------------------------------------------- cleanup */

/** Removes every block a bot placed. Called when the bot dies or is deleted. */
export function cleanupBlocks(dimensionLookup, tracker) {
  if (!tracker || !getSettings().cleanupBlocks) return;
  for (const rec of tracker) {
    safe(() => {
      const dim = dimensionLookup(rec.dimensionId);
      const block = dim?.getBlock({ x: rec.x, y: rec.y, z: rec.z });
      if (!block || block.isAir) return;
      block.setPermutation(BlockPermutation.resolve('minecraft:air'));
    });
  }
  tracker.length = 0;
}
