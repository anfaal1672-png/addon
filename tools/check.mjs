/**
 * Static sanity check for the add-on.
 *
 *  1. every JSON file parses
 *  2. every script module loads against the stubs in ./node_modules/@minecraft/*
 *     (this catches typos in import lists, which the game only reports at runtime)
 *  3. cross-references that are easy to get wrong: entity identifiers, texture names,
 *     manifest dependency UUIDs, and the level table.
 *
 * Run:  npm run check
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BP = join(ROOT, 'packs', 'PvPPracticeBP');
const RP = join(ROOT, 'packs', 'PvPPracticeRP');

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('  ✗ ' + msg);
};
const pass = (msg) => console.log('  ✓ ' + msg);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/* ------------------------------------------------------------------- 1. JSON */

console.log('JSON');
const jsonFiles = walk(join(ROOT, 'packs')).filter((f) => f.endsWith('.json'));
const parsed = new Map();
for (const file of jsonFiles) {
  try {
    parsed.set(file, JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    fail(`${relative(ROOT, file)}: ${err.message}`);
  }
}
if (parsed.size === jsonFiles.length) pass(`${jsonFiles.length} files parse`);

/* ---------------------------------------------------------------- 2. modules */

console.log('Scripts');
const scriptDir = join(BP, 'scripts');
for (const file of readdirSync(scriptDir).filter((f) => f.endsWith('.js')).sort()) {
  try {
    await import(pathToFileURL(join(scriptDir, file)).href);
    pass(`scripts/${file} loads`);
  } catch (err) {
    fail(`scripts/${file}: ${err.message}`);
  }
}

/* ------------------------------------------------------------ 3. cross-refs */

console.log('Cross references');

const bpManifest = parsed.get(join(BP, 'manifest.json'));
const rpManifest = parsed.get(join(RP, 'manifest.json'));

const rpUuid = rpManifest?.header?.uuid;
const dependsOnRp = bpManifest?.dependencies?.some((d) => d.uuid === rpUuid);
dependsOnRp
  ? pass('behaviour pack depends on the resource pack UUID')
  : fail('behaviour pack does not depend on the resource pack UUID');

const uuids = [
  bpManifest?.header?.uuid,
  ...(bpManifest?.modules ?? []).map((m) => m.uuid),
  rpManifest?.header?.uuid,
  ...(rpManifest?.modules ?? []).map((m) => m.uuid),
];
new Set(uuids).size === uuids.length ? pass('all module UUIDs are unique') : fail('duplicate UUID in a manifest');

const entryPath = join(BP, bpManifest?.modules?.find((m) => m.type === 'script')?.entry ?? '');
existsSync(entryPath) ? pass('script entry point exists') : fail(`missing script entry: ${entryPath}`);

const bpEntity = parsed.get(join(BP, 'entities', 'pvp_bot.json'));
const rpEntity = parsed.get(join(RP, 'entity', 'pvp_bot.entity.json'));
const bpId = bpEntity?.['minecraft:entity']?.description?.identifier;
const rpId = rpEntity?.['minecraft:client_entity']?.description?.identifier;
bpId === rpId && bpId === 'pvp:bot'
  ? pass('entity identifier matches on both sides (pvp:bot)')
  : fail(`entity identifier mismatch: ${bpId} vs ${rpId}`);

const geo = rpEntity?.['minecraft:client_entity']?.description?.geometry?.default;
const tex = rpEntity?.['minecraft:client_entity']?.description?.textures?.default;
geo === 'geometry.humanoid.custom' && tex === 'textures/entity/steve'
  ? pass('bot uses the vanilla player model and Steve texture')
  : fail(`bot look is not the vanilla player: geometry=${geo} texture=${tex}`);

rpEntity?.['minecraft:client_entity']?.description?.enable_attachables === true
  ? pass('attachables enabled (armour and held items render)')
  : fail('enable_attachables missing - armour would be invisible');

const controllerName = rpEntity?.['minecraft:client_entity']?.description?.render_controllers?.[0];
const controllers = parsed.get(join(RP, 'render_controllers', 'pvp_bot.render_controllers.json'));
controllers?.render_controllers?.[controllerName]
  ? pass(`render controller ${controllerName} is defined`)
  : fail(`render controller ${controllerName} is not defined`);

const itemDef = parsed.get(join(BP, 'items', 'remote.json'));
const iconName = itemDef?.['minecraft:item']?.components?.['minecraft:icon'];
const itemTex = parsed.get(join(RP, 'textures', 'item_texture.json'));
const iconPath = itemTex?.texture_data?.[iconName]?.textures;
if (!iconPath) fail(`item icon "${iconName}" is not in item_texture.json`);
else if (!existsSync(join(RP, iconPath + '.png'))) fail(`icon texture missing: ${iconPath}.png`);
else pass('remote item icon is wired up');

for (const pack of [BP, RP]) {
  existsSync(join(pack, 'pack_icon.png'))
    ? pass(`${relative(ROOT, pack)}/pack_icon.png present`)
    : fail(`${relative(ROOT, pack)}/pack_icon.png missing (run npm run textures)`);
}

const lootRef = bpEntity?.['minecraft:entity']?.components?.['minecraft:loot']?.table;
existsSync(join(BP, lootRef ?? '')) ? pass('loot table exists') : fail(`missing loot table: ${lootRef}`);

/* --------------------------------------------------------- 4. level sanity */

console.log('Level table');
const { LEVELS, KITS, KIT_ORDER } = await import(pathToFileURL(join(scriptDir, 'config.js')).href);

LEVELS.length === 5 ? pass('five levels defined') : fail(`expected 5 levels, found ${LEVELS.length}`);

const monotonic = [
  ['cps', 1],
  ['hitChance', 1],
  ['critSkill', 1],
  ['strafe', 1],
  ['bowSkill', 1],
  ['buildSkill', 1],
  ['reactionTicks', -1],
  ['aimError', -1],
  ['jitter', -1],
];
for (const [key, dir] of monotonic) {
  let ok = true;
  for (let i = 1; i < LEVELS.length; i++) {
    const delta = (LEVELS[i][key] - LEVELS[i - 1][key]) * dir;
    if (delta < 0) ok = false;
  }
  ok ? pass(`${key} moves the right way across levels`) : fail(`${key} is not monotonic across levels`);
}

const missingKit = KIT_ORDER.find((k) => !KITS[k]);
missingKit ? fail(`KIT_ORDER references an undefined kit: ${missingKit}`) : pass('every kit in KIT_ORDER exists');

/* ------------------------------------------------------------------ result */

console.log('');
if (failures) {
  console.error(`${failures} problem(s) found.`);
  process.exit(1);
}
console.log('All checks passed.');
