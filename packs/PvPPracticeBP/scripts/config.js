/**
 * Every tunable number in the add-on lives here.
 *
 * The five levels are not "more damage / more health" — the bot always fights with
 * exactly the same survival rules a player does. What changes is *skill*: how fast it
 * reacts, how accurately it aims, how well it times hits around Bedrock's 10-tick
 * invulnerability window, whether it strafes, crits, combos, dodges and clutches.
 */

/* ----------------------------------------------------------- world constants */

/** Bedrock walk speed in blocks/tick (4.317 m/s). */
export const WALK_SPEED = 0.2159;
/** Bedrock sprint speed in blocks/tick (5.612 m/s). */
export const SPRINT_SPEED = 0.2806;
/** Vanilla jump impulse. */
export const JUMP_POWER = 0.42;
/** Extra forward velocity a sprint-jump carries in vanilla. */
export const SPRINT_JUMP_BOOST = 0.2;
/** Ticks of invulnerability an entity gets after taking damage. */
export const IFRAME_TICKS = 10;
/** Survival melee reach on Bedrock, in blocks. */
export const BASE_REACH = 3.0;
/** Arrow speed of a fully drawn bow, in blocks/tick. */
export const ARROW_SPEED = 3.0;
/** Per-tick downward acceleration applied to arrows. */
export const ARROW_GRAVITY = 0.05;

/* --------------------------------------------------------------- bot levels */

/**
 * @typedef {object} LevelProfile
 * @property {number} level
 * @property {string} id
 * @property {number} reactionTicks   Smooth-pursuit lag, in ticks: how far behind the truth the bot's
 *   picture of its opponent is while tracking. Human smooth pursuit runs about 100-130 ms, so
 *   even the top level sits at 3 ticks; going below that is not a better player, it is a robot.
 * @property {number} aimError        Standard aim error in degrees.
 * @property {number} turnSpeed       Max degrees the head can turn per tick.
 * @property {number} cps             Attack attempts per second.
 * @property {number} iframeAwareness 0..1 - how well the bot times hits to the 10-tick i-frame window.
 * @property {number} reach           Effective melee reach in blocks.
 * @property {number} hitChance       Probability an in-range swing actually connects.
 * @property {number} critSkill       0..1 - how often it lands jump-crits.
 * @property {number} strafe          0..1 - strength of circle-strafing.
 * @property {number} sprintSkill     0..1 - how much of the fight it spends sprinting.
 * @property {number} wtapSkill       0..1 - w-tap / sprint-reset quality (knockback dealt).
 * @property {number} comboSkill      0..1 - how well it chases you through knockback.
 * @property {number} kbControl       0..1 - how much incoming knockback it cancels by counter-strafing.
 * @property {number} dodgeSkill      0..1 - reaction to incoming arrows/projectiles.
 * @property {number} bowSkill        0..1 - bow accuracy, lead prediction and draw timing.
 * @property {number} buildSkill      0..1 - block clutching: blocking off, towering, bridging, MLG.
 * @property {number} healThreshold   Fraction of HP at which it eats a golden apple (0 = never).
 * @property {number} retreatSkill    0..1 - how sensibly it disengages when low.
 * @property {number} jitter          0..1 - random misplays. High on level 1, ~0 on level 5.
 */

