/**
 * The in-game menus, opened with the PvP Remote (or `!pvp menu`).
 *
 * Forms must never be shown from inside a before-event, so every entry point wraps
 * itself in `system.run`.
 */

import { system } from '@minecraft/server';
import { ActionFormData, ModalFormData } from '@minecraft/server-ui';
import { KIT_ORDER } from './config.js';
import { t } from './lang.js';
import {
  healBrain,
  listBrains,
  nearestBrain,
  removeAllBots,
  removeBot,
  setBrainHome,
  setBrainKit,
  setBrainLevel,
  spawnBotsNear,
} from './manager.js';
import { getSettings, getStats, resetSettings, resetStats, setSetting } from './state.js';
import { V, clamp, safe } from './util.js';

const DP_LAST = 'pvp:lastSpawn';

function lastSpawn(player) {
  const raw = safe(() => player.getDynamicProperty(DP_LAST));
  const parsed = typeof raw === 'string' ? safe(() => JSON.parse(raw)) : undefined;
  return { level: 3, kit: 'sword', count: 1, distance: 6, ...(parsed ?? {}) };
}

function rememberSpawn(player, choice) {
  safe(() => player.setDynamicProperty(DP_LAST, JSON.stringify(choice)));
}

const LEVEL_LABELS = () => [1, 2, 3, 4, 5].map((n) => t('level.' + n));
const KIT_LABELS = () => KIT_ORDER.map((k) => t('kit.' + k));

/* -------------------------------------------------------------- main menu */

export function openMenu(player) {
  system.run(() => {
    const form = new ActionFormData()
      .title(t('menu.title'))
      .body(t('menu.body'))
      .button(t('menu.spawn'))
      .button(t('menu.quick'))
      .button(t('menu.manage'))
      .button(t('menu.removeAll'))
      .button(t('menu.stats'))
      .button(t('menu.settings'))
      .button(t('menu.help'));

    form.show(player).then((res) => {
      if (res.canceled) return;
      switch (res.selection) {
        case 0:
          return openSpawnForm(player);
        case 1:
          return quickSpawn(player);
        case 2:
          return openManage(player);
        case 3: {
          const n = removeAllBots();
          return player.sendMessage(t('cmd.cleared', n));
        }
        case 4:
          return openStats(player);
        case 5:
          return openSettings(player);
        case 6:
          return openHelp(player);
      }
    });
  });
}

/* ----------------------------------------------------------------- spawning */

export function quickSpawn(player) {
  const choice = lastSpawn(player);
  doSpawn(player, choice);
}

function doSpawn(player, choice) {
  const made = spawnBotsNear(player, choice);
  if (made <= 0) {
    player.sendMessage(t('spawn.full', getSettings().maxBots));
    return;
  }
  rememberSpawn(player, choice);
  player.sendMessage(t('spawn.done', choice.level, made));
}

export function openSpawnForm(player) {
  system.run(() => {
    const last = lastSpawn(player);
    const form = new ModalFormData()
      .title(t('spawn.title'))
      .dropdown(t('spawn.level'), LEVEL_LABELS(), { defaultValueIndex: clamp(last.level - 1, 0, 4) })
      .dropdown(t('spawn.kit'), KIT_LABELS(), {
        defaultValueIndex: Math.max(0, KIT_ORDER.indexOf(last.kit)),
      })
      .slider(t('spawn.count'), 1, 5, { valueStep: 1, defaultValue: last.count })
      .slider(t('spawn.distance'), 3, 20, { valueStep: 1, defaultValue: last.distance });

    form.show(player).then((res) => {
      if (res.canceled || !res.formValues) return;
      const [levelIdx, kitIdx, count, distance] = res.formValues;
      doSpawn(player, {
        level: Number(levelIdx) + 1,
        kit: KIT_ORDER[Number(kitIdx)] ?? 'sword',
        count: Number(count),
        distance: Number(distance),
      });
    });
  });
}

/* ------------------------------------------------------------------ manage */

export function openManage(player) {
  system.run(() => {
    const brains = listBrains().filter((b) => safe(() => b.entity.dimension.id === player.dimension.id, false));

    if (!brains.length) {
      new ActionFormData()
        .title(t('manage.title'))
        .body(t('manage.none'))
        .button('OK')
        .show(player);
      return;
    }

    brains.sort((a, b) => {
      const da = safe(() => V.distance(player.location, a.entity.location), 1e9) ?? 1e9;
      const db = safe(() => V.distance(player.location, b.entity.location), 1e9) ?? 1e9;
      return da - db;
    });

    const form = new ActionFormData().title(t('manage.title')).body(t('menu.body'));
    for (const brain of brains) {
      const dist = Math.round(safe(() => V.distance(player.location, brain.entity.location), 0) ?? 0);
      form.button(
        t('manage.entry', brain.level, t('kit.' + brain.kit), dist, `${Math.round(brain.health)}/${brain.maxHealth}`)
      );
    }

    form.show(player).then((res) => {
      if (res.canceled) return;
      const brain = brains[res.selection];
      if (brain) openBotActions(player, brain);
    });
  });
}

