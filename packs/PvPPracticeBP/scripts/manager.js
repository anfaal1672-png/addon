/**
 * Bot lifecycle: spawning, ticking, respawning and clean-up, plus the event wiring
 * that feeds combat results back into the brains and the practice statistics.
 */

import { system, world } from '@minecraft/server';
import { BotBrain } from './bot.js';
import { applyKit } from './kits.js';
import { KITS } from './config.js';
import { cleanupBlocks } from './blocks.js';
import { getSettings, updateStats } from './state.js';
import { V, clamp, isAlive, rotateXZ, safe } from './util.js';

export const BOT_TYPE = 'pvp:bot';

const DP_LEVEL = 'pvp:level';
const DP_KIT = 'pvp:kit';
const DP_HOME = 'pvp:home';

/** @type {Map<string, BotBrain>} */
const brains = new Map();

function dimensionLookup(id) {
  return safe(() => world.getDimension(id));
}

/* ---------------------------------------------------------------- registry */

export function listBrains() {
  return [...brains.values()];
}

export function botCount() {
  return brains.size;
}

export function getBrain(id) {
  return brains.get(id);
}

/** Rebuilds a brain for a bot entity that already exists in the world (e.g. after a reload). */
export function adopt(entity) {
  if (!isAlive(entity) || entity.typeId !== BOT_TYPE) return undefined;
  if (brains.has(entity.id)) return brains.get(entity.id);

  const level = clamp(Number(safe(() => entity.getDynamicProperty(DP_LEVEL)) ?? 1), 1, 5);
  const kit = String(safe(() => entity.getDynamicProperty(DP_KIT)) ?? 'sword');
  const homeRaw = safe(() => entity.getDynamicProperty(DP_HOME));
  const home =
    typeof homeRaw === 'string'
      ? safe(() => JSON.parse(homeRaw))
      : { location: { ...entity.location }, dimensionId: entity.dimension.id };

  const brain = new BotBrain(entity, { level, kit, home });
  brain.refreshName();
  brains.set(entity.id, brain);
  return brain;
}

function persist(entity, { level, kit, home }) {
  safe(() => {
    entity.setDynamicProperty(DP_LEVEL, level);
    entity.setDynamicProperty(DP_KIT, kit);
    entity.setDynamicProperty(DP_HOME, JSON.stringify(home));
  });
}

/* ----------------------------------------------------------------- spawning */

/** Finds a spot near `origin` that a 1.8-block-tall entity can actually stand in. */
function findSpawnSpot(dimension, origin, distance, angleDeg) {
  const offset = rotateXZ({ x: 0, z: distance }, angleDeg);
  const base = { x: origin.x + offset.x, y: origin.y, z: origin.z + offset.z };

  for (const dy of [0, 1, 2, -1, -2, 3, -3, 4, -4]) {
    const test = { x: base.x, y: base.y + dy, z: base.z };
    const ok = safe(() => {
      const feet = dimension.getBlock(test);
      const head = dimension.getBlock({ ...test, y: test.y + 1 });
      const floor = dimension.getBlock({ ...test, y: test.y - 1 });
      return feet?.isAir && head?.isAir && floor && !floor.isAir;
    }, false);
    if (ok) return test;
  }
  return base;
}

/**
 * @param {object} opts
 * @param {import('@minecraft/server').Dimension} opts.dimension
 * @param {object} opts.location
 * @param {number} opts.level
 * @param {string} opts.kit
 */
export function spawnBot({ dimension, location, level, kit, facing }) {
  const entity = safe(() => dimension.spawnEntity(BOT_TYPE, location));
  if (!entity) return undefined;

  const home = { location: { ...location }, dimensionId: dimension.id };
  const kitId = KITS[kit] ? kit : 'sword';

  applyKit(entity, kitId);
  persist(entity, { level, kit: kitId, home });

  if (facing) safe(() => entity.lookAt(facing));

  const brain = new BotBrain(entity, { level, kit: kitId, home });
  brain.refreshName();
  brains.set(entity.id, brain);

  safe(() => dimension.spawnParticle('minecraft:large_explosion', location));
  safe(() => dimension.playSound('mob.zombie_villager.cure', location, { volume: 0.5, pitch: 1.6 }));
  return brain;
}

/**
 * Spawns `count` bots in a fan in front of the player.
 * @returns {number} how many were actually created.
 */
export function spawnBotsNear(player, { level, kit, count = 1, distance = 6 }) {
  const settings = getSettings();
  const room = Math.max(0, settings.maxBots - brains.size);
  const n = Math.min(count, room);
  if (n <= 0) return 0;

  const origin = player.location;
  const yaw = safe(() => player.getRotation().y, 0) ?? 0;

  let made = 0;
  for (let i = 0; i < n; i++) {
    const spread = n === 1 ? 0 : (i / (n - 1) - 0.5) * 60;
    const spot = findSpawnSpot(player.dimension, origin, distance, yaw + 180 + spread);
    const brain = spawnBot({
      dimension: player.dimension,
      location: spot,
      level,
      kit,
      facing: origin,
    });
    if (brain) made++;
  }
  return made;
}

/* ----------------------------------------------------------------- removal */

export function removeBot(id) {
  const brain = brains.get(id);
  if (!brain) return false;
  brain.dispose(dimensionLookup);
  safe(() => brain.entity.remove());
  brains.delete(id);
  return true;
}