/** @type {LevelProfile[]} */
export const LEVELS = [
  {
    level: 1,
    id: 'beginner',
    reactionTicks: 12,
    aimError: 22,
    turnSpeed: 7,
    cps: 2.2,
    iframeAwareness: 0.0,
    reach: 2.5,
    hitChance: 0.55,
    critSkill: 0.0,
    strafe: 0.0,
    sprintSkill: 0.15,
    wtapSkill: 0.0,
    comboSkill: 0.0,
    kbControl: 0.0,
    dodgeSkill: 0.0,
    bowSkill: 0.15,
    buildSkill: 0.0,
    healThreshold: 0.0,
    retreatSkill: 0.1,
    jitter: 0.55,
    decisionTicks: 13,
    reactionJitter: 0.45,
    lapseChance: 0.35,
    tremor: 0.55,
  },
  {
    level: 2,
    id: 'casual',
    reactionTicks: 9,
    aimError: 13,
    turnSpeed: 12,
    cps: 4.0,
    iframeAwareness: 0.2,
    reach: 2.75,
    hitChance: 0.7,
    critSkill: 0.12,
    strafe: 0.25,
    sprintSkill: 0.45,
    wtapSkill: 0.1,
    comboSkill: 0.15,
    kbControl: 0.1,
    dodgeSkill: 0.1,
    bowSkill: 0.35,
    buildSkill: 0.1,
    healThreshold: 0.25,
    retreatSkill: 0.25,
    jitter: 0.32,
    decisionTicks: 11,
    reactionJitter: 0.38,
    lapseChance: 0.22,
    tremor: 0.4,
  },
  {
    level: 3,
    id: 'skilled',
    reactionTicks: 6,
    aimError: 7,
    turnSpeed: 20,
    cps: 6.5,
    iframeAwareness: 0.5,
    reach: 2.9,
    hitChance: 0.82,
    critSkill: 0.38,
    strafe: 0.5,
    sprintSkill: 0.7,
    wtapSkill: 0.35,
    comboSkill: 0.4,
    kbControl: 0.3,
    dodgeSkill: 0.3,
    bowSkill: 0.6,
    buildSkill: 0.35,
    healThreshold: 0.4,
    retreatSkill: 0.45,
    jitter: 0.18,
    decisionTicks: 9,
    reactionJitter: 0.3,
    lapseChance: 0.12,
    tremor: 0.26,
  },
  {
    level: 4,
    id: 'expert',
    reactionTicks: 4,
    aimError: 3.2,
    turnSpeed: 32,
    cps: 9.5,
    iframeAwareness: 0.78,
    reach: 3.0,
    hitChance: 0.92,
    critSkill: 0.68,
    strafe: 0.78,
    sprintSkill: 0.9,
    wtapSkill: 0.7,
    comboSkill: 0.72,
    kbControl: 0.6,
    dodgeSkill: 0.6,
    bowSkill: 0.82,
    buildSkill: 0.65,
    healThreshold: 0.5,
    retreatSkill: 0.7,
    jitter: 0.07,
    decisionTicks: 6,
    reactionJitter: 0.22,
    lapseChance: 0.05,
    tremor: 0.15,
  },
  {
    level: 5,
    id: 'world_class',
    reactionTicks: 3,
    aimError: 1.0,
    turnSpeed: 55,
    cps: 14,
    iframeAwareness: 1.0,
    reach: 3.05,
    hitChance: 0.99,
    critSkill: 0.96,
    strafe: 1.0,
    sprintSkill: 1.0,
    wtapSkill: 1.0,
    comboSkill: 1.0,
    kbControl: 0.92,
    dodgeSkill: 0.95,
    bowSkill: 0.98,
    buildSkill: 0.95,
    healThreshold: 0.6,
    retreatSkill: 0.95,
    jitter: 0.0,
    decisionTicks: 4,
    reactionJitter: 0.16,
    lapseChance: 0.015,
    tremor: 0.07,
  },
];

export function levelProfile(level) {
  return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, Math.round(level) - 1))];
}

/* ---------------------------------------------------------------- equipment */

/**
 * Kits are plain survival inventories. Nothing here is stronger than what a player
 * can carry, which is the point: you are practising against the real thing.
 */
