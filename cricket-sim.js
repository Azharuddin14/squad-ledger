/**
 * cricket-sim.js — an original, from-scratch cricket match simulator.
 *
 * Not derived from PCCS or any other simulator's code or data — the
 * probability model below is built from scratch using well-known
 * public T20 scoring patterns (roughly: ~36% dot balls, ~30% singles,
 * ~16% boundaries, ~10% wickets per ball as a league-average baseline)
 * and then adjusted by simple, transparent multipliers for skill,
 * traits, pitch, and match situation. Every number here is ours to
 * read, tune, and change.
 *
 * Usage:
 *   node cricket-sim.js            -> runs a demo match and prints a scorecard
 *   const sim = require('./cricket-sim.js');  -> use programmatically
 */

// ---------- player / pitch shapes ----------
// Player: {
//   name, batting: 0-100, bowling: 0-100,
//   battingSkill, bowlingSkill,
//   battingHand: "Right-handed" | "Left-handed",
//   bowlingStyle: one of BOWLING_STYLES (see below) — "None" or "Does Not Bowl" for non-bowlers
// }
// Pitch:  { speed, grip, bounce, variation, deterioration } each 0-10

// Baseline per-ball outcome mix for an average T20 matchup, grounded in
// real-world figures: ~35-40% dot balls, ~30% singles, ~14-15% boundaries,
// and critically, a wicket roughly every 20 balls (~5%) — even elite
// bowlers sit around 1 wicket per 18 balls, not 1 in 10.
const BASE_PROBS = { 0: 0.395, 1: 0.317, 2: 0.074, 3: 0.011, 4: 0.113, 6: 0.05, W: 0.04 };

const BATTING_SKILLS = ["None", "Compulsive Slogger", "Finisher", "Specialist Batsman", "Pinch Hitter"];
const BOWLING_SKILLS = ["None", "New Ball Bowler", "Death/Old Ball Bowler", "Mystery Spinner", "Specialist Bowler"];
const BATTING_HANDS = ["Right-handed", "Left-handed"];
const BOWLING_STYLES = [
  "None",
  "Right Arm Fast", "Left Arm Fast",
  "Right Arm Fast Medium", "Left Arm Fast Medium",
  "Right Arm Medium", "Left Arm Medium",
  "Right Arm Off Break", "Slow Left Arm Orthodox",
  "Right Arm Leg Spin", "Left Arm Chinaman",
  "Does Not Bowl",
];

// dismissal modes used when a ball's outcome is "W"
const DISMISSAL_MODES = ["Bowled", "Caught", "LBW", "Stumped", "Run Out"];

// a player counts as bowling-eligible above this rating; teams short of
// eligible bowlers fall back to their next-best-rated players so an
// innings can always be legally completed
const BOWLING_ELIGIBLE_MIN = 25;

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

/**
 * Rolls a per-innings "day factor" for the batting side — real cricket
 * (and any well-tuned simulator) has more variance than pure ball-by-ball
 * independence produces: some days a batting lineup just clicks and every
 * mishit finds a gap, other days nothing comes off the bat. This is a
 * mixture distribution (not a flat uniform spread) so genuinely exceptional
 * or genuinely poor days are rarer than ordinary ones, but they do happen.
 */
function rollBattingDayFactor() {
  const r = Math.random();
  if (r < 0.08) return 1.15 + Math.random() * 0.18; // hot day, ~8% chance: 1.15-1.33
  if (r < 0.16) return 0.68 + Math.random() * 0.17; // cold day, ~8% chance: 0.68-0.85
  return 0.90 + Math.random() * 0.20; // ordinary day, ~84% chance: 0.90-1.10
}
const SPIN_STYLE_NAMES = ["Right Arm Off Break", "Slow Left Arm Orthodox", "Right Arm Leg Spin", "Left Arm Chinaman"];
function isSpin(style) { return SPIN_STYLE_NAMES.includes(style); }

function normalize(p) {
  const total = Object.values(p).reduce((a, b) => a + b, 0);
  const out = {};
  for (const k in p) out[k] = p[k] / total;
  return out;
}

/**
 * Computes the outcome probability distribution for a single ball.
 * This is the core "rating model" — every multiplier here is a
 * deliberate, documented design choice, not extracted from anywhere.
 */
