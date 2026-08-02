/**
 * Two ways to drive the add-on without opening a menu:
 *  - chat commands (`!pvp ...`), which work on every build that has script support
 *  - real slash commands (`/pvp:spawn ...`), registered when the runtime offers the
 *    custom command registry. Registration is optional and failing is not fatal.
 */

import { EquipmentSlot, ItemStack, system, world } from '@minecraft/server';
import * as mc from '@minecraft/server';
import { KITS, KIT_ORDER } from './config.js';
import * as diagnostics from './diagnostics.js';
import { getEquipment } from './kits.js';
import { t } from './lang.js';
import {
  nearestBrain,
  removeAllBots,
  setBrainKit,
  setBrainLevel,
  spawnBotsNear,
} from './manager.js';
import { openHelp, openMenu, openStats, requireNearestBrain } from './ui.js';
import { clamp, safe } from './util.js';

const PREFIX = '!pvp';

/* ------------------------------------------------------------------ actions */

function cmdSpawn(player, args) {
  const level = clamp(parseInt(args[0] ?? '3', 10) || 3, 1, 5);
  const kitArg = (args[1] ?? 'sword').toLowerCase();
  const kit = KITS[kitArg] ? kitArg : undefined;
  if (args[1] && !kit) {
    player.sendMessage(t('cmd.unknownKit', args[1]));
    return;
  }
  const count = clamp(parseInt(args[2] ?? '1', 10) || 1, 1, 10);
  const made = spawnBotsNear(player, { level, kit: kit ?? 'sword', count, distance: 6 });
  player.sendMessage(made > 0 ? t('spawn.done', level, made) : t('spawn.full', made));
}

function cmdLevel(player, args) {
  const level = parseInt(args[0] ?? '', 10);
  if (!(level >= 1 && level <= 5)) {
    player.sendMessage(t('cmd.needLevel'));
    return;
  }
  const brain = requireNearestBrain(player);
  if (!brain) return;
  setBrainLevel(brain, level);
  player.sendMessage(t('cmd.levelSet', level));
}

function cmdKit(player, args) {
  const kit = (args[0] ?? '').toLowerCase();
  if (!KITS[kit]) {
    player.sendMessage(t('cmd.unknownKit', args[0] ?? '?') + ' §7(' + KIT_ORDER.join(', ') + ')');
    return;
  }
  const brain = requireNearestBrain(player);
  if (!brain) return;
  setBrainKit(brain, kit);
  player.sendMessage(t('cmd.kitSet', t('kit.' + kit)));
}

/**
 * Prints what actually works on this build.
 *
 * Symptoms like "the bot has no armour" have several possible causes and the add-on cannot
 * tell which one it hit from the outside. So it probes live and reports: which equipment
 * path succeeded, whether the animation properties exist, whether the swing/eat bridge is
 * being driven, and what the nearest bot is currently wearing and holding.
 */
function cmdDiag(player) {
  const lines = ['§l=== PvP Practice diagnostics ===§r', diagnostics.report()];

  const brain = nearestBrain(player, 32);
  if (!brain) {
    lines.push('§7No bot within 32 blocks - summon one and run this again for live checks.');
    player.sendMessage(lines.join('\n'));
    return;
  }

  const bot = brain.entity;
  const slots = [
    ['head', EquipmentSlot.Head],
    ['chest', EquipmentSlot.Chest],
    ['legs', EquipmentSlot.Legs],
    ['feet', EquipmentSlot.Feet],
    ['mainhand', EquipmentSlot.Mainhand],
    ['offhand', EquipmentSlot.Offhand],
  ];

  lines.push(`§eNearest bot§r Lv${brain.level} kit=${brain.kit}`);
  for (const [name, slot] of slots) {
    const item = getEquipment(bot, slot);
    lines.push(`  ${item ? '§a' : '§8'}${name}§r ${item ? item.typeId : '(empty)'}`);
  }

  const swingId = safe(() => bot.getProperty('pvp:swing_id'));
  const using = safe(() => bot.getProperty('pvp:using'));
  lines.push(
    `§eanimation properties§r swing_id=${swingId ?? '§cundefined§r'} using=${using ?? '§cundefined§r'}`
  );

  const container = safe(() => bot.getComponent('minecraft:inventory')?.container);
  let stacks = 0;
  if (container) {
    for (let i = 0; i < container.size; i++) if (container.getItem(i)) stacks++;
  }
  lines.push(`§einventory§r ${container ? `${stacks} stacks` : '§cno container§r'}`);
  lines.push(`§estate§r sprint=${brain.sprinting} bodyYaw=${Math.round(brain.bodyYaw)} aimYaw=${Math.round(brain.aimYaw ?? 0)}`);

  player.sendMessage(lines.join('\n'));
}

