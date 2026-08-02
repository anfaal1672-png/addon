/**
 * Packages the two packs into distributable archives:
 *
 *   dist/PvPPractice.mcaddon          both packs - the one-tap install
 *   dist/PvPPracticeBP.mcpack         behaviour pack only
 *   dist/PvPPracticeRP.mcpack         resource pack only
 *
 * Written against Node's own zlib so there is nothing to install.
 * Run:  npm run build
 */

import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'dist');

/* --------------------------------------------------------------- zip writer */

// Node 20+ exposes zlib.crc32; fall back to a table implementation on older runtimes.
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc(buf) {
  if (typeof crc32 === 'function') return crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(date = new Date()) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

/** Builds a ZIP archive from `entries` ([{ name, data }]). */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosTime();

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const checksum = crc(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, compressed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(checksum, 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/* ------------------------------------------------------------------ walking */

function collect(dir, prefix, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) collect(full, rel, out);
    else out.push({ name: rel, data: readFileSync(full) });
  }
  return out;
}

/* -------------------------------------------------------------------- build */

const BP = join(ROOT, 'packs', 'PvPPracticeBP');
const RP = join(ROOT, 'packs', 'PvPPracticeRP');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const bpEntries = collect(BP, '');
const rpEntries = collect(RP, '');

const outputs = [
  ['PvPPracticeBP.mcpack', bpEntries],
  ['PvPPracticeRP.mcpack', rpEntries],
  [
    'PvPPractice.mcaddon',
    [
      ...collect(BP, 'PvPPracticeBP'),
      ...collect(RP, 'PvPPracticeRP'),
    ],
  ],
];

for (const [name, entries] of outputs) {
  const buf = makeZip(entries);
  writeFileSync(join(DIST, name), buf);
  console.log(`${relative(ROOT, join(DIST, name))}  ${entries.length} files, ${(buf.length / 1024).toFixed(1)} KiB`);
}

console.log('\nInstall: open dist/PvPPractice.mcaddon with Minecraft, then enable both packs on your world.');
