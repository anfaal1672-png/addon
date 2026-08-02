/**
 * Runtime capability probes.
 *
 * Several things this add-on needs behave differently (or silently do nothing) depending on
 * the Minecraft build: whether a custom mob exposes an equipment component to script, whether
 * `setEquipment` actually sticks, whether entity properties exist. Guessing is how you ship a
 * bot with no armour, so instead the add-on probes at runtime, records what worked, and
 * `!pvp diag` prints the report in game.
 */

const results = new Map();

/**
 * @param {string} key   short id, e.g. "equip.component"
 * @param {boolean} ok
 * @param {string} [detail]
 */
export function record(key, ok, detail = '') {
  const prev = results.get(key);
  // Once something has been observed working, keep that - a later failure is usually a
  // different cause (e.g. an item that simply is not in the inventory).
  if (prev?.ok && !ok) {
    prev.failures = (prev.failures ?? 0) + 1;
    return;
  }
  results.set(key, { ok, detail, failures: prev?.failures ?? 0 });
}

export function get(key) {
  return results.get(key);
}

export function report() {
  if (results.size === 0) return '§7(no probes have run yet - summon a bot first)';
  const lines = [];
  for (const [key, value] of results) {
    const mark = value.ok ? '§a✔§r' : '§c✘§r';
    const fails = value.failures ? ` §8(${value.failures} later failures)` : '';
    lines.push(`${mark} §f${key}§r ${value.detail}${fails}`);
  }
  return lines.join('\n');
}

export function clear() {
  results.clear();
}
