/**
 * Action-bar HUD: the nearest bot's level and health, plus your current combo.
 * Refreshed a few times a second - often enough to read a fight, rare enough to be free.
 */

import { system, world } from '@minecraft/server';
import { t } from './lang.js';
import { nearestBrain } from './manager.js';
import { getSettings, getStats } from './state.js';
import { safe } from './util.js';

function healthBar(current, max) {
  const slots = 10;
  const filled = Math.max(0, Math.min(slots, Math.round((current / Math.max(max, 1)) * slots)));
  return '§c' + '|'.repeat(filled) + '§8' + '|'.repeat(slots - filled) + '§r';
}

export function startHud() {
  system.runInterval(() => {
    const settings = getSettings();
    if (!settings.hud) return;

    for (const player of world.getAllPlayers()) {
      safe(() => {
        const brain = nearestBrain(player, settings.targetRange);
        if (!brain) {
          return; // nothing to say; leave the action bar alone
        }

        const hp = Math.max(0, Math.round(brain.health * 10) / 10);
        const max = brain.maxHealth;
        let line = t('hud.bot', brain.level, hp, max) + ' ' + healthBar(hp, max);

        const stats = getStats(player.id);
        if (stats.currentCombo > 1) line += t('hud.combo', stats.currentCombo);

        player.onScreenDisplay.setActionBar(line);
      });
    }
  }, 5);
}