function openBotActions(player, brain) {
  system.run(() => {
    const form = new ActionFormData()
      .title(t('manage.title'))
      .body(t('manage.entry', brain.level, t('kit.' + brain.kit), 0, `${Math.round(brain.health)}/${brain.maxHealth}`))
      .button(t('manage.levelUp'))
      .button(t('manage.levelDown'))
      .button(t('manage.heal'))
      .button(t('manage.setHere'))
      .button(t('spawn.kit'))
      .button(t('manage.remove'));

    form.show(player).then((res) => {
      if (res.canceled) return;
      switch (res.selection) {
        case 0:
          setBrainLevel(brain, Math.min(5, brain.level + 1));
          return player.sendMessage(t('cmd.levelSet', brain.level));
        case 1:
          setBrainLevel(brain, Math.max(1, brain.level - 1));
          return player.sendMessage(t('cmd.levelSet', brain.level));
        case 2:
          healBrain(brain);
          return;
        case 3:
          setBrainHome(brain, brain.entity.location, brain.entity.dimension.id);
          return;
        case 4:
          return openKitPicker(player, brain);
        case 5:
          removeBot(brain.id);
          return;
      }
    });
  });
}

function openKitPicker(player, brain) {
  system.run(() => {
    const form = new ActionFormData().title(t('spawn.kit'));
    for (const k of KIT_ORDER) form.button(t('kit.' + k));
    form.show(player).then((res) => {
      if (res.canceled) return;
      const kit = KIT_ORDER[res.selection];
      if (!kit) return;
      setBrainKit(brain, kit);
      player.sendMessage(t('cmd.kitSet', t('kit.' + kit)));
    });
  });
}

/* ------------------------------------------------------------------- stats */

export function openStats(player) {
  system.run(() => {
    const s = getStats(player.id);
    const ratio = s.damageTaken > 0 ? (s.damageDealt / s.damageTaken).toFixed(2) : '—';
    const body = t(
      'stats.body',
      Math.round(s.damageDealt * 10) / 10,
      Math.round(s.damageTaken * 10) / 10,
      s.hits,
      s.hitsTaken ?? 0,
      ratio,
      s.botKills,
      s.deaths,
      s.bestCombo
    );

    new ActionFormData()
      .title(t('stats.title'))
      .body(body)
      .button('OK')
      .button(t('stats.reset'))
      .show(player)
      .then((res) => {
        if (res.canceled) return;
        if (res.selection === 1) {
          resetStats(player.id);
          player.sendMessage(t('stats.cleared'));
        }
      });
  });
}

/* ---------------------------------------------------------------- settings */

export function openSettings(player) {
  system.run(() => {
    const s = getSettings();
    const form = new ModalFormData()
      .title(t('settings.title'))
      .dropdown(t('settings.language'), ['日本語', 'English'], {
        defaultValueIndex: s.language === 'en' ? 1 : 0,
      })
      .slider(t('settings.maxBots'), 1, 20, { valueStep: 1, defaultValue: s.maxBots })
      .toggle(t('settings.respawn'), { defaultValue: s.respawn })
      .slider(t('settings.respawnDelay'), 0, 30, { valueStep: 1, defaultValue: Math.round(s.respawnDelay / 20) })
      .slider(t('settings.targetRange'), 8, 64, { valueStep: 1, defaultValue: s.targetRange })
      .toggle(t('settings.ignoreCreative'), { defaultValue: s.ignoreCreative })
      .toggle(t('settings.botVsBot'), { defaultValue: s.botVsBot })
      .toggle(t('settings.allowBuilding'), { defaultValue: s.allowBuilding })
      .toggle(t('settings.cleanupBlocks'), { defaultValue: s.cleanupBlocks })
      .toggle(t('settings.hud'), { defaultValue: s.hud })
      .toggle(t('settings.showLevelInName'), { defaultValue: s.showLevelInName })
      .slider(t('settings.knockbackScale'), 0, 300, {
        valueStep: 10,
        defaultValue: Math.round(s.knockbackScale * 100),
      })
      .toggle(t('settings.reset'), { defaultValue: false });

    form.show(player).then((res) => {
      if (res.canceled || !res.formValues) return;
      const [
        langIdx,
        maxBots,
        respawn,
        respawnSeconds,
        targetRange,
        ignoreCreative,
        botVsBot,
        allowBuilding,
        cleanupBlocks,
        hud,
        showLevelInName,
        kbPercent,
        doReset,
      ] = res.formValues;

      if (doReset) {
        resetSettings();
        player.sendMessage(t('settings.saved'));
        return;
      }

      setSetting('language', Number(langIdx) === 1 ? 'en' : 'ja');
      setSetting('maxBots', Number(maxBots));
      setSetting('respawn', Boolean(respawn));
      setSetting('respawnDelay', Number(respawnSeconds) * 20);
      setSetting('targetRange', Number(targetRange));
      setSetting('ignoreCreative', Boolean(ignoreCreative));
      setSetting('botVsBot', Boolean(botVsBot));
      setSetting('allowBuilding', Boolean(allowBuilding));
      setSetting('cleanupBlocks', Boolean(cleanupBlocks));
      setSetting('hud', Boolean(hud));
      setSetting('showLevelInName', Boolean(showLevelInName));
      setSetting('knockbackScale', Number(kbPercent) / 100);

      for (const brain of listBrains()) brain.refreshName();
      player.sendMessage(t('settings.saved'));
    });
  });
}

/* -------------------------------------------------------------------- help */

export function openHelp(player) {
  system.run(() => {
    new ActionFormData().title(t('help.title')).body(t('help.body')).button('OK').show(player);
  });
}

/** Used by the chat command handler when a bot must be picked implicitly. */
export function requireNearestBrain(player) {
  const brain = nearestBrain(player, 24);
  if (!brain) player.sendMessage(t('cmd.noBotNear'));
  return brain;
}
