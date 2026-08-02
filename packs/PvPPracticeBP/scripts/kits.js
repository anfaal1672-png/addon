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
    if (stack) equipItem(bot, EquipmentSlot.Mainhand, stack);
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
  return (
    safe(() => {
      const comp = equippable(bot);
      const container = bot.getComponent('minecraft:inventory')?.container;
      const current = comp?.getEquipment(EquipmentSlot.Mainhand);
      if (current?.typeId === typeId) return true;
      if (!container) return false;

      for (let i = 0; i < container.size; i++) {
        const stack = container.getItem(i);
        if (stack?.typeId !== typeId) continue;

        // Swap: what is in hand goes into the slot the new item came from. When the hand is
        // empty `current` is undefined, and writing that into the slot would destroy the
        // item we are about to pick up - so clear the slot only once the swap succeeded.
        if (comp) {
          comp.setEquipment(EquipmentSlot.Mainhand, stack);
        } else {
          bot.runCommand(`replaceitem entity @s slot.weapon.mainhand 0 ${stack.typeId} ${stack.amount}`);
        }
        container.setItem(i, current);
        return true;
      }
      return false;
    }, false) ?? false
  );
}

/**
 * Consumes from the *main hand* rather than the inventory.
 *
 * Eating works on the item you are holding. Draining the inventory instead silently failed
 * whenever the last golden apple was the one in the bot's hand - it ate, got nothing, and
 * kept holding the apple.
 */
export function consumeHeldItem(bot, typeId, amount = 1) {
  return (
    safe(() => {
      const comp = equippable(bot);
      if (!comp) return false;
      const stack = comp.getEquipment(EquipmentSlot.Mainhand);
      if (stack?.typeId !== typeId) return false;

      if (stack.amount <= amount) {
        comp.setEquipment(EquipmentSlot.Mainhand, undefined);
      } else {
        stack.amount -= amount;
        comp.setEquipment(EquipmentSlot.Mainhand, stack);
      }
      return true;
    }, false) ?? false
  );
}

/**
 * Wears down one equipment slot, breaking the item when it runs out.
 *
 * Nothing in the engine applies durability to script-driven combat, so the bot's gear used
 * to last forever - a netherite bot could grind through a hundred fights on one sword while
 * the player it is copying would have watched theirs shatter.
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
      const unbreaking = safe(() => {
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

/** True if the bot is carrying, or already holding, an item of this type. */
export function hasItem(bot, typeId) {
  return (
    safe(() => {
      if (equippable(bot)?.getEquipment(EquipmentSlot.Mainhand)?.typeId === typeId) return true;
      const container = bot.getComponent('minecraft:inventory')?.container;
      if (!container) return false;
      for (let i = 0; i < container.size; i++) {
        if (container.getItem(i)?.typeId === typeId) return true;
      }
      return false;
    }, false) ?? false
  );
}
