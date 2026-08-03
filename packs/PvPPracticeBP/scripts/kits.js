/**
 * Kit handling - gives a bot a real survival inventory.
 *
 * Getting armour onto a custom mob is the one part of this add-on that cannot be done by
 * reading the docs alone, because `minecraft:equippable` is *not* the armour component
 * (it is the llama-carpet / horse-saddle interaction component, and vanilla humanoid mobs
 * do not have it at all). So this module tries the script component first, verifies the
 * item actually stuck by reading it back, and falls back to /replaceitem when it did not.
 * Whichever path worked is recorded in diagnostics.js and printed by `!pvp diag`.
 */

import { EquipmentSlot, ItemStack } from '@minecraft/server';
import * as mc from '@minecraft/server';
import { KITS } from './config.js';
import { record } from './diagnostics.js';
import { safe } from './util.js';

const ARMOUR_SLOTS = [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet];

/** Script EquipmentSlot -> the slot name /replaceitem uses. */
const COMMAND_SLOT = {
  [EquipmentSlot.Head]: 'slot.armor.head',
  [EquipmentSlot.Chest]: 'slot.armor.chest',
  [EquipmentSlot.Legs]: 'slot.armor.legs',
  [EquipmentSlot.Feet]: 'slot.armor.feet',
  [EquipmentSlot.Mainhand]: 'slot.weapon.mainhand',
  [EquipmentSlot.Offhand]: 'slot.weapon.offhand',
};

function equippable(entity) {
  return safe(() => entity.getComponent('minecraft:equippable'));
}

function inventoryOf(entity) {
  return safe(() => entity.getComponent('minecraft:inventory')?.container);
}

/**
 * What the bot is "holding" on builds with no equippable component.
 *
 * On that path the main hand cannot be read back, so the item is *left in the inventory* and
 * only mirrored into the display slot with /replaceitem. Moving it out of the container - as
 * this used to - meant the item existed nowhere the code could find it again: placement and
 * eating both silently failed, and the stack it came from was destroyed.
 *
 * @type {Map<string, string>} entityId -> typeId
 */
const virtualHand = new Map();

export function forgetHand(entityId) {
  virtualHand.delete(entityId);
}

export function noteHand(bot, typeId) {
  virtualHand.set(bot.id, typeId);
}

