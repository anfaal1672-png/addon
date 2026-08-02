/**
 * Kit handling - gives a bot a real survival inventory.
 *
 * Bots wear ordinary armour in ordinary armour slots, so protection, projectile
 * protection and durability all behave exactly as they would on a player.
 */

import { EquipmentSlot, ItemStack } from '@minecraft/server';
import * as mc from '@minecraft/server';
import { KITS } from './config.js';
import { safe } from './util.js';

const ARMOUR_SLOTS = [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet];

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

export function clearEquipment(bot) {
  safe(() => {
    const eq = bot.getComponent('minecraft:equippable');
    if (!eq) return;
    for (const slot of [...ARMOUR_SLOTS, EquipmentSlot.Mainhand, EquipmentSlot.Offhand]) {
      eq.setEquipment(slot, undefined);
    }
  });
  safe(() => {
    const container = bot.getComponent('minecraft:inventory')?.container;
    if (container) container.clearAll();
  });
}

/** Applies a named kit to a bot, replacing whatever it was carrying. */
export function applyKit(bot, kitId) {
  const kit = KITS[kitId] ?? KITS.none;
  clearEquipment(bot);

  safe(() => {
    const eq = bot.getComponent('minecraft:equippable');
    if (!eq) return;

    kit.armour.forEach((typeId, i) => {
      const stack = enchant(makeStack(typeId), kit.enchants?.armour);
      if (stack) eq.setEquipment(ARMOUR_SLOTS[i], stack);
    });

    if (kit.mainhand) {
      const stack = enchant(makeStack(kit.mainhand), kit.enchants?.[kit.mainhand]);
      if (stack) eq.setEquipment(EquipmentSlot.Mainhand, stack);
    }
    if (kit.offhand) {
      const stack = makeStack(kit.offhand);
      if (stack) eq.setEquipment(EquipmentSlot.Offhand, stack);
    }
  });

  safe(() => {
    const container = bot.getComponent('minecraft:inventory')?.container;
    if (!container) return;
    for (const entry of kit.inventory ?? []) {
      let left = entry.amount;
      while (left > 0) {
        const take = Math.min(left, 64);
        const stack = makeStack(entry.item, take);
        if (stack) container.addItem(stack);
        left -= take;
      }
    }
  });

  return kit.id;
}

/** Swaps the bot's main hand to `typeId` if it is carrying one - used to switch bow <-> sword. */
export function switchMainhand(bot, typeId) {
  return (
    safe(() => {
      const eq = bot.getComponent('minecraft:equippable');
      const container = bot.getComponent('minecraft:inventory')?.container;
      if (!eq || !container) return false;

      const current = eq.getEquipment(EquipmentSlot.Mainhand);
      if (current?.typeId === typeId) return true;

      for (let i = 0; i < container.size; i++) {
        const stack = container.getItem(i);
        if (stack?.typeId !== typeId) continue;
        container.setItem(i, current);
        eq.setEquipment(EquipmentSlot.Mainhand, stack);
        return true;
      }
      return false;
    }, false) ?? false
  );
}

/** True if the bot is carrying, or already holding, an item of this type. */
export function hasItem(bot, typeId) {
  return (
    safe(() => {
      const eq = bot.getComponent('minecraft:equippable');
      if (eq?.getEquipment(EquipmentSlot.Mainhand)?.typeId === typeId) return true;
      const container = bot.getComponent('minecraft:inventory')?.container;
      if (!container) return false;
      for (let i = 0; i < container.size; i++) {
        if (container.getItem(i)?.typeId === typeId) return true;
      }
      return false;
    }, false) ?? false
  );
}