function getBallProbabilities({ batter, bowler, pitch, over, totalOvers, wicketsDown, runRateNeeded, currentRunRate, batterBallsFaced, battingDayFactor, partner, batterRunsSoFar }) {
  let p = { ...BASE_PROBS };

  // 1. Skill differential: batting rating vs bowling rating, -1..1
  const skillDiff = (batter.batting - bowler.bowling) / 50; // calibrated to the 50-100 rating range in actual use
  p.W *= clamp(1 - skillDiff * 0.6, 0.4, 1.7);
  p[4] *= clamp(1 + skillDiff * 0.5, 0.5, 1.9);
  p[6] *= clamp(1 + skillDiff * 0.6, 0.4, 2.1);
  p[0] *= clamp(1 - skillDiff * 0.3, 0.55, 1.45);

  // 2. Batting special skills — deviations from baseline amplified ~1.35x
  // so a named skill actually feels like a real, noticeable trait rather
  // than a marginal nudge.
  const earlyPhase = over < totalOvers * 0.3;
  const deathPhase = over >= totalOvers - 4;
  if (batter.battingSkill === "Compulsive Slogger") {
    // mishits off the middle still often beat the field for a single —
    // this is a low-percentage, high-reward slogger, not a total gambler
    p[4] *= 1.27; p[6] *= 1.61; p.W *= 1.34; p[0] *= 0.80; p[1] *= 1.14;
  } else if (batter.battingSkill === "Specialist Batsman") {
    // the premier batting skill — a genuine white-ball specialist, strong
    // across the board with no real trade-off, unlike the situational traits
    p[0] *= 0.84; p[1] *= 1.07; p[4] *= 1.20; p[6] *= 1.27; p.W *= 0.73;
  } else if (batter.battingSkill === "Finisher") {
    if (deathPhase) {
      p[4] *= 1.20; p[6] *= 1.47; p.W *= 1.14; p[0] *= 0.87;
    } else {
      // not their moment yet — actively anchors the innings, rotating
      // strike with 1s and 2s rather than just playing risk-free dots,
      // saving the real aggression for when it actually matters
      p.W *= 0.80; p[4] *= 0.87; p[6] *= 0.80; p[0] *= 1.03; p[1] *= 1.14; p[2] *= 1.14;
    }
  } else if (batter.battingSkill === "Pinch Hitter") {
    // a lower-order basher, not a powerplay-promotion tactic — real examples
    // (Starc, Cummins, Shaheen, Shadab) mostly bat in the middle/death overs,
    // not the powerplay, so this is always-on rather than phase-gated.
    // Deliberately more boom-or-bust than Compulsive Slogger — "very
    // inconsistent" — higher wicket risk for a similar boundary payoff.
    p[4] *= 1.27; p[6] *= 1.54; p.W *= 1.54; p[0] *= 0.76;
  }

  // 3. Bowling special skills — same amplification applied
  if (bowler.bowlingSkill === "Specialist Bowler") {
    // the premier bowling skill — a genuine white-ball specialist, strong
    // across the board with no real trade-off
    p.W *= 1.34; p[0] *= 1.14; p[4] *= 0.84; p[6] *= 0.80;
  } else if (bowler.bowlingSkill === "New Ball Bowler") {
    if (earlyPhase) {
      p[0] *= 1.20; p.W *= 1.27; p[4] *= 0.80; p[6] *= 0.73;
    } else if (deathPhase) {
      // out of their specialty this late — no fresh-ball swing left to lean on
      p[4] *= 1.16; p[6] *= 1.20; p.W *= 0.87;
    }
  } else if (bowler.bowlingSkill === "Death/Old Ball Bowler") {
    if (deathPhase) {
      p[4] *= 0.73; p[6] *= 0.66; p.W *= 1.27; p[0] *= 1.14;
    } else if (earlyPhase) {
      // no fresh-ball movement to exploit this early — their tricks are built for later
      p[4] *= 1.14; p[6] *= 1.14; p.W *= 0.87;
    }
  } else if (bowler.bowlingSkill === "Mystery Spinner" && isSpin(bowler.bowlingStyle)) {
    if (deathPhase) {
      // if a batter's picked the variation, there's no fallback plan —
      // the trick either lands or it gets punished
      p.W *= 1.07; p[6] *= 1.41; p[4] *= 1.20; p[0] *= 0.87;
    } else {
      p.W *= 1.27; p[6] *= 1.14; p[0] *= 1.07; p[4] *= 0.93;
    }
  }

  // 4. Pitch: pace bowlers lean on speed/bounce, spinners lean on
  // grip/variation. "Deterioration" makes the pitch progressively
  // more bowler-friendly as the innings wears on.
  const paceStyle = bowler.bowlingStyle !== "None" && bowler.bowlingStyle !== "Does Not Bowl" && !isSpin(bowler.bowlingStyle);
  const spinStyle = isSpin(bowler.bowlingStyle);
  if (paceStyle) {
    const paceFactor = (pitch.speed + pitch.bounce) / 20; // 0..1
    p.W *= clamp(0.7 + paceFactor * 0.6, 0.7, 1.3);
    p[4] *= clamp(0.8 + (pitch.speed / 10) * 0.4, 0.8, 1.2);
    p[6] *= clamp(0.75 + (pitch.speed / 10) * 0.5, 0.75, 1.25);
  } else if (spinStyle) {
    const spinFactor = (pitch.grip + pitch.variation) / 20; // 0..1
    p.W *= clamp(0.7 + spinFactor * 0.65, 0.7, 1.35);
    p[0] *= clamp(0.85 + spinFactor * 0.3, 0.85, 1.15);
    p[4] *= clamp(1.15 - spinFactor * 0.3, 0.85, 1.15); // a helpful pitch chokes off boundaries
  }

  const wearProgress = over / totalOvers; // 0 at start, 1 at the end
  const wearFactor = 1 + (pitch.deterioration / 10) * wearProgress * 0.3;
  p.W *= wearFactor;
  p[4] *= clamp(1 - (pitch.deterioration / 10) * wearProgress * 0.2, 0.8, 1);

  // 5. New-batter settling-in effect: real batters are visibly more
  // dismissal-prone and less fluent on their first handful of balls —
  // "getting your eye in" — tapering off to normal by ~7 balls faced.
  // Kept modest: this stacks with skill/pitch/skill multipliers already
  // applied above, and probabilities are normalized afterward, so even a
  // moderate per-factor bump compounds into a much larger effective swing.
  if (batterBallsFaced != null && batterBallsFaced < 7) {
    const settleFactor = (7 - batterBallsFaced) / 7; // 1.0 on ball 0, fading to 0 by ball 7
    p.W *= 1 + settleFactor * 0.22;
    p[4] *= 1 - settleFactor * 0.15;
    p[6] *= 1 - settleFactor * 0.22;
    p[0] *= 1 + settleFactor * 0.08;
  }

  // 6. Match situation — mirrors the "consolidate" idea: batting sides
  // bat safer once too many wickets are down, and push harder when
  // chasing a required rate well above the current one.
  if (wicketsDown >= 7) {
    p[4] *= 0.7; p[6] *= 0.5; p.W *= 0.75; p[0] *= 1.2; p[1] *= 1.1;
  }
  if (runRateNeeded != null && currentRunRate != null && runRateNeeded > currentRunRate * 1.4) {
    p[4] *= 1.25; p[6] *= 1.4; p.W *= 1.25; p[0] *= 0.8;
  }

  // 7. Past a half-century, a set batter cashes in — real T20 batters who've
  // got their eye in and reached a landmark accelerate, since they've
  // already proven themselves and can now capitalize while they're in.
  if (batterRunsSoFar != null && batterRunsSoFar >= 50) {
    p[4] *= 1.28; p[6] *= 1.45; p[0] *= 0.82; p.W *= 1.05;
  }

  // 8. Partnership dynamics — if the partner at the other end is already
  // scoring quickly (or built for aggression), this batter leans toward
  // anchoring; if the partner is quiet (or built to anchor), this batter
  // leans toward keeping the rate ticking instead. A modest complement to
  // personal skill, not a dominant factor — matches how real batting
  // orders naturally split into one settled, one accelerating.
  if (partner) {
    const partnerAggressive = partner.battingSkill === "Compulsive Slogger" || partner.battingSkill === "Pinch Hitter";
    const partnerAnchor = partner.battingSkill === "Specialist Batsman";
    const partnerSR = partner.balls >= 6 ? (partner.runs / partner.balls) * 100 : null;
    let lean = 0; // +1 = this batter anchors more, -1 = this batter accelerates more
    if (partnerAggressive || (partnerSR != null && partnerSR >= 145)) lean = 1;
    else if (partnerAnchor || (partnerSR != null && partnerSR <= 85)) lean = -1;
    if (lean === 1) {
      p.W *= 0.93; p[4] *= 0.93; p[6] *= 0.9; p[0] *= 1.05; p[1] *= 1.05;
    } else if (lean === -1) {
      p.W *= 1.05; p[4] *= 1.08; p[6] *= 1.1; p[0] *= 0.95;
    }
  }

  // 9. Per-innings "day factor" — some days a lineup just clicks, other
  // days nothing comes off the bat. Applied last, after every situational
  // adjustment, so it scales the whole ball outcome rather than fighting
  // with any one factor above.
  if (battingDayFactor != null) {
    const f = battingDayFactor;
    p[4] *= clamp(1 + (f - 1) * 1.2, 0.55, 1.9);
    p[6] *= clamp(1 + (f - 1) * 1.5, 0.45, 2.2);
    p.W *= clamp(1 - (f - 1) * 0.5, 0.55, 1.6);
    p[0] *= clamp(1 - (f - 1) * 0.35, 0.65, 1.4);
  }

  return normalize(p);
}