/** Removes `amount` of `typeId` from the entity's inventory. False if it does not have them. */
export function consumeItem(entity, typeId, amount = 1) {
  return (
    safe(() => {
      const container = inventoryOf(entity);
      if (!container) return false;
      if (countItem(entity, typeId) < amount) return false;

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
      const container = inventoryOf(entity);
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

function findInContainer(entity, typeId) {
  return safe(() => {
    const container = inventoryOf(entity);
    if (!container) return undefined;
    for (let i = 0; i < container.size; i++) {
      const stack = container.getItem(i);
      if (stack?.typeId === typeId) return stack;
    }
    return undefined;
  });
}

/**
 * The item stack the bot is holding, whichever mechanism is in play. Combat reads this for
 * weapon damage and enchantments, so it has to work on the command path too - otherwise a
 * bot visibly holding a netherite sword punches for 1.
 */
export function getHeldStack(bot) {
  const real = safe(() => equippable(bot)?.getEquipment(EquipmentSlot.Mainhand));
  if (real) return real;
  const virtual = virtualHand.get(bot.id);
  return virtual ? findInContainer(bot, virtual) : undefined;
}

function enchant(stack, list) {
  if (!stack || !list?.length) return stack;
  safe(() => {
    const comp = stack.getComponent('minecraft:enchantable');
    if (!comp) return;
    for (const e of list) {
      try {
        comp.addEnchantment({ type: e.id, level: e.level });
      } catch {
        safe(() => comp.addEnchantment({ type: mc.EnchantmentTypes?.get?.(e.id), level: e.level }));
      }
    }
  });
  return stack;
}

function makeStack(typeId, amount = 1) {
  return safe(() => new ItemStack(typeId, amount));
}

/**
 * Puts one item into one equipment slot and *verifies* it landed there.
 * @returns {'component'|'command'|'failed'}
 */
export function equipItem(entity, slot, stack) {
  const comp = equippable(entity);

  if (comp) {
    const applied =
      safe(() => {
        comp.setEquipment(slot, stack);
        return comp.getEquipment(slot)?.typeId === stack?.typeId;
      }, false) ?? false;
    if (applied) {
      record('equip.component', true, 'setEquipment works (enchantments supported)');
      return 'component';
    }
  } else {
    record('equip.component', false, 'entity has no minecraft:equippable component');
  }

  // Fallback: the command works on any mob that has real equipment slots, but it cannot
  // carry enchantments, so kits lose their Protection/Sharpness on this path.
  const slotName = COMMAND_SLOT[slot];
  if (slotName && stack) {
    const ok =
      safe(() => {
        entity.runCommand(`replaceitem entity @s ${slotName} 0 ${stack.typeId} ${stack.amount}`);
        return equippable(entity)?.getEquipment(slot)?.typeId === stack.typeId;
      }, false) ?? false;
    // The read-back needs the component; if there is none we cannot verify, so trust the
    // command not throwing.
    const ran = ok || (safe(() => {
      entity.runCommand(`replaceitem entity @s ${slotName} 0 ${stack.typeId} ${stack.amount}`);
      return true;
    }, false) ?? false);
    if (ran) {
      record('equip.command', true, '/replaceitem works (no enchantments on this path)');
      return 'command';
    }
  }

  record('equip.failed', false, `could not equip ${stack?.typeId ?? 'nothing'} into ${String(slot)}`);
  return 'failed';
}

export function getEquipment(entity, slot) {
  return safe(() => equippable(entity)?.getEquipment(slot));
}

export function clearEquipment(bot) {
  const comp = equippable(bot);
  for (const slot of [...ARMOUR_SLOTS, EquipmentSlot.Mainhand, EquipmentSlot.Offhand]) {
    if (comp) safe(() => comp.setEquipment(slot, undefined));
    else safe(() => bot.runCommand(`replaceitem entity @s ${COMMAND_SLOT[slot]} 0 air`));
  }
  safe(() => {
    const container = bot.getComponent('minecraft:inventory')?.container;
    if (container) container.clearAll();
  });
}

/** Applies a named kit to a bot, replacing whatever it was carrying. */
export function applyKit(bot, kitId) {
  const kit = KITS[kitId] ?? KITS.none;
  clearEquipment(bot);

  kit.armour.forEach((typeId, i) => {
    const stack = enchant(makeStack(typeId), kit.enchants?.armour);
    if (stack) equipItem(bot, ARMOUR_SLOTS[i], stack);
  });

  if (kit.mainhand) {
    const stack = enchant(makeStack(kit.mainhand), kit.enchants?.[kit.mainhand]);
    if (stack) {
      const path = equipItem(bot, EquipmentSlot.Mainhand, stack);
      if (path !== 'component') {
        // On the command path the hand cannot be read back, so a weapon that only exists in
        // the display slot is invisible to the code: once the bot swapped to a block or an
        // apple it could never find its sword again. Keep a copy in the inventory and record
        // that this is what it is holding.
        const spare = enchant(makeStack(kit.mainhand), kit.enchants?.[kit.mainhand]);
        if (spare) safe(() => inventoryOf(bot)?.addItem(spare));
        noteHand(bot, kit.mainhand);
      }
    }
  }
  if (kit.offhand) {
    const stack = makeStack(kit.offhand);
    if (stack) equipItem(bot, EquipmentSlot.Offhand, stack);
  }

  const container = safe(() => bot.getComponent('minecraft:inventory')?.container);
  record('inventory.component', Boolean(container), container ? 'container available' : 'no inventory container');
  if (container) {
    for (const entry of kit.inventory ?? []) {
      let left = entry.amount;
      while (left > 0) {
        const take = Math.min(left, 64);
        const stack = makeStack(entry.item, take);
        if (stack) safe(() => container.addItem(stack));
        left -= take;
      }
    }
  }

  return kit.id;
}

/** Swaps the bot's main hand to `typeId` if it is carrying one - used to switch bow <-> sword. */
export function switchMainhand(bot, typeId) {
  if (!typeId) return false;

  const comp = equippable(bot);
  const container = inventoryOf(bot);

  if (comp) {
    return (
      safe(() => {
        const current = comp.getEquipment(EquipmentSlot.Mainhand);
        if (current?.typeId === typeId) return true;
        if (!container) return false;

        for (let i = 0; i < container.size; i++) {
          const stack = container.getItem(i);
          if (stack?.typeId !== typeId) continue;
          // Swap: the new item goes to the hand, the old one takes its slot. Order matters -
          // writing the (possibly undefined) old item first would wipe the slot being read.
          comp.setEquipment(EquipmentSlot.Mainhand, stack);
          container.setItem(i, current);
          virtualHand.set(bot.id, typeId);
          return true;
        }
        return false;
      }, false) ?? false
    );
  }

  // Command path: mirror into the display slot only. The item stays in the inventory, which
  // is the only place this path can find or spend it later.
  //
  // Already holding it is a no-op. meleeRoutine re-selects the weapon every tick, so without
  // this the bot would fire twenty /replaceitem commands a second, each one rebuilding the
  // item from scratch.
  if (virtualHand.get(bot.id) === typeId) return true;
  if (countItem(bot, typeId) <= 0) return false;
  const shown =
    safe(() => {
      bot.runCommand(`replaceitem entity @s slot.weapon.mainhand 0 ${typeId} 1`);
      return true;
    }, false) ?? false;
  if (shown) virtualHand.set(bot.id, typeId);
  return shown;
}

/**
 * Consumes from the hand.
 *
 * Eating and placing both spend the item you are holding. On the component path that is the
 * main-hand stack; on the command path the item never left the inventory, so it is spent from
 * there and the display slot is refreshed.
 */
export function consumeHeldItem(bot, typeId, amount = 1) {
  const comp = equippable(bot);

  if (comp) {
    return (
      safe(() => {
        const stack = comp.getEquipment(EquipmentSlot.Mainhand);
        if (stack?.typeId !== typeId) return false;

        if (stack.amount <= amount) {
          comp.setEquipment(EquipmentSlot.Mainhand, undefined);
          virtualHand.delete(bot.id);
        } else {
          stack.amount -= amount;
          comp.setEquipment(EquipmentSlot.Mainhand, stack);
        }
        return true;
      }, false) ?? false
    );
  }

  if (virtualHand.get(bot.id) !== typeId) return false;
  if (!consumeItem(bot, typeId, amount)) return false;

  if (countItem(bot, typeId) <= 0) {
    virtualHand.delete(bot.id);
    safe(() => bot.runCommand('replaceitem entity @s slot.weapon.mainhand 0 air'));
  }
  return true;
}

/**
 * Wears down one equipment slot, breaking the item when it runs out.
 *
 * Nothing in the engine applies durability to script-driven combat, so the bot's gear would
 * otherwise last forever, while the player it is copying watches theirs shatter. Only
 * available on the component path - the command path cannot read an item back to damage it.
 */
export function damageEquipment(bot, slot, amount = 1) {
  return (
    safe(() => {
      const comp = equippable(bot);
      const stack = comp?.getEquipment(slot);
      if (!stack) return false;

      const durability = stack.getComponent('minecraft:durability');
      if (!durability) return false;

      // Unbreaking: each level gives a chance to skip the wear entirely.
      let applied = 0;
      const unbreaking =
        safe(() => {
          const e = stack.getComponent('minecraft:enchantable')?.getEnchantment('unbreaking');
          return e ? e.level : 0;
        }, 0) ?? 0;
      for (let i = 0; i < amount; i++) {
        if (unbreaking > 0 && Math.random() < unbreaking / (unbreaking + 1)) continue;
        applied++;
      }
      if (applied === 0) return false;

      const next = durability.damage + applied;
      if (next >= durability.maxDurability) {
        comp.setEquipment(slot, undefined);
        safe(() => bot.dimension.playSound('random.break', bot.location, { volume: 0.8 }));
        return true;
      }
      durability.damage = next;
      comp.setEquipment(slot, stack);
      return true;
    }, false) ?? false
  );
}

export const ARMOUR_EQUIPMENT_SLOTS = ARMOUR_SLOTS;

/**
 * True if the item is in either hand or in the bag.
 *
 * `hasItem` only looks at the main hand and the inventory, which misses the off hand - and
 * the shield lives in the off hand, so the bot could never tell it had one.
 */
export function heldOrCarried(bot, typeId) {
  if (getHeldStack(bot)?.typeId === typeId) return true;
  if (safe(() => equippable(bot)?.getEquipment(EquipmentSlot.Offhand)?.typeId) === typeId) return true;
  return countItem(bot, typeId) > 0;
}

/** True if the bot is carrying, or already holding, an item of this type. */
export function hasItem(bot, typeId) {
  if (getHeldStack(bot)?.typeId === typeId) return true;
  return countItem(bot, typeId) > 0;
}
