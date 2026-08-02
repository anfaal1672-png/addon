/**
 * World-level persistence: add-on settings and per-player practice statistics.
 * Everything is stored in world dynamic properties so it survives a reload.
 */

import { world } from '@minecraft/server';
import { DEFAULT_SETTINGS, SETTING_KEYS } from './config.js';
import { safe } from './util.js';

const SETTINGS_KEY = 'pvp:settings';
const STATS_PREFIX = 'pvp:stats:';

let cache;

export function getSettings() {
  if (cache) return cache;
  const raw = safe(() => world.getDynamicProperty(SETTINGS_KEY));
  let stored = {};
  if (typeof raw === 'string') {
    stored = safe(() => JSON.parse(raw), {}) ?? {};
  }
  cache = { ...DEFAULT_SETTINGS, ...stored };
  return cache;
}

export function setSetting(key, value) {
  if (!SETTING_KEYS.includes(key)) return false;
  const settings = getSettings();
  settings[key] = value;
  safe(() => world.setDynamicProperty(SETTINGS_KEY, JSON.stringify(settings)));
  return true;
}

export function resetSettings() {
  cache = { ...DEFAULT_SETTINGS };
  safe(() => world.setDynamicProperty(SETTINGS_KEY, JSON.stringify(cache)));
}

/* ----------------------------------------------------------------- statistics */

const EMPTY_STATS = {
  damageDealt: 0,
  damageTaken: 0,
  hits: 0,
  hitsTaken: 0,
  botKills: 0,
  deaths: 0,
  bestCombo: 0,
  currentCombo: 0,
};

/** In-memory mirror so the HUD does not hit dynamic properties 20 times a second. */
const liveStats = new Map();

export function getStats(playerId) {
  let s = liveStats.get(playerId);
  if (s) return s;
  const raw = safe(() => world.getDynamicProperty(STATS_PREFIX + playerId));
  s = typeof raw === 'string' ? { ...EMPTY_STATS, ...(safe(() => JSON.parse(raw), {}) ?? {}) } : { ...EMPTY_STATS };
  liveStats.set(playerId, s);
  return s;
}

export function updateStats(playerId, mutate) {
  const s = getStats(playerId);
  mutate(s);
  if (s.currentCombo > s.bestCombo) s.bestCombo = s.currentCombo;
  return s;
}

export function resetStats(playerId) {
  liveStats.set(playerId, { ...EMPTY_STATS });
  safe(() => world.setDynamicProperty(STATS_PREFIX + playerId, undefined));
}

/** Flushes the in-memory stats to disk. Called on a slow timer and on player leave. */
export function flushStats(playerId) {
  const s = liveStats.get(playerId);
  if (!s) return;
  safe(() => world.setDynamicProperty(STATS_PREFIX + playerId, JSON.stringify(s)));
}

export function flushAllStats() {
  for (const id of liveStats.keys()) flushStats(id);
}