function pickOutcome(probs) {
  const r = Math.random();
  let acc = 0;
  for (const key of Object.keys(probs)) {
    acc += probs[key];
    if (r <= acc) return key === "W" ? "W" : Number(key);
  }
  return 0; // fallback (rounding safety)
}

/**
 * Decides how a wicket fell. Run outs aren't credited to the bowler;
 * stumpings only happen off spin bowling.
 */
function pickDismissal(bowler, hasKeeper) {
  const spin = isSpin(bowler.bowlingStyle);
  const stumpedShare = (spin && hasKeeper) ? 0.08 : 0; // stumpings need a keeper standing up
  const weights = { Bowled: 0.20, Caught: 0.55, LBW: 0.12, Stumped: stumpedShare, "Run Out": 0.05 };
  if (stumpedShare === 0) weights.Caught += 0.08; // redistribute the zeroed-out Stumped share
  const norm = normalize(weights);
  const r = Math.random();
  let acc = 0;
  for (const mode of Object.keys(norm)) {
    acc += norm[mode];
    if (r <= acc) return mode;
  }
  return "Caught";
}

/**
 * Picks which bowler bowls the next over, weighted by bowling rating
 * and a phase bonus for New Ball / Death specialists. Excludes anyone
 * already at their over cap or who bowled the immediately preceding over.
 */
/** Pure weighted pick from a candidate pool — rating plus phase/style fit
 * (seamers early and at the death, spin through the middle), with a named
 * skill stacking an extra boost on top. */
