/**
 * PvP Practice Add-on - entry point.
 *
 * Adds `pvp:bot`: an entity that looks exactly like a default Steve, wears real armour,
 * swings real weapons, shoots real arrows and places real blocks, fighting under the same
 * survival rules a player does. Five skill levels, from someone who just picked up a sword
 * to someone who never wastes a tick.
 */

import { system, world } from '@minecraft/server';
import { installDamageTracking, pruneDamageTable } from './combat.js';
import { giveRemote, installChatCommands, installSlashCommands } from './commands.js';
import { startHud } from './hud.js';
import { installEvents, rescanWorld, startTicking } from './manager.js';
import { flushAllStats, flushStats, getSettings } from './state.js';
import { openMenu } from './ui.js';
import { safe } from './util.js';

// Slash commands must be registered during startup, before the world is ready.
installSlashCommands();

system.run(() => {
  installDamageTracking();
  installEvents();
  installChatCommands();
  startTicking();
  startHud();
  rescanWorld();
});

/* ------------------------------------------------------------ housekeeping */

world.afterEvents.playerSpawn.subscribe((ev) => {
  if (!ev.initialSpawn) return;
  safe(() => {
    // First join: hand over the remote so the menu is reachable without commands.
    const inv = ev.player.getComponent('minecraft:inventory')?.container;
    if (!inv) return;
    for (let i = 0; i < inv.size; i++) {
      if (inv.getItem(i)?.typeId === 'pvp:remote') return;
    }
    giveRemote(ev.player);
  });
});

world.afterEvents.playerLeave.subscribe((ev) => {
  safe(() => flushStats(ev.playerId));
});

// The remote opens the menu.
world.afterEvents.itemUse.subscribe((ev) => {
  if (ev.itemStack?.typeId !== 'pvp:remote') return;
  safe(() => openMenu(ev.source));
});

// Periodic maintenance: trim the invulnerability table and persist statistics.
system.runInterval(() => {
  pruneDamageTable(system.currentTick);
  flushAllStats();
  // Touch settings so the cache is warm even if nothing else read it this minute.
  getSettings();
}, 600);