export function giveRemote(player) {
  const ok =
    safe(() => {
      const inv = player.getComponent('minecraft:inventory')?.container;
      if (!inv) return false;
      inv.addItem(new ItemStack('pvp:remote', 1));
      return true;
    }, false) ?? false;
  if (ok) player.sendMessage(t('cmd.gotRemote'));
  return ok;
}

function dispatch(player, argv) {
  const sub = (argv[0] ?? 'menu').toLowerCase();
  const rest = argv.slice(1);

  switch (sub) {
    case 'menu':
    case '':
      return openMenu(player);
    case 'spawn':
    case 'summon':
      return cmdSpawn(player, rest);
    case 'clear':
    case 'remove':
      return player.sendMessage(t('cmd.cleared', removeAllBots()));
    case 'level':
    case 'lv':
      return cmdLevel(player, rest);
    case 'kit':
      return cmdKit(player, rest);
    case 'stats':
      return openStats(player);
    case 'remote':
      return giveRemote(player);
    case 'diag':
    case 'debug':
      return cmdDiag(player);
    case 'help':
      return openHelp(player);
    default:
      return player.sendMessage(t('cmd.unknown'));
  }
}

/* ------------------------------------------------------------ chat commands */

export function installChatCommands() {
  const chat = world.beforeEvents?.chatSend;
  if (!chat) return false;

  chat.subscribe((ev) => {
    const message = ev.message.trim();
    if (!message.toLowerCase().startsWith(PREFIX)) return;
    ev.cancel = true;

    const argv = message.slice(PREFIX.length).trim().split(/\s+/).filter(Boolean);
    const player = ev.sender;
    system.run(() => safe(() => dispatch(player, argv)));
  });
  return true;
}

/* ---------------------------------------------------------- slash commands */

/**
 * Registers `/pvp:spawn`, `/pvp:clear`, `/pvp:level`, `/pvp:menu`.
 * Only available on runtimes that expose the custom command registry; older ones
 * simply keep the `!pvp` chat commands.
 */
export function installSlashCommands() {
  const startup = mc.system?.beforeEvents?.startup;
  if (!startup) return false;

  try {
    startup.subscribe((init) => {
      const registry = init.customCommandRegistry;
      if (!registry) return;

      const ParamType = mc.CustomCommandParamType ?? {};
      const Permission = mc.CommandPermissionLevel ?? {};
      const Status = mc.CustomCommandStatus ?? {};
      const anyPlayer = Permission.Any ?? 0;

      const reply = (message) => ({ status: Status.Success ?? 0, message });

      registry.registerCommand(
        {
          name: 'pvp:spawn',
          description: 'Summon PvP practice bots',
          permissionLevel: anyPlayer,
          mandatoryParameters: [{ type: ParamType.Integer, name: 'level' }],
          optionalParameters: [
            { type: ParamType.String, name: 'kit' },
            { type: ParamType.Integer, name: 'count' },
          ],
        },
        (origin, level, kit, count) => {
          const player = origin.sourceEntity;
          if (!player || player.typeId !== 'minecraft:player') return reply('Run this as a player.');
          system.run(() => cmdSpawn(player, [String(level), kit ?? 'sword', String(count ?? 1)]));
          return reply('ok');
        }
      );

      registry.registerCommand(
        {
          // Deliberately not "pvp:clear": the game reserves the bare alias `clear` for
          // vanilla /clear and logs a conflict warning if we try to claim it.
          name: 'pvp:clearbots',
          description: 'Remove every PvP practice bot',
          permissionLevel: anyPlayer,
        },
        () => {
          system.run(() => removeAllBots());
          return reply('ok');
        }
      );

      registry.registerCommand(
        {
          name: 'pvp:level',
          description: 'Change the nearest bot level',
          permissionLevel: anyPlayer,
          mandatoryParameters: [{ type: ParamType.Integer, name: 'level' }],
        },
        (origin, level) => {
          const player = origin.sourceEntity;
          if (!player || player.typeId !== 'minecraft:player') return reply('Run this as a player.');
          system.run(() => cmdLevel(player, [String(level)]));
          return reply('ok');
        }
      );

      registry.registerCommand(
        {
          name: 'pvp:menu',
          description: 'Open the PvP practice menu',
          permissionLevel: anyPlayer,
        },
        (origin) => {
          const player = origin.sourceEntity;
          if (!player || player.typeId !== 'minecraft:player') return reply('Run this as a player.');
          system.run(() => openMenu(player));
          return reply('ok');
        }
      );
    });
    return true;
  } catch {
    return false;
  }
}