function pickWeightedBowler(candidates, over, totalOvers, lastOverRuns) {
  const earlyPhase = over < totalOvers * 0.3;
  const deathPhase = over >= totalOvers - 4;
  const middlePhase = !earlyPhase && !deathPhase;
  const weights = candidates.map(b => {
    // squaring the rating sharpens the gap between genuine frontline bowlers
    // and part-timers, so a captain's best options dominate selection
    // instead of every non-capped bowler getting a roughly similar share
    let w = Math.max(1, b.bowling) ** 2;
    const isPace = b.bowlingStyle !== "None" && b.bowlingStyle !== "Does Not Bowl" && !isSpin(b.bowlingStyle);
    const isSp = isSpin(b.bowlingStyle);
    if (earlyPhase) { if (isPace) w *= 1.7; if (isSp) w *= 0.3; }
    else if (middlePhase) { if (isSp) w *= 1.6; if (isPace) w *= 0.7; }
    else if (deathPhase) { if (isPace) w *= 1.6; if (isSp) w *= 0.6; }
    if (b.bowlingSkill === "Specialist Bowler") w *= 1.6; // a genuine frontline threat, bowled more in every phase
    if (b.bowlingSkill === "New Ball Bowler" && earlyPhase) w *= 1.5;
    if (b.bowlingSkill === "Death/Old Ball Bowler" && deathPhase) w *= 1.5;
    // a genuine death specialist gets held back outside the death overs —
    // a captain saves their closer rather than burning them at over 9
    if (b.bowlingSkill === "Death/Old Ball Bowler" && !deathPhase) w *= 0.18;
    // a bowler who was smashed recently gets a cooling-off period — this
    // persists beyond their immediate spell, unlike the spell-continuation
    // check, matching a captain's real reluctance to bring someone straight
    // back after conceding heavily
    if (lastOverRuns && lastOverRuns.has(b)) {
      const runs = lastOverRuns.get(b);
      if (runs >= 14) w *= 0.35;
      else if (runs >= 10) w *= 0.6;
    }
    return w;
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * totalWeight;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

/**
 * Chooses who bowls the next over: seamers open the powerplay, spin takes
 * the middle overs, pace returns at the death — but whoever bowled the
 * previous over is always excluded first, before any type preference,
 * so the same bowler can never go two overs in a row.
 */
function chooseBowlerForOver({ eligible, oversBowledMap, over, totalOvers, powerplayUsed, lastOverBowler, lastOverRuns }) {
  const capped = b => (oversBowledMap.get(b) || 0) >= Math.max(1, Math.ceil(totalOvers / 5));
  const isPowerplay = over < Math.min(4, totalOvers);
  const isPaceStyle = b => b.bowlingStyle !== "None" && b.bowlingStyle !== "Does Not Bowl" && !isSpin(b.bowlingStyle);

  // Builds the candidate pool, in priority order: preferred-type-and-fresh,
  // then any-type-and-fresh (never repeat the last bowler if at all
  // avoidable — that outranks the type preference), then preferred-type
  // allowing a repeat, then anyone at all as an absolute last resort.
  // The "not the previous over's bowler" filter is applied at every tier
  // except the very last, so a repeat only ever happens if truly no one
  // else can bowl (e.g. a team with only one usable bowler left).
  function buildPool(preferred, extraFreshFilter) {
    const notCapped = b => !capped(b);
    const notLast = b => b !== lastOverBowler;
    const fresh = extraFreshFilter || (() => true);
    let pool = preferred.filter(b => notCapped(b) && notLast(b) && fresh(b));
    if (pool.length) return pool;
    pool = preferred.filter(b => notCapped(b) && notLast(b));
    if (pool.length) return pool;
    pool = eligible.filter(b => notCapped(b) && notLast(b));
    if (pool.length) return pool;
    pool = preferred.filter(notCapped);
    if (pool.length) return pool;
    pool = eligible.filter(notCapped);
    if (pool.length) return pool;
    return eligible;
  }

  if (isPowerplay) {
    // powerplay is seam bowling first — spinners only come in if the team
    // genuinely has no pace option left
    const pacePool = eligible.filter(isPaceStyle);
    const preferred = pacePool.length > 0 ? pacePool : eligible;
    const pool = buildPool(preferred, b => !powerplayUsed.has(b));
    const bowler = pickWeightedBowler(pool, over, totalOvers, lastOverRuns);
    powerplayUsed.add(bowler);
    return { bowler };
  }

  // middle and death overs: type is a strong weighted *preference* (handled
  // inside pickWeightedBowler's phase multipliers), not a hard restriction —
  // unlike the powerplay, a clearly superior off-type bowler can still win
  // the over here, which is what stops a weak part-time spinner from
  // hoovering up overs just because a team is short on quality spin options
  let pool = eligible.filter(b => !capped(b) && b !== lastOverBowler);
  if (pool.length === 0) pool = eligible.filter(b => !capped(b));
  if (pool.length === 0) pool = eligible;
  const bowler = pickWeightedBowler(pool, over, totalOvers, lastOverRuns);
  return { bowler };
}

/** Selects which players are allowed to bowl, falling back gracefully
 * if a team doesn't have enough recognized bowlers to cover the overs. */
function getEligibleBowlers(bowlingTeam, totalOvers) {
  const maxOversPerBowler = Math.max(1, Math.ceil(totalOvers / 5));
  const minBowlersNeeded = Math.ceil(totalOvers / maxOversPerBowler);
  const canBowl = bowlingTeam.filter(p => p.bowlingStyle !== "Does Not Bowl");
  const byRating = [...canBowl].sort((a, b) => b.bowling - a.bowling);
  let eligible = byRating.filter(p => p.bowling >= BOWLING_ELIGIBLE_MIN);
  if (eligible.length < minBowlersNeeded) {
    eligible = byRating.slice(0, Math.max(minBowlersNeeded, eligible.length));
  }
  if (eligible.length === 0) eligible = [...bowlingTeam].sort((a, b) => b.bowling - a.bowling); // last-resort fallback only
  return { eligible, maxOversPerBowler };
}

/**
 * Simulates one full innings.
 * battingTeam / bowlingTeam: arrays of players in batting/bowling order.
 * target: if chasing, the number of runs needed to win (null if batting first).
 */
function simulateInnings({ battingTeam, bowlingTeam, pitch, totalOvers, target }) {
  let runs = 0, wickets = 0;
  let strikerIdx = 0, nonStrikerIdx = 1;
  const battingLog = battingTeam.map(p => ({ name: p.name, runs: 0, balls: 0, fours: 0, sixes: 0, out: false, dismissal: null }));
  const bowlingLog = bowlingTeam.map(p => ({ name: p.name, overs: 0, runs: 0, wickets: 0, maidens: 0 }));
  const fallOfWickets = [];
  const timeline = [];
  const oversSummary = [];
  let extras = 0;
  const battingDayFactor = rollBattingDayFactor();
  const extrasByType = { wide: 0, noball: 0, bye: 0 };

  const { eligible, maxOversPerBowler } = getEligibleBowlers(bowlingTeam, totalOvers);
  let ballsBowled = 0;
  const bowlerBallsSelf = new Map();
  const bowlerFullOvers = new Map();
  const powerplayUsed = new Set();
  let lastOverBowler = null;
  const lastOverRuns = new Map();

  const WIDE_CHANCE = 0.038;
  const NOBALL_CHANCE = 0.011;
  const BYE_CHANCE = 0.02; // only rolled when the underlying delivery would otherwise be a dot

  for (let over = 0; over < totalOvers && wickets < 10 && strikerIdx < battingTeam.length && (target == null || runs < target); over++) {
    const choice = chooseBowlerForOver({ eligible, oversBowledMap: bowlerFullOvers, over, totalOvers, powerplayUsed, lastOverBowler, lastOverRuns });
    const bowler = choice.bowler;
    const bowlerLog = bowlingLog[bowlingTeam.indexOf(bowler)];
    if (!bowlerBallsSelf.has(bowler)) bowlerBallsSelf.set(bowler, 0);
    let runsThisOver = 0;
    let legalBalls = 0;
    let freeHit = false;

    while (legalBalls < 6 && wickets < 10 && strikerIdx < battingTeam.length && (target == null || runs < target)) {
      const batter = battingTeam[strikerIdx];
      const batterLog = battingLog[strikerIdx];
      const oversLeft = totalOvers - over - legalBalls / 6;
      const runRateNeeded = target != null ? ((target - runs) / oversLeft) : null;
      const currentRunRate = ballsBowled > 0 ? runs / (ballsBowled / 6) : 0;

      const extraRoll = Math.random();
      // a Mystery Spinner's variations occasionally go astray — their
      // unpredictability cuts both ways, costing them in extras sometimes
      const effectiveWideChance = bowler.bowlingSkill === "Mystery Spinner" ? WIDE_CHANCE * 1.6 : WIDE_CHANCE;

      if (extraRoll < effectiveWideChance) {
        runs += 1; extras += 1; extrasByType.wide += 1; bowlerLog.runs += 1; runsThisOver += 1;
        timeline.push({
          over: over + 1, ball: legalBalls + 1, bowlerName: bowler.name, batterName: batter.name,
          isWicket: false, runs: 1, score: runs, wickets, extra: "wide",
          commentary: `${bowler.name} to ${batter.name}, WIDE.`,
        });
        continue; // re-bowl — doesn't count as a legal delivery
      }

      if (extraRoll < effectiveWideChance + NOBALL_CHANCE) {
        runs += 1; extras += 1; extrasByType.noball += 1; bowlerLog.runs += 1; runsThisOver += 1;
        const probs = getBallProbabilities({
          batter, bowler, pitch, over, totalOvers,
          wicketsDown: wickets, runRateNeeded, currentRunRate, batterBallsFaced: batterLog.balls, battingDayFactor,
          partner: battingTeam[nonStrikerIdx] ? { battingSkill: battingTeam[nonStrikerIdx].battingSkill, runs: battingLog[nonStrikerIdx].runs, balls: battingLog[nonStrikerIdx].balls } : null,
          batterRunsSoFar: batterLog.runs,
        });
        let bonusOutcome = pickOutcome(probs);
        if (bonusOutcome === "W") bonusOutcome = 0; // no conventional dismissal off a no-ball
        runs += bonusOutcome; batterLog.runs += bonusOutcome; bowlerLog.runs += bonusOutcome; runsThisOver += bonusOutcome;
        if (bonusOutcome === 4) batterLog.fours += 1;
        if (bonusOutcome === 6) batterLog.sixes += 1;
        timeline.push({
          over: over + 1, ball: legalBalls + 1, bowlerName: bowler.name, batterName: batter.name,
          isWicket: false, runs: 1 + bonusOutcome, score: runs, wickets, extra: "noball",
          commentary: `${bowler.name} to ${batter.name}, NO BALL${bonusOutcome ? ` + ${bonusOutcome}` : ""}. Free hit next.`,
        });
        freeHit = true;
        continue; // re-bowl — doesn't count as a legal delivery
      }

      // legal delivery
      ballsBowled++;
      batterLog.balls++;
      bowlerBallsSelf.set(bowler, bowlerBallsSelf.get(bowler) + 1);
      const selfBalls = bowlerBallsSelf.get(bowler);
      bowlerLog.overs = Math.floor(selfBalls / 6) + (selfBalls % 6) / 10;

      const probs = getBallProbabilities({
        batter, bowler, pitch, over, totalOvers,
        wicketsDown: wickets, runRateNeeded, currentRunRate, batterBallsFaced: batterLog.balls - 1, battingDayFactor,
        partner: battingTeam[nonStrikerIdx] ? { battingSkill: battingTeam[nonStrikerIdx].battingSkill, runs: battingLog[nonStrikerIdx].runs, balls: battingLog[nonStrikerIdx].balls } : null,
        batterRunsSoFar: batterLog.runs,
      });
      let outcome = pickOutcome(probs);
      const wasFreeHit = freeHit;
      freeHit = false;

      if (outcome === "W" && wasFreeHit) {
        outcome = 0; // free hit — no conventional dismissal, batter survives
      }

      if (outcome === "W") {
        wickets++;
        batterLog.out = true;
        const keeper = bowlingTeam.find(p => p.isWicketKeeper);
        const mode = pickDismissal(bowler, !!keeper);
        const creditsBowler = mode !== "Run Out";
        if (creditsBowler) bowlerLog.wickets++;
        let fielder = null;
        if (mode === "Caught") {
          const fielderPool = bowlingTeam.filter(p => p !== bowler);
          fielder = (fielderPool.length ? fielderPool[Math.floor(Math.random() * fielderPool.length)] : bowler).name;
        } else if (mode === "Run Out") {
          const fielderPool = bowlingTeam;
          fielder = fielderPool[Math.floor(Math.random() * fielderPool.length)].name;
        } else if (mode === "Stumped") {
          fielder = keeper.name; // guaranteed by pickDismissal only offering Stumped when a keeper exists
        }
        batterLog.dismissal = { mode, bowler: creditsBowler ? bowler.name : null, fielder };
        fallOfWickets.push({ wicketNumber: wickets, score: runs, over: over + 1, ball: legalBalls + 1, batterName: batter.name, ...batterLog.dismissal });
        timeline.push({
          over: over + 1, ball: legalBalls + 1, bowlerName: bowler.name, batterName: batter.name,
          isWicket: true, runs: 0, mode, fielder, score: runs, wickets,
          commentary: formatBallCommentary({ isWicket: true, mode, batterName: batter.name, bowlerName: bowler.name, fielder }),
        });
        strikerIdx = Math.max(strikerIdx, nonStrikerIdx) + 1; // next batter in
        legalBalls++;
        if (strikerIdx >= battingTeam.length) break;
      } else if (outcome === 0 && Math.random() < BYE_CHANCE) {
        runs += 1; extras += 1; extrasByType.bye += 1; runsThisOver += 1;
        timeline.push({
          over: over + 1, ball: legalBalls + 1, bowlerName: bowler.name, batterName: batter.name,
          isWicket: false, runs: 1, score: runs, wickets, extra: "bye",
          commentary: `${bowler.name} to ${batter.name}, 1 bye.`,
        });
        legalBalls++;
        { const t = strikerIdx; strikerIdx = nonStrikerIdx; nonStrikerIdx = t; } // a single, odd runs -> swap ends
      } else {
        runs += outcome;
        batterLog.runs += outcome;
        bowlerLog.runs += outcome;
        runsThisOver += outcome;
        if (outcome === 4) batterLog.fours += 1;
        if (outcome === 6) batterLog.sixes += 1;
        timeline.push({
          over: over + 1, ball: legalBalls + 1, bowlerName: bowler.name, batterName: batter.name,
          isWicket: false, runs: outcome, score: runs, wickets,
          commentary: formatBallCommentary({ isWicket: false, runs: outcome, batterName: batter.name, bowlerName: bowler.name }),
        });
        if (outcome % 2 === 1) { const t = strikerIdx; strikerIdx = nonStrikerIdx; nonStrikerIdx = t; } // odd runs -> swap ends
        legalBalls++;
      }
    }
    const fullOversNow = Math.floor((bowlerBallsSelf.get(bowler) || 0) / 6);
    bowlerFullOvers.set(bowler, fullOversNow);
    if (runsThisOver === 0 && legalBalls === 6) bowlerLog.maidens += 1;
    lastOverBowler = bowler;
    lastOverRuns.set(bowler, runsThisOver);
    if (legalBalls === 6) {
      // over completed normally — record a running-score summary: team
      // score, both batters at the crease, and this bowler's figures
      // through this over. Kept in a separate array from `timeline` so it
      // never gets mistaken for an individual ball by anything that walks
      // the ball-by-ball ball array (e.g. the live playback animation).
      const strikerLog = battingLog[strikerIdx];
      const nonStrikerLog = battingLog[nonStrikerIdx];
      oversSummary.push({
        over: over + 1, score: runs, wickets,
        batter1: strikerLog ? { name: strikerLog.name, runs: strikerLog.runs, balls: strikerLog.balls, out: strikerLog.out } : null,
        batter2: nonStrikerLog ? { name: nonStrikerLog.name, runs: nonStrikerLog.runs, balls: nonStrikerLog.balls, out: nonStrikerLog.out } : null,
        bowlerFigures: { name: bowler.name, overs: bowlerLog.overs, runs: bowlerLog.runs, wickets: bowlerLog.wickets },
      });
    }
    // swap ends between overs (standard cricket behaviour)
    const t = strikerIdx; strikerIdx = nonStrikerIdx; nonStrikerIdx = t;
  }

  const oversUsed = Math.min(totalOvers, Math.floor(ballsBowled / 6) + (ballsBowled % 6) / 10);
  return { runs, wickets, oversUsed, battingLog, bowlingLog, fallOfWickets, timeline, extras, extrasByType, oversSummary };
}

function formatBallCommentary({ isWicket, mode, runs, batterName, bowlerName, fielder }) {
  if (isWicket) {
    if (mode === "Bowled") return `${bowlerName} to ${batterName}, BOWLED him!`;
    if (mode === "LBW") return `${bowlerName} to ${batterName}, given out LBW!`;
    if (mode === "Stumped") return `${bowlerName} to ${batterName}, stumped!`;
    if (mode === "Caught") return `${bowlerName} to ${batterName}, caught by ${fielder}!`;
    if (mode === "Run Out") return `${batterName} run out, direct hit from ${fielder}!`;
    return `${bowlerName} to ${batterName}, OUT!`;
  }
  if (runs === 6) return `${bowlerName} to ${batterName}, SIX!`;
  if (runs === 4) return `${bowlerName} to ${batterName}, FOUR!`;
  if (runs === 0) return `${bowlerName} to ${batterName}, no run.`;
  return `${bowlerName} to ${batterName}, ${runs} run${runs === 1 ? "" : "s"}.`;
}

function formatOvers(o) {
  const whole = Math.floor(o);
  const balls = Math.round((o - whole) * 10);
  return balls === 0 ? String(whole) : `${whole}.${balls}`;
}

function formatDismissal(d) {
  if (!d) return "not out";
  if (d.mode === "Bowled") return `b ${d.bowler}`;
  if (d.mode === "LBW") return `lbw b ${d.bowler}`;
  if (d.mode === "Stumped") return `st b ${d.bowler}`;
  if (d.mode === "Caught") return `c ${d.fielder} b ${d.bowler}`;
  if (d.mode === "Run Out") return `run out (${d.fielder})`;
  return d.mode;
}

/**
 * Simulates a full 2-innings match between two teams on a given pitch.
 */
/**
 * Simulates a coin toss and the winning captain's bat/bowl decision.
 * The toss itself is a fair coin flip; the decision leans (not
 * dictates) toward what the pitch rewards — bowl first when the
 * conditions favor bowling (grip/bounce/wear), bat first on a pitch
 * that plays true and fast.
 */
function decideToss(pitch) {
  const tossWinner = Math.random() < 0.5 ? "A" : "B";
  const bowlFirstLean = (pitch.grip + pitch.bounce + pitch.deterioration - pitch.speed) / 30; // roughly -0.5..1
  const pBowlFirst = clamp(0.5 + bowlFirstLean * 0.4, 0.15, 0.85);
  const decision = Math.random() < pBowlFirst ? "bowl" : "bat";
  return { tossWinner, decision };
}

/**
 * Simulates a full 2-innings match between two teams on a given pitch.
 * Which side bats first is decided by a coin toss (see decideToss),
 * not fixed to teamA.
 */
/** Picks a Man of the Match using a simple runs+wickets impact score —
 * all-rounder contributions (batting and bowling in the same match)
 * combine naturally since they're keyed by name+team together. */
function pickManOfTheMatch({ first, second, battingFirstTeamName, bowlingFirstTeamName, winnerTeamName }) {
  const scores = new Map();
  function bump(name, teamName, amount) {
    const key = name + "|||" + teamName;
    const cur = scores.get(key) || { name, teamName, impact: 0 };
    cur.impact += amount;
    scores.set(key, cur);
  }
  first.battingLog.forEach(b => { if (b.balls > 0) bump(b.name, battingFirstTeamName, b.runs); });
  first.bowlingLog.forEach(b => { if (b.overs > 0) bump(b.name, bowlingFirstTeamName, b.wickets * 20 - b.runs * 0.5); });
  second.battingLog.forEach(b => { if (b.balls > 0) bump(b.name, bowlingFirstTeamName, b.runs); });
  second.bowlingLog.forEach(b => { if (b.overs > 0) bump(b.name, battingFirstTeamName, b.wickets * 20 - b.runs * 0.5); });
  let best = null;
  // Man of the Match comes from the winning side, same as real cricket —
  // falls back to considering everyone only on a tie, where there's no
  // winning team to restrict to.
  scores.forEach(s => {
    if (winnerTeamName && s.teamName !== winnerTeamName) return;
    if (!best || s.impact > best.impact) best = s;
  });
  return best;
}

function simulateMatch({ teamA, teamB, pitch, totalOvers = 20 }) {
  const toss = decideToss(pitch);
  const battingFirstIsA = (toss.tossWinner === "A" && toss.decision === "bat") || (toss.tossWinner === "B" && toss.decision === "bowl");
  const battingFirstTeam = battingFirstIsA ? teamA : teamB;
  const bowlingFirstTeam = battingFirstIsA ? teamB : teamA;

  const first = simulateInnings({ battingTeam: battingFirstTeam, bowlingTeam: bowlingFirstTeam, pitch, totalOvers, target: null });
  const target = first.runs + 1;
  const second = simulateInnings({ battingTeam: bowlingFirstTeam, bowlingTeam: battingFirstTeam, pitch, totalOvers, target });

  const firstAllOut = first.wickets >= 10;
  const secondAllOut = second.wickets >= 10;
  let winner, margin;
  if (second.runs >= target) {
    winner = battingFirstIsA ? "teamB" : "teamA";
    const wicketsInHand = 10 - second.wickets;
    margin = `won by ${wicketsInHand} wicket${wicketsInHand === 1 ? "" : "s"}`;
  } else if (second.runs === first.runs) {
    winner = null;
    margin = "Match tied";
  } else {
    winner = battingFirstIsA ? "teamA" : "teamB";
    margin = `won by ${first.runs - second.runs} run${first.runs - second.runs === 1 ? "" : "s"}`;
  }

  let winnerLabel = null;
  if (winner === "teamA") winnerLabel = battingFirstIsA ? "battingFirstTeam" : "bowlingFirstTeam";
  else if (winner === "teamB") winnerLabel = battingFirstIsA ? "bowlingFirstTeam" : "battingFirstTeam";

  const motm = pickManOfTheMatch({ first, second, battingFirstTeamName: "battingFirstTeam", bowlingFirstTeamName: "bowlingFirstTeam", winnerTeamName: winnerLabel });

  return {
    toss, battingFirstTeam: battingFirstIsA ? "teamA" : "teamB",
    first: { ...first, scoreText: `${first.runs}${firstAllOut ? "" : `/${first.wickets}`}${firstAllOut ? "" : ` (${formatOvers(first.oversUsed)})`}` },
    second: { ...second, scoreText: `${second.runs}${secondAllOut ? "" : `/${second.wickets}`}${secondAllOut ? "" : ` (${formatOvers(second.oversUsed)})`}` },
    winner, margin, motm,
  };
}

// ---------- demo, only runs when executed directly with `node cricket-sim.js` ----------
if (require.main === module) {
  const pitch = { speed: 7, grip: 4, bounce: 6, variation: 5, deterioration: 6 };

  const teamA = [
    { name: "A. Sharma", batting: 88, bowling: 20, battingSkill: "Compulsive Slogger", battingHand: "Right-handed", bowlingStyle: "None" },
    { name: "B. Roy", batting: 82, bowling: 15, battingHand: "Right-handed", bowlingStyle: "None" },
    { name: "C. Iyer", batting: 78, bowling: 10, battingSkill: "Specialist Batsman", battingHand: "Right-handed", bowlingStyle: "None" },
    { name: "D. Pant", batting: 80, bowling: 5, battingSkill: "Finisher", battingHand: "Left-handed", bowlingStyle: "None" },
    { name: "E. Pandya", batting: 70, bowling: 55, battingSkill: "Pinch Hitter", battingHand: "Right-handed", bowlingStyle: "Right Arm Fast" },
    { name: "F. Jadeja", batting: 55, bowling: 65, battingHand: "Left-handed", bowlingStyle: "Slow Left Arm Orthodox" },
    { name: "G. Karthik", batting: 60, bowling: 10, battingSkill: "Finisher", battingHand: "Right-handed", bowlingStyle: "None" },
    { name: "H. Bumrah", batting: 20, bowling: 90, bowlingSkill: "Death/Old Ball Bowler", battingHand: "Right-handed", bowlingStyle: "Right Arm Fast" },
    { name: "I. Shami", batting: 15, bowling: 82, bowlingSkill: "Specialist Bowler", battingHand: "Right-handed", bowlingStyle: "Right Arm Fast" },
    { name: "J. Chahal", batting: 12, bowling: 78, bowlingSkill: "Mystery Spinner", battingHand: "Right-handed", bowlingStyle: "Right Arm Leg Spin" },
    { name: "K. Kumar", batting: 10, bowling: 74, bowlingSkill: "New Ball Bowler", battingHand: "Right-handed", bowlingStyle: "Right Arm Fast" },
  ];

  const teamB = [
    { name: "L. Warner", batting: 85, bowling: 5, battingHand: "Left-handed", bowlingStyle: "None" },
    { name: "M. Head", batting: 84, bowling: 10, battingSkill: "Compulsive Slogger", battingHand: "Left-handed", bowlingStyle: "None" },
    { name: "N. Smith", batting: 83, bowling: 8, battingSkill: "Specialist Batsman", battingHand: "Right-handed", bowlingStyle: "None" },
    { name: "O. Marsh", batting: 75, bowling: 40, battingHand: "Right-handed", bowlingStyle: "Right Arm Fast" },
    { name: "P. Maxwell", batting: 79, bowling: 45, battingSkill: "Finisher", battingHand: "Right-handed", bowlingStyle: "Right Arm Leg Spin" },
    { name: "Q. Stoinis", batting: 68, bowling: 55, battingHand: "Right-handed", bowlingStyle: "Right Arm Fast" },
    { name: "R. Inglis", batting: 65, bowling: 5, battingSkill: "Finisher", battingHand: "Right-handed", bowlingStyle: "None" },
    { name: "S. Starc", batting: 18, bowling: 88, bowlingSkill: "Death/Old Ball Bowler", battingHand: "Left-handed", bowlingStyle: "Left Arm Fast" },
    { name: "T. Cummins", batting: 20, bowling: 85, bowlingSkill: "Specialist Bowler", battingHand: "Right-handed", bowlingStyle: "Right Arm Fast" },
    { name: "U. Zampa", batting: 12, bowling: 80, bowlingSkill: "None", battingHand: "Right-handed", bowlingStyle: "Right Arm Leg Spin" },
    { name: "V. Hazlewood", batting: 10, bowling: 76, battingHand: "Right-handed", bowlingStyle: "Right Arm Fast" },
  ];

  const result = simulateMatch({ teamA, teamB, pitch, totalOvers: 20 });

  console.log("=== TOSS ===");
  console.log(`Team ${result.toss.tossWinner} won the toss and chose to ${result.toss.decision}.`);
  console.log(`(${result.battingFirstTeam === "teamA" ? "Team A" : "Team B"} bats first.)`);

  console.log("\n=== SAMPLE BALL-BY-BALL (first over) ===");
  result.first.timeline.slice(0, 6).forEach(b => console.log(`${b.over}.${b.ball} ${b.commentary}`));

  console.log("\n=== MATCH RESULT ===");
  console.log(`Team A: ${result.first.scoreText}`);
  console.log(`Team B: ${result.second.scoreText}`);
  console.log(result.margin);

  console.log("\n=== TEAM A BATTING ===");
  result.first.battingLog.filter(b => b.balls > 0).forEach(b =>
    console.log(`${b.name.padEnd(12)} ${b.runs} (${b.balls})  ${formatDismissal(b.dismissal)}`));

  console.log("\n=== TEAM A FALL OF WICKETS ===");
  result.first.fallOfWickets.forEach(w =>
    console.log(`${w.wicketNumber}-${w.score} (${w.batterName}, ${w.over}.${w.ball}) ${w.mode}${w.fielder ? " " + w.fielder : ""}${w.bowler ? " b " + w.bowler : ""}`));

  console.log("\n=== TEAM A BOWLING (vs Team B) ===");
  result.second.bowlingLog.filter(b => b.overs > 0).forEach(b =>
    console.log(`${b.name.padEnd(12)} ${formatOvers(b.overs)}-${b.runs}-${b.wickets}`));

  console.log("\n=== TEAM B BATTING ===");
  result.second.battingLog.filter(b => b.balls > 0).forEach(b =>
    console.log(`${b.name.padEnd(12)} ${b.runs} (${b.balls})  ${formatDismissal(b.dismissal)}`));
}

module.exports = {
  getBallProbabilities, simulateInnings, simulateMatch, pickDismissal, getEligibleBowlers, decideToss, formatBallCommentary,
  BATTING_SKILLS, BOWLING_SKILLS, BATTING_HANDS, BOWLING_STYLES, DISMISSAL_MODES, formatDismissal, formatOvers,
};
