/**
 * Animation bridge.
 *
 * The bot plays the *vanilla* humanoid animations rather than custom ones, so its arm swing
 * and its eating pose are pixel-identical to a player's. Those animations are driven by
 * Molang variables the engine normally sets itself:
 *
 *   controller.animation.humanoid.attack             plays while `variable.attack_time >= 0`
 *   controller.animation.humanoid.use_item_progress  plays while `variable.use_item_startup_progress > 0`
 *
 * Script cannot write Molang variables, but it can write entity properties, and the resource
 * pack's `pre_animation` copies those properties into the variables. This module owns the
 * server side of that bridge.
 */

import { record } from './diagnostics.js';
import { safe } from './util.js';

export const USING_NONE = 0;
export const USING_ITEM = 1;
export const USING_BOW = 2;

/** How long the client plays the swing for, in ticks. Matches the 0.3 s in pre_animation. */
export const SWING_TICKS = 6;

let probed = false;

function probe(entity) {
  if (probed) return;
  probed = true;
  const ok =
    safe(() => {
      entity.setProperty('pvp:swing_id', 1);
      return entity.getProperty('pvp:swing_id') !== undefined;
    }, false) ?? false;
  record(
    'anim.properties',
    ok,
    ok ? 'entity properties drive the vanilla swing/eat animations' : 'entity properties unavailable - no swing animation'
  );
}

/**
 * Triggers one arm swing. The property is an incrementing id rather than a per-tick progress
 * value: the resource pack notices the id changed and times the swing from `query.life_time`,
 * which means one property write per swing instead of one per tick.
 */
export function playSwing(entity) {
  probe(entity);
  safe(() => {
    const current = Number(entity.getProperty('pvp:swing_id') ?? 0);
    entity.setProperty('pvp:swing_id', (current + 1) % 16);
  });
}

/** Sets the "is using an item" pose: eating a golden apple, or drawing a bow. */
export function setUsing(entity, mode) {
  safe(() => {
    if (Number(entity.getProperty('pvp:using') ?? 0) === mode) return;
    entity.setProperty('pvp:using', mode);
  });
}