export function removeAllBots() {
  let n = 0;
  for (const id of [...brains.keys()]) {
    if (removeBot(id)) n++;
  }
  // Sweep for orphans that were never adopted (e.g. spawn-egg bots in an unloaded chunk).
  for (const dimId of ['overworld', 'nether', 'the_end']) {
    safe(() => {
      for (const e of world.getDimension(dimId).getEntities({ type: BOT_TYPE })) {
        e.remove();
        n++;
      }
    });
  }
  return n;
}

/* ------------------------------------------------------------------ ticking */

let tickHandle;

export function startTicking() {
  if (tickHandle !== undefined) return;
  tickHandle = system.runInterval(() => {
    const tick = system.currentTick;
    for (const [id, brain] of brains) {
      if (!isAlive(brain.entity)) {
        brain.dispose(dimensionLookup);
        brains.delete(id);
        continue;
      }
      try {
        brain.tick(tick);
      } catch {
        // A single bad tick must never take the whole add-on down.
      }
    }
  }, 1);
}

/** Picks up bots that exist in the world but have no brain yet. */
export function rescanWorld() {
  for (const dimId of ['overworld', 'nether', 'the_end']) {
    safe(() => {
      for (const e of world.getDimension(dimId).getEntities({ type: BOT_TYPE })) adopt(e);
    });
  }
}

/* ------------------------------------------------------------------- events */

export function installEvents() {
  world.afterEvents.entityLoad?.subscribe((ev) => {
    safe(() => {
      if (ev.entity.typeId === BOT_TYPE) adopt(ev.entity);
    });
  });

  world.afterEvents.entitySpawn.subscribe((ev) => {
    safe(() => {
      if (ev.entity.typeId !== BOT_TYPE) return;
      if (brains.has(ev.entity.id)) return;
      // A bot placed with the spawn egg: give it a default kit so it is not naked.
      const brain = adopt(ev.entity);
      if (brain && safe(() => ev.entity.getDynamicProperty(DP_KIT)) === undefined) {
        applyKit(ev.entity, 'sword');
        persist(ev.entity, { level: brain.level, kit: 'sword', home: brain.home });
      }
    });
  });

  world.afterEvents.entityHurt.subscribe((ev) => {
    safe(() => {
      const tick = system.currentTick;
      const victim = ev.hurtEntity;
      const attacker = ev.damageSource?.damagingEntity;
      const amount = ev.damage;

      if (victim.typeId === BOT_TYPE) {
        const brain = brains.get(victim.id);
        brain?.onHurt(tick, attacker);
        if (attacker?.typeId === 'minecraft:player') {
          updateStats(attacker.id, (s) => {
            s.damageDealt += amount;
            s.hits += 1;
            s.currentCombo += 1;
          });
        }
      }

      if (victim.typeId === 'minecraft:player' && attacker?.typeId === BOT_TYPE) {
        updateStats(victim.id, (s) => {
          s.damageTaken += amount;
          s.hitsTaken = (s.hitsTaken ?? 0) + 1;
          s.currentCombo = 0;
        });
      }
    });
  });

  world.afterEvents.entityDie.subscribe((ev) => {
    safe(() => {
      const dead = ev.deadEntity;
      const killer = ev.damageSource?.damagingEntity;

      if (dead.typeId === 'minecraft:player') {
        updateStats(dead.id, (s) => {
          s.deaths += 1;
          s.currentCombo = 0;
        });
        return;
      }

      if (dead.typeId !== BOT_TYPE) return;

      const brain = brains.get(dead.id);
      brains.delete(dead.id);
      if (!brain) return;

      if (killer?.typeId === 'minecraft:player') {
        updateStats(killer.id, (s) => {
          s.botKills += 1;
          s.currentCombo = 0;
        });
      }

      const settings = getSettings();
      const home = brain.home;
      cleanupBlocks(dimensionLookup, brain.placed);

      if (!settings.respawn || !home) return;
      system.runTimeout(() => {
        const dim = dimensionLookup(home.dimensionId);
        if (!dim) return;
        if (brains.size >= settings.maxBots) return;
        spawnBot({
          dimension: dim,
          location: home.location,
          level: brain.level,
          kit: brain.kit,
        });
      }, Math.max(1, settings.respawnDelay));
    });
  });
}

/* ---------------------------------------------------------------- utilities */

export function nearestBrain(player, radius = 16) {
  let best;
  let bestDist = radius;
  for (const brain of brains.values()) {
    if (!isAlive(brain.entity)) continue;
    const same = safe(() => brain.entity.dimension.id === player.dimension.id, false);
    if (!same) continue;
    const d = safe(() => V.distance(player.location, brain.entity.location), Infinity) ?? Infinity;
    if (d < bestDist) {
      bestDist = d;
      best = brain;
    }
  }
  return best;
}

export function setBrainLevel(brain, level) {
  brain.setLevel(level);
  persist(brain.entity, { level: brain.level, kit: brain.kit, home: brain.home });
}

export function setBrainKit(brain, kitId) {
  const applied = applyKit(brain.entity, kitId);
  brain.kit = applied;
  persist(brain.entity, { level: brain.level, kit: applied, home: brain.home });
  return applied;
}

export function healBrain(brain) {
  safe(() => {
    const hp = brain.entity.getComponent('minecraft:health');
    hp?.resetToMaxValue();
  });
}

export function setBrainHome(brain, location, dimensionId) {
  brain.home = { location: { ...location }, dimensionId };
  persist(brain.entity, { level: brain.level, kit: brain.kit, home: brain.home });
}
