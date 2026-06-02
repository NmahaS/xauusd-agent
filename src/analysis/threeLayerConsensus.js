// Three-layer consensus engine.
// Layer 1: Macro (weekly COT + DXY + yields)
// Layer 2: Flow (volume profile + VWAP + regime)
// Layer 3: Technical (SMC structure + LLM confluence)
//
// Tier is driven by how the H4/H1/M15 timeframes line up with the trade direction.
// A NEUTRAL timeframe is not a conflict — only a directly OPPOSING one is.
// Tier 1: H4+H1+M15 all agree → auto-execute, 1.5x risk
// Tier 2: H4+M15 agree (H1 neutral/agree) OR H4+H1 trend with M15 pullback → auto-execute, 1x
// Tier 3: H4 agrees, lower TFs unconfirmed (not opposing) → signal only
// Tier 4: H4 doesn't confirm, or lower TFs actively oppose, or regime/data unusable → no trade

import { resolveStaleH4Bias } from '../smc/structure.js';

export async function computeThreeLayerConsensus(ctx) {
  const { weeklyMacro, volumeProfile, vwap, regime, plan } = ctx;

  const result = {
    tier: null,
    tierLabel: '',
    autoExecute: false,
    riskMultiplier: 1.0,
    direction: null,
    layers: { macro: null, flow: null, technical: null },
    allFactors: [],
    blockingFactors: [],
    summary: '',
  };

  // ─── LAYER 1: MACRO ───────────────────────────────────────────────────────
  const macroBias = weeklyMacro?.weeklyBias || 'neutral';
  const macroScore = {
    bias: macroBias,
    bullish: macroBias.includes('bullish'),
    bearish: macroBias.includes('bearish'),
    strong: macroBias.includes('strongly'),
    factors: weeklyMacro?.factors || [],
    score: macroBias.includes('strongly') ? 3 : (macroBias.includes('bullish') || macroBias.includes('bearish')) ? 2 : 0,
  };
  result.layers.macro = macroScore;

  // ─── LAYER 2: FLOW ────────────────────────────────────────────────────────
  const vpSignal = volumeProfile?.signal || 'unknown';
  const vwapBias = vwap?.institutionalBias || 'unknown';
  const regimeOK = regime?.smc_effective !== false;

  const flowFactors = [];
  if (vpSignal === 'at_hvn') flowFactors.push(`Price at HVN ${volumeProfile?.nearestHVN} (strong S/R)`);
  if (vpSignal === 'below_va' && macroScore.bullish) flowFactors.push('Price in VP discount zone — institutional buy area');
  if (vpSignal === 'above_va' && macroScore.bearish) flowFactors.push('Price in VP premium zone — institutional sell area');
  if (vpSignal === 'at_poc') flowFactors.push(`Price at POC ${volumeProfile?.poc} (institutional equilibrium)`);
  if (vwapBias === 'bullish' && macroScore.bullish) flowFactors.push('Above weekly VWAP — institutional buy side');
  if (vwapBias === 'bearish' && macroScore.bearish) flowFactors.push('Below weekly VWAP — institutional sell side');

  const flowScore = {
    regimeOK,
    regime: regime?.regime,
    vpSignal,
    vwapBias,
    factors: flowFactors,
    score: flowFactors.length,
  };
  result.layers.flow = flowScore;

  // ─── LAYER 3: TECHNICAL ───────────────────────────────────────────────────
  // H4 = trend TF (sets direction), H1 = middle TF (pullback allowed),
  // M15 = execution TF (must agree with H4 — non-negotiable)
  // H4 structure bias is derived from confirmed swing pivots, so it lags when the forming H4
  // candle has clearly moved the other way. Apply a staleness override: if the last H4 CHoCH/BOS
  // is >24h old AND recent candles oppose it, use the live direction instead.
  const h4Struct = ctx.h4?.structure;
  const h4Eval = resolveStaleH4Bias(h4Struct, ctx.h4?.candles);
  console.log('[3layer] H4 structure age:', h4Eval.ageHours.toFixed(1) + 'h');
  if (h4Eval.stale) {
    console.log('[3layer] H4 STALE:', h4Eval.originalBias, 'but recent candles', h4Eval.bias);
  }
  const h4Bias = h4Eval.bias;
  const h1Bias = ctx.h1?.structure?.bias || 'neutral';
  const m15Bias = ctx.m15?.structure?.bias || 'neutral';

  const h4Direction = h4Bias === 'bullish' ? 'long' : h4Bias === 'bearish' ? 'short' : null;
  const h1Direction = h1Bias === 'bullish' ? 'long' : h1Bias === 'bearish' ? 'short' : null;
  const m15Direction = m15Bias === 'bullish' ? 'long' : m15Bias === 'bearish' ? 'short' : null;

  // H4+M15 must agree for execution. H1 agreement is optional (affects tier only).
  const h4AndM15Agree = h4Direction != null && m15Direction != null && h4Direction === m15Direction;
  const h1AlignsWithH4 = h1Direction != null && h1Direction === h4Direction;
  const h1PullbackInH4 = h1Direction != null && h4Direction != null && h1Direction !== h4Direction;

  const techConfluence = {
    count: plan?.confluenceCount || 0,
    grade: plan?.setupQuality || 'no-trade',
    factors: plan?.confluenceFactors || [],
  };
  result.layers.technical = {
    h4Bias,
    h4Stale: h4Eval.stale,
    h1Bias,
    m15Bias,
    confluenceCount: techConfluence.count,
    confluenceGrade: techConfluence.grade,
    factors: techConfluence.factors,
    h4AndM15Agree,
    h1AlignsWithH4,
    h1PullbackInH4,
    score: techConfluence.count,
  };

  // ─── DIRECTION ────────────────────────────────────────────────────────────
  // Tiering is driven by how the timeframes line up with the direction we'd actually
  // trade: the plan's (LLM consensus) direction, falling back to the H4-led TF candidate.
  const macroBullish = macroScore.bullish;
  const macroBearish = macroScore.bearish;

  const lowerTFsAgree = !h4Direction && h1Direction != null && h1Direction === m15Direction;
  const techCandidateDir =
    (h4Direction && (h1AlignsWithH4 || h4AndM15Agree)) ? h4Direction
    : lowerTFsAgree                                     ? h1Direction
    : null;

  const dir = plan?.direction || techCandidateDir || null;

  // A bias AGREES when it points the same way as `dir`. NEUTRAL never agrees — but,
  // crucially, it never OPPOSES either. Only a directly opposite bias is a conflict.
  const agrees  = (bias) => dir === 'long' ? bias === 'bullish' : dir === 'short' ? bias === 'bearish' : false;
  const opposes = (bias) => dir === 'long' ? bias === 'bearish' : dir === 'short' ? bias === 'bullish' : false;

  const h4Agrees  = agrees(h4Bias);
  const h1Agrees  = agrees(h1Bias);
  const m15Agrees = agrees(m15Bias);
  const h1Opposes = opposes(h1Bias);

  console.log('[3layer] h4:', h4Bias, h4Agrees ? '✅' : '❌');
  console.log('[3layer] h1:', h1Bias, h1Agrees ? '✅' : h1Opposes ? '❌' : '⊘ neutral');
  console.log('[3layer] m15:', m15Bias, m15Agrees ? '✅' : '❌');
  console.log('[3layer] dir:', dir);

  // ─── BLOCKING CONDITIONS ──────────────────────────────────────────────────
  // 1. Extreme regime (smc_effective=false). Tradeable variants get warnings only.
  if (!regimeOK && regime?.regime !== 'transitioning') {
    const label = regime?.regime === 'volatile'
      ? 'Extreme volatility — SMC ineffective'
      : `Market regime: ${regime?.regime} — SMC ineffective`;
    result.blockingFactors.push(label);
  }
  if (regime?.regime === 'ranging_tradeable') {
    result.warnings = result.warnings || [];
    result.warnings.push('⚠️ Moderate ranging market — trade with caution');
    console.log('[3layer] ranging_tradeable — warning added, trade allowed');
  }
  if (regime?.regime === 'volatile_tradeable') {
    result.warnings = result.warnings || [];
    result.warnings.push('⚠️ Elevated volatility — use tight stops');
    console.log('[3layer] volatile_tradeable — warning added, trade allowed');
  }

  // 2. Macro/flow are CONTEXT, not timeframes. When a directional macro + flow both lean
  // against the TF-aligned direction it is a headwind WARNING, not a hard block — the TF
  // stack decides the tier (per design: a layer conflict adds a warning, it does not block).
  if (dir && macroScore.score >= 2 && flowScore.score >= 1 &&
      ((dir === 'long' && macroBearish) || (dir === 'short' && macroBullish))) {
    result.warnings = result.warnings || [];
    result.warnings.push(`⚠️ Macro+flow ${macroBias} headwind against ${dir} — context conflict`);
    console.log(`[3layer] macro+flow ${macroBias} headwind against ${dir} — warning only`);
  }

  if (result.blockingFactors.length > 0) {
    result.tier = 4;
    result.tierLabel = 'TIER 4 — Blocked';
    result.autoExecute = false;
    result.direction = null;
    result.summary = `Tier 4: Blocked — ${result.blockingFactors.join(', ')}`;
    console.log(`[3layer] ${result.summary}`);
    return result;
  }

  // ─── TIER CLASSIFICATION ──────────────────────────────────────────────────
  // Tier is set by how H4/H1/M15 line up with `dir`. A NEUTRAL H1 is NOT a conflict —
  // only a directly OPPOSING H1 is. (H4 bearish + H1 neutral + M15 bearish = Tier 2.)
  //   • !h4Agrees                       → Tier 4 (no higher-TF trend behind the trade)
  //   • h4+h1+m15 all agree             → Tier 1
  //   • h4+m15 agree, h1 not opposing   → Tier 2  ← today's signal
  //   • h4+h1 agree, m15 pullback       → Tier 2
  //   • h4 agrees, h1 not opposing      → Tier 3
  //   • else (h1/m15 actively oppose)   → Tier 4
  const allFactors = [...macroScore.factors, ...flowFactors, ...techConfluence.factors];
  result.allFactors = allFactors;
  const dirWord = dir === 'long' ? 'bullish' : 'bearish';

  if (!h4Agrees) {
    result.tier = 4;
    result.tierLabel = `TIER 4 — H4 (${h4Bias}) does not confirm ${dir || 'no-trade'}`;
    result.autoExecute = false;
    result.direction = null;
    console.log(`[3layer] TIER 4 — H4 (${h4Bias}) does not agree with ${dir}`);
  } else if (h4Agrees && h1Agrees && m15Agrees) {
    result.tier = 1;
    result.tierLabel = 'TIER 1 — All 3 TFs aligned';
    result.autoExecute = true;
    result.riskMultiplier = 1.5;
    result.direction = dir;
    console.log('[3layer] TIER 1 — all 3 TFs aligned');
  } else if (h4Agrees && (h1Agrees || !h1Opposes) && m15Agrees) {
    // H4 + M15 agree, H1 neutral or agreeing (today's signal). Neutral H1 ≠ conflict.
    result.tier = 2;
    result.tierLabel = `TIER 2 — H4+M15 ${dirWord}, H1 ${h1Bias}`;
    result.autoExecute = true;
    result.riskMultiplier = 1.0;
    result.direction = dir;
    if (!h1Agrees) {
      result.warnings = result.warnings || [];
      result.warnings.push(`H1 neutral — H4+M15 carry the ${dirWord} signal`);
    }
    console.log(`[3layer] TIER 2 — H4+M15 agree, H1 ${h1Bias}`);
  } else if (h4Agrees && h1Agrees && !m15Agrees) {
    // H4+H1 trend intact; M15 opposite = corrective pullback = classic entry.
    result.tier = 2;
    result.tierLabel = `TIER 2 — H4+H1 ${dirWord}, M15 pullback entry`;
    result.autoExecute = true;
    result.riskMultiplier = 1.0;
    result.direction = dir;
    result.warnings = result.warnings || [];
    result.warnings.push(`M15 pullback against H4+H1 ${dirWord} trend — corrective entry`);
    console.log('[3layer] TIER 2 — H4+H1 trend, M15 pullback entry');
  } else if (h4Agrees && !h1Opposes) {
    // H4 confirms; H1 not opposing (neutral) but M15 unconfirmed → weaker, signal only.
    result.tier = 3;
    result.tierLabel = `TIER 3 — H4 ${dirWord}, lower TFs unconfirmed`;
    result.autoExecute = false;
    result.riskMultiplier = 0;
    result.direction = dir;
    console.log('[3layer] TIER 3 — H4 agrees, lower TFs unconfirmed');
  } else {
    // H4 agrees but H1 (and/or M15) actively oppose → mixed signal, no edge.
    result.tier = 4;
    result.tierLabel = `TIER 4 — H1 ${h1Bias} opposes ${dir} (mixed TFs)`;
    result.autoExecute = false;
    result.direction = null;
    console.log('[3layer] TIER 4 — only H4 agrees, lower TFs oppose');
  }

  result.summary = `${result.tierLabel} | ${result.direction || 'no-trade'} | ${allFactors.length} total factors`;
  console.log(`[3layer] ${result.summary}`);
  return result;
}
