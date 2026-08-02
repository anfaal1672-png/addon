/**
 * Human factors.
 *
 * Everything in here exists to stop the bot behaving like a program that happens to be
 * shaped like a player. A program reacts on the tick the stimulus arrives, aims by moving
 * exactly the right amount, holds perfectly still when it has nothing to do, and performs
 * identically on second three and second three hundred. People do none of that.
 *
 * Two different latencies are modelled, because they are genuinely different systems:
 *
 *   tracking  - smooth pursuit. Following something you are already watching is fast and
 *               continuous, a fraction of a choice reaction.
 *   decision  - choice reaction time. Noticing a *new* thing and picking a response takes
 *               roughly 200 ms even for a trained player, and 500-600 ms for a novice.
 *
 * On top of that: attention lapses, slow performance drift, tilt after being hit, warm-up at
 * the start of a fight, aim that overshoots and corrects rather than gliding, and a hand that
 * never quite stops moving.
 */

import { clamp, gauss, rand, randRange } from './util.js';

/**
 * Samples a reaction time.
 *
 * Human reaction times are not symmetric: they cluster near a floor and trail off into
 * occasional very slow responses, so this is drawn log-normally rather than from a bell
 * curve. `jitter` is the spread as a fraction of the mean.
 */
export function sampleLatency(meanTicks, jitter = 0.35) {
  const normal = gauss() * 1.4;
  const scaled = meanTicks * Math.exp(normal * jitter - (jitter * jitter) / 2);
  return Math.max(1, scaled);
}

/**
 * A stimulus that only becomes available after a delay.
 *
 * Push what is true now; read what the bot is entitled to know now. Values are kept in
 * order, so a slow reaction never lets a newer observation arrive before an older one.
 */
export class Delayed {
  constructor(initial = undefined) {
    /** @type {{at: number, value: unknown}[]} */
    this.queue = [];
    this.current = initial;
    this.lastReleaseAt = -Infinity;
  }

  push(tick, value, latencyTicks) {
    const at = Math.max(tick + latencyTicks, this.lastReleaseAt + 1);
    this.queue.push({ at, value });
  }

  read(tick) {
    while (this.queue.length && this.queue[0].at <= tick) {
      const entry = this.queue.shift();
      this.current = entry.value;
      this.lastReleaseAt = entry.at;
    }
    return this.current;
  }

  get pending() {
    return this.queue.length > 0;
  }

  clear() {
    this.queue.length = 0;
  }
}

/**
 * The per-bot state that makes one bot's reactions differ from another's, and from its own
 * a minute earlier.
 */
export class HumanState {
  /** @param {import('./config.js').LevelProfile} profile */
  constructor(profile) {
    this.profile = profile;

    // Everyone has a slightly different baseline. Two level 4 bots are not the same player.
    this.personalBias = randRange(0.85, 1.15);

    // Slow performance drift, the reason your aim is better in one minute than the next.
    this.driftPhase = randRange(0, Math.PI * 2);
    this.driftPeriod = randRange(500, 1400);

    this.lapseUntil = -1;
    this.lapseCheckedTick = -1;
    this.tiltUntil = -1;
    this.engagedAt = -Infinity;
  }

  setProfile(profile) {
    this.profile = profile;
  }

  /** Called once per tick before anything reads the state. */
  update(tick) {
    // Attention lapses: a short window where everything is noticeably slower. Rare and brief
    // for a strong player, frequent for a weak one.
    if (tick !== this.lapseCheckedTick) {
      this.lapseCheckedTick = tick;
      if (tick > this.lapseUntil && rand() < this.profile.lapseChance / 20) {
        this.lapseUntil = tick + Math.round(randRange(6, 20));
      }
    }
  }

  /** Called when the bot starts paying attention to a new opponent. */
  engage(tick) {
    this.engagedAt = tick;
  }

  /** Called when the bot takes a hit: getting beaten on makes people worse, not better. */
  rattle(tick, severity = 1) {
    this.tiltUntil = Math.max(this.tiltUntil, tick + Math.round(20 * severity * (1 - this.profile.retreatSkill * 0.5)));
  }

  /**
   * Multiplier applied to every latency and error this tick. 1.0 is this bot on form.
   */
  formFactor(tick) {
    let f = this.personalBias;

    // Slow sinusoidal drift.
    f *= 1 + 0.14 * Math.sin((tick / this.driftPeriod) * Math.PI * 2 + this.driftPhase);

    // Warm-up: the first second of an engagement is worse than the rest of it.
    const sinceEngage = tick - this.engagedAt;
    if (sinceEngage < 20) f *= 1 + 0.35 * (1 - sinceEngage / 20);

    // Tilt after being hit.
    if (tick < this.tiltUntil) f *= 1.25;

    // Attention lapse.
    if (tick < this.lapseUntil) f *= 2.2;

    return f;
  }

  /**
   * Choice reaction time for a discrete event, in ticks.
   *
   * Floored at 3 ticks (150 ms). Elite human choice reaction is 150-200 ms and nothing gets
   * under it, so no combination of level tuning and lucky sampling may either.
   */
  decisionLatency(tick) {
    return Math.max(3, sampleLatency(this.profile.decisionTicks * this.formFactor(tick), this.profile.reactionJitter));
  }

  /**
   * Smooth-pursuit lag for something already being watched, in ticks.
   *
   * Floored at 2 ticks (100 ms), which is where human smooth pursuit bottoms out.
   */
  trackingLatency(tick) {
    return Math.max(
      2,
      sampleLatency(this.profile.reactionTicks * this.formFactor(tick), this.profile.reactionJitter * 0.6)
    );
  }
}

/**
 * One axis of aim.
 *
 * A linear tracker - move `turnSpeed` degrees towards the target every tick - is the giveaway
 * that gave the old bot away: it converges perfectly and never overshoots. Real aim is a
 * ballistic throw followed by corrections, so this is a spring-damper with momentum. Low
 * skill means a loose spring and weak damping, which produces exactly the overshoot-and-
 * correct wobble a person makes; high skill means crisp, but never quite critically damped.
 *
 * `tremor` is the small, constant hand movement nobody can switch off.
 */
export class AimAxis {
  constructor(value = 0, { wrap = false } = {}) {
    this.value = value;
    this.velocity = 0;
    this.wrap = wrap;
  }

  step(target, { maxSpeed, stiffness, damping, tremor }) {
    const error = this.wrap ? shortestAngle(this.value, target) : target - this.value;

    const accel = error * stiffness - this.velocity * damping + gauss() * tremor;
    this.velocity = clamp(this.velocity + accel, -maxSpeed, maxSpeed);
    this.value += this.velocity;

    if (this.wrap) {
      while (this.value > 180) this.value -= 360;
      while (this.value < -180) this.value += 360;
    }
    return this.value;
  }
}

function shortestAngle(from, to) {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * Aim tuning derived from the level profile, so there is one place to reason about how a
 * given skill level's hand behaves rather than five sets of magic numbers.
 */
export function aimTuning(profile, form) {
  const skill = 1 - profile.jitter;
  return {
    maxSpeed: profile.turnSpeed,
    // A loose spring with weak damping overshoots and hunts; a stiff, well damped one snaps on.
    stiffness: (0.10 + 0.22 * skill) / Math.max(form, 0.5),
    damping: 0.30 + 0.40 * skill,
    tremor: profile.tremor * form,
  };
}