export const KITS = {
  none: {
    id: 'none',
    armour: [],
    mainhand: undefined,
    offhand: undefined,
    inventory: [],
  },
  sword: {
    id: 'sword',
    armour: ['minecraft:iron_helmet', 'minecraft:iron_chestplate', 'minecraft:iron_leggings', 'minecraft:iron_boots'],
    mainhand: 'minecraft:iron_sword',
    offhand: undefined,
    inventory: [{ item: 'minecraft:cobblestone', amount: 64 }],
  },
  diamond: {
    id: 'diamond',
    armour: [
      'minecraft:diamond_helmet',
      'minecraft:diamond_chestplate',
      'minecraft:diamond_leggings',
      'minecraft:diamond_boots',
    ],
    mainhand: 'minecraft:diamond_sword',
    offhand: undefined,
    enchants: {
      'minecraft:diamond_sword': [{ id: 'sharpness', level: 2 }],
      armour: [{ id: 'protection', level: 2 }],
    },
    inventory: [
      { item: 'minecraft:golden_apple', amount: 3 },
      { item: 'minecraft:cobblestone', amount: 64 },
      { item: 'minecraft:water_bucket', amount: 1 },
    ],
  },
  netherite: {
    id: 'netherite',
    armour: [
      'minecraft:netherite_helmet',
      'minecraft:netherite_chestplate',
      'minecraft:netherite_leggings',
      'minecraft:netherite_boots',
    ],
    mainhand: 'minecraft:netherite_sword',
    offhand: 'minecraft:shield',
    enchants: {
      'minecraft:netherite_sword': [{ id: 'sharpness', level: 4 }],
      armour: [{ id: 'protection', level: 4 }],
    },
    inventory: [
      { item: 'minecraft:enchanted_golden_apple', amount: 2 },
      { item: 'minecraft:golden_apple', amount: 6 },
      { item: 'minecraft:obsidian', amount: 16 },
      { item: 'minecraft:water_bucket', amount: 1 },
    ],
  },
  bow: {
    id: 'bow',
    armour: [
      'minecraft:leather_helmet',
      'minecraft:leather_chestplate',
      'minecraft:leather_leggings',
      'minecraft:leather_boots',
    ],
    mainhand: 'minecraft:bow',
    offhand: undefined,
    inventory: [
      { item: 'minecraft:arrow', amount: 64 },
      { item: 'minecraft:stone_sword', amount: 1 },
    ],
  },
  uhc: {
    id: 'uhc',
    armour: ['minecraft:iron_helmet', 'minecraft:iron_chestplate', 'minecraft:iron_leggings', 'minecraft:iron_boots'],
    mainhand: 'minecraft:diamond_sword',
    offhand: undefined,
    inventory: [
      { item: 'minecraft:bow', amount: 1 },
      { item: 'minecraft:arrow', amount: 32 },
      { item: 'minecraft:golden_apple', amount: 8 },
      { item: 'minecraft:cobblestone', amount: 64 },
      { item: 'minecraft:water_bucket', amount: 1 },
    ],
  },
};

export const KIT_ORDER = ['none', 'sword', 'diamond', 'netherite', 'bow', 'uhc'];

/* ------------------------------------------------------- weapon damage table */

/** Base melee damage on Bedrock, before enchantments and crits. */
export const WEAPON_DAMAGE = {
  'minecraft:wooden_sword': 4,
  'minecraft:golden_sword': 4,
  'minecraft:stone_sword': 5,
  'minecraft:iron_sword': 6,
  'minecraft:diamond_sword': 7,
  'minecraft:netherite_sword': 8,
  'minecraft:wooden_axe': 3,
  'minecraft:golden_axe': 3,
  'minecraft:stone_axe': 4,
  'minecraft:iron_axe': 5,
  'minecraft:diamond_axe': 6,
  'minecraft:netherite_axe': 7,
  'minecraft:trident': 9,
  'minecraft:mace': 6,
  'minecraft:wooden_pickaxe': 2,
  'minecraft:stone_pickaxe': 3,
  'minecraft:iron_pickaxe': 4,
  'minecraft:diamond_pickaxe': 5,
  'minecraft:netherite_pickaxe': 6,
  'minecraft:wooden_shovel': 2,
  'minecraft:stone_shovel': 3,
  'minecraft:iron_shovel': 4,
  'minecraft:diamond_shovel': 5,
  'minecraft:netherite_shovel': 6,
};

/** Unarmed damage. */
export const FIST_DAMAGE = 1;
/** Bedrock sharpness bonus per level. */
export const SHARPNESS_PER_LEVEL = 1.25;
/** Bedrock critical hit multiplier. */
export const CRIT_MULTIPLIER = 1.5;

/* ----------------------------------------------------------- default settings */

export const DEFAULT_SETTINGS = {
  /** Interface / message language: 'ja' or 'en'. */
  language: 'ja',
  /** Maximum number of bots that may exist at once. */
  maxBots: 10,
  /** Bots re-spawn at their arena point after dying. */
  respawn: true,
  /** Delay before a re-spawn, in ticks. */
  respawnDelay: 60,
  /** How far a bot looks for a target, in blocks. */
  targetRange: 32,
  /** Bots ignore players in creative / spectator. */
  ignoreCreative: true,
  /** Bots will fight each other as well as players. */
  botVsBot: false,
  /** Bots may place and break blocks (clutching, towering, MLG). */
  allowBuilding: true,
  /** Blocks placed by bots are cleaned up when they die. */
  cleanupBlocks: true,
  /** Show the live practice HUD on the action bar. */
  hud: true,
  /** Append " [Lv3]" to the nameplate. Off by default so it reads exactly "Steve". */
  showLevelInName: false,
  /** Name every bot uses. */
  botName: 'Steve',
  /** Global knockback multiplier applied to hits the bot lands, for tuning. */
  knockbackScale: 1.0,
};

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
