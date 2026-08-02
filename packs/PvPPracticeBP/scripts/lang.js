/**
 * Tiny localisation table. Scripted UI text cannot use .lang files, so the strings
 * that the add-on prints at runtime live here. Japanese is the default.
 */

import { getSettings } from './state.js';

const STRINGS = {
  ja: {
    'menu.title': '§lPvP練習§r',
    'menu.body': 'ボットを呼び出して練習しましょう。',
    'menu.spawn': 'ボットを召喚',
    'menu.spawnDesc': 'レベルとキットを選んで召喚',
    'menu.quick': 'クイック召喚 (前回と同じ)',
    'menu.manage': 'ボットを管理',
    'menu.removeAll': 'ボットを全削除',
    'menu.stats': '戦績を見る',
    'menu.settings': '設定',
    'menu.help': '使い方',

    'spawn.title': 'ボット召喚',
    'spawn.level': '強さ (レベル)',
    'spawn.kit': 'キット',
    'spawn.count': '召喚する数',
    'spawn.distance': '召喚する距離 (ブロック)',
    'spawn.done': '§aレベル%1のボットを%2体召喚しました。',
    'spawn.full': '§cボットの上限 (%1体) に達しています。',

    'manage.title': 'ボット管理',
    'manage.none': '§7ボットがいません。',
    'manage.entry': 'Lv%1 %2 (%3m) HP %4',
    'manage.remove': '削除',
    'manage.heal': '全回復',
    'manage.levelUp': 'レベルを上げる',
    'manage.levelDown': 'レベルを下げる',
    'manage.setHere': '現在地をリスポーン地点にする',

    'settings.title': '設定',
    'settings.language': '言語 / Language',
    'settings.maxBots': 'ボット最大数',
    'settings.respawn': '倒したらリスポーンさせる',
    'settings.respawnDelay': 'リスポーンまでの秒数',
    'settings.targetRange': '索敵範囲 (ブロック)',
    'settings.ignoreCreative': 'クリエイティブ/スペクテイターを狙わない',
    'settings.botVsBot': 'ボット同士も戦わせる',
    'settings.allowBuilding': 'ボットのブロック設置を許可',
    'settings.cleanupBlocks': '設置ブロックを自動撤去',
    'settings.hud': 'HUD (アクションバー) を表示',
    'settings.showLevelInName': '名前にレベルを表示',
    'settings.knockbackScale': 'ノックバック倍率 (%)',
    'settings.saved': '§a設定を保存しました。',
    'settings.reset': '設定を初期値に戻す',

    'stats.title': '戦績',
    'stats.body':
      '§7与ダメージ§r %1  §7(%3 ヒット)\n§7被ダメージ§r %2  §7(%4 被弾)\n§7ダメージ比§r %5\n§7撃破§r %6  §7デス§r %7\n§7最大コンボ§r %8',
    'stats.reset': '記録をリセット',
    'stats.cleared': '§a戦績をリセットしました。',

    'hud.bot': '§fLv%1 §7HP §c%2§7/§c%3',
    'hud.combo': ' §7コンボ §e%1',
    'hud.none': '§7ボットなし',

    'help.title': '使い方',
    'help.body':
      '§lPvPリモコン§r を持って使用するとこのメニューが開きます。\n\n' +
      '§eチャットコマンド§r\n' +
      '§7!pvp spawn <1-5> [キット] [数]§r ボットを召喚\n' +
      '§7!pvp clear§r 全ボット削除\n' +
      '§7!pvp level <1-5>§r 近くのボットのレベル変更\n' +
      '§7!pvp kit <名前>§r 近くのボットの装備変更\n' +
      '§7!pvp menu§r このメニューを開く\n' +
      '§7!pvp stats§r 戦績\n' +
      '§7!pvp diag§r 動作診断 (装備・アニメの実状態を表示)\n' +
      '§7!pvp help§r ヘルプ\n\n' +
      '§eレベルの目安§r\n' +
      '§7Lv1§r 初心者 - 反応が遅く棒立ち\n' +
      '§7Lv2§r 一般プレイヤー - 少し動く\n' +
      '§7Lv3§r 中級者 - ストレイフと部分的なクリティカル\n' +
      '§7Lv4§r 上級者 - 高CPS・コンボ・置きブロック\n' +
      '§7Lv5§r 世界最高峰 - 無駄のない立ち回りと完璧なタイミング',

    'cmd.unknown': '§c不明なコマンドです。!pvp help を見てください。',
    'cmd.needLevel': '§cレベルは1〜5で指定してください。',
    'cmd.noBotNear': '§c近くにボットがいません。',
    'cmd.cleared': '§aボットを%1体削除しました。',
    'cmd.levelSet': '§aボットのレベルを%1にしました。',
    'cmd.kitSet': '§a装備を%1に変更しました。',
    'cmd.unknownKit': '§c不明なキットです: %1',
    'cmd.gotRemote': '§aPvPリモコンを渡しました。',

    'level.1': 'Lv1 初心者',
    'level.2': 'Lv2 一般プレイヤー',
    'level.3': 'Lv3 中級者',
    'level.4': 'Lv4 上級者',
    'level.5': 'Lv5 世界最高峰',

    'kit.none': '素手',
    'kit.sword': '鉄装備 + 鉄の剣',
    'kit.diamond': 'ダイヤ装備',
    'kit.netherite': 'ネザライト装備',
    'kit.bow': '弓',
    'kit.uhc': 'UHC',
  },

  en: {
    'menu.title': '§lPvP Practice§r',
    'menu.body': 'Summon a bot and start training.',
    'menu.spawn': 'Summon bot',
    'menu.spawnDesc': 'Pick a level and a kit',
    'menu.quick': 'Quick summon (repeat last)',
    'menu.manage': 'Manage bots',
    'menu.removeAll': 'Remove all bots',
    'menu.stats': 'Statistics',
    'menu.settings': 'Settings',
    'menu.help': 'How to use',

    'spawn.title': 'Summon bot',
    'spawn.level': 'Skill level',
    'spawn.kit': 'Kit',
    'spawn.count': 'How many',
    'spawn.distance': 'Spawn distance (blocks)',
    'spawn.done': '§aSummoned %2 level %1 bot(s).',
    'spawn.full': '§cBot limit reached (%1).',

    'manage.title': 'Manage bots',
    'manage.none': '§7No bots are active.',
    'manage.entry': 'Lv%1 %2 (%3m) HP %4',
    'manage.remove': 'Remove',
    'manage.heal': 'Full heal',
    'manage.levelUp': 'Level up',
    'manage.levelDown': 'Level down',
    'manage.setHere': 'Set respawn point here',

    'settings.title': 'Settings',
    'settings.language': '言語 / Language',
    'settings.maxBots': 'Max bots',
    'settings.respawn': 'Respawn bots after death',
    'settings.respawnDelay': 'Respawn delay (seconds)',
    'settings.targetRange': 'Target range (blocks)',
    'settings.ignoreCreative': 'Ignore creative/spectator players',
    'settings.botVsBot': 'Bots fight each other',
    'settings.allowBuilding': 'Allow bots to place blocks',
    'settings.cleanupBlocks': 'Auto-remove placed blocks',
    'settings.hud': 'Show action-bar HUD',
    'settings.showLevelInName': 'Show level in nameplate',
    'settings.knockbackScale': 'Knockback scale (%)',
    'settings.saved': '§aSettings saved.',
    'settings.reset': 'Reset to defaults',

    'stats.title': 'Statistics',
    'stats.body':
      '§7Damage dealt§r %1  §7(%3 hits)\n§7Damage taken§r %2  §7(%4 taken)\n§7Damage ratio§r %5\n§7Kills§r %6  §7Deaths§r %7\n§7Best combo§r %8',
    'stats.reset': 'Reset statistics',
    'stats.cleared': '§aStatistics cleared.',

    'hud.bot': '§fLv%1 §7HP §c%2§7/§c%3',
    'hud.combo': ' §7combo §e%1',
    'hud.none': '§7No bots',

    'help.title': 'How to use',
    'help.body':
      'Hold the §lPvP Remote§r and use it to open this menu.\n\n' +
      '§eChat commands§r\n' +
      '§7!pvp spawn <1-5> [kit] [count]§r summon bots\n' +
      '§7!pvp clear§r remove every bot\n' +
      '§7!pvp level <1-5>§r change the nearest bot\n' +
      '§7!pvp kit <name>§r re-equip the nearest bot\n' +
      '§7!pvp menu§r open this menu\n' +
      '§7!pvp stats§r statistics\n' +
      '§7!pvp diag§r runtime diagnostics (what actually equipped/animated)\n' +
      '§7!pvp help§r help\n\n' +
      '§eLevels§r\n' +
      '§7Lv1§r beginner - slow, mostly stands still\n' +
      '§7Lv2§r casual player - some movement\n' +
      '§7Lv3§r skilled - strafing and some crits\n' +
      '§7Lv4§r expert - high CPS, combos, block clutches\n' +
      '§7Lv5§r world class - flawless spacing and timing',

    'cmd.unknown': '§cUnknown command. Try !pvp help.',
    'cmd.needLevel': '§cLevel must be between 1 and 5.',
    'cmd.noBotNear': '§cNo bot nearby.',
    'cmd.cleared': '§aRemoved %1 bot(s).',
    'cmd.levelSet': '§aBot level set to %1.',
    'cmd.kitSet': '§aKit changed to %1.',
    'cmd.unknownKit': '§cUnknown kit: %1',
    'cmd.gotRemote': '§aHere is your PvP Remote.',

    'level.1': 'Lv1 Beginner',
    'level.2': 'Lv2 Casual',
    'level.3': 'Lv3 Skilled',
    'level.4': 'Lv4 Expert',
    'level.5': 'Lv5 World class',

    'kit.none': 'Bare hands',
    'kit.sword': 'Iron armour + iron sword',
    'kit.diamond': 'Diamond',
    'kit.netherite': 'Netherite',
    'kit.bow': 'Bow',
    'kit.uhc': 'UHC',
  },
};

/** Looks up a string for the active language and substitutes %1, %2, ... */
export function t(key, ...args) {
  const lang = getSettings().language === 'en' ? 'en' : 'ja';
  let s = STRINGS[lang][key] ?? STRINGS.ja[key] ?? key;
  for (let i = 0; i < args.length; i++) {
    s = s.split('%' + (i + 1)).join(String(args[i]));
  }
  return s;
}
