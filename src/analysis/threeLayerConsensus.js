// Three-layer consensus engine.
// Layer 1: Macro (weekly COT + DXY + yields)
// Layer 2: Flow (volume profile + VWAP + regime)
// Layer 3: Technical (SMC structure + LLM confluence)
//
// H1 is the PRIMARY directional filter (was H4). M15 = execution. H4 = context only.
// H4 structure lags ~4h, so it no longer gates entries — it only adds a warning when it
// opposes. A NEUTRAL timeframe is not a conflict — only a directly OPPOSING one is.
// Tier 1: H1+M15+H4 all agree → auto-execute, 1.5x risk
// Tier 2: H1+M15 agree (H4 stale/neutral/opposing) OR H1 trend with M15 pullback → auto-execute, 1x
// Tier 3: H1 neutral, M15 confirms → signal only
// Tier 4: H1 opposes, or no confirmation, or regime/data unusable → no trade

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
  // H1 = PRIMARY directional filter, M15 = execution TF, H4 = context only (lags ~4h).
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

  // Informational metadata only — tiering is driven by H1 (primary), not H4.
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
  // trade: the plan's (LLM consensus) direction, falling back to the H1-led TF candidate.
  const macroBullish = macroScore.bullish;
  const macroBearish = macroScore.bearish;

  // H1 is the primary filter, so the fallback candidate is H1-led (then M15).
  const techCandidateDir = h1Direction || m15Direction || null;

  const dir = plan?.direction || techCandidateDir || null;

  // A bias AGREES when it points the same way as `dir`. NEUTRAL never agrees — but,
  // crucially, it never OPPOSES either. Only a directly opposite bias is a conflict.
  const agrees  = (bias) => dir === 'long' ? bias === 'bullish' : dir === 'short' ? bias === 'bearish' : false;
  const opposes = (bias) => dir === 'long' ? bias === 'bearish' : dir === 'short' ? bias === 'bullish' : false;

  const h1Agrees   = agrees(h1Bias);
  const h1Opposes  = opposes(h1Bias);
  const m15Agrees  = agrees(m15Bias);
  const m15Opposes = opposes(m15Bias);
  const h4Agrees   = agrees(h4Bias);
  const h4Opposes  = opposes(h4Bias);

  console.log('[3layer] H1 (primary):', h1Bias, h1Agrees ? '✅' : h1Opposes ? '❌' : '⊘');
  console.log('[3layer] M15 (execution):', m15Bias, m15Agrees ? '✅' : m15Opposes ? '❌' : '⊘');
  console.log('[3layer] H4 (context):', h4Bias, h4Agrees ? '✅' : h4Opposes ? '❌' : '⊘');
  console.log('[3layer] direction:', dir);

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
  // H1 is the PRIMARY directional filter (was H4). M15 = execution. H4 = context only.
  // A NEUTRAL H1 is NOT a conflict — only a directly OPPOSING H1 is. H4 never gates;
  // it only differentiates Tier 1 vs 2 and adds a warning when it opposes.
  //   • h1 opposes                      → Tier 4 (primary filter conflicts → block)
  //   • h1 + m15 agree, h4 agrees       → Tier 1
  //   • h1 + m15 agree (h4 stale/opp)   → Tier 2  ← H4 lag no longer blocks
  //   • h1 agrees, m15 pullback         → Tier 2
  //   • h1 neutral, m15 agrees          → Tier 3 (technical setup, H1 unconfirmed)
  //   • else (no confirmation)          → Tier 4
  const allFactors = [...macroScore.factors, ...flowFactors, ...techConfluence.factors];
  result.allFactors = allFactors;
  result.warnings = result.warnings || [];
  const dirWord = dir === 'long' ? 'bullish' : 'bearish';

  // ─── EMA MOMENTUM OVERRIDE ────────────────────────────────────────────────
  // When the LLM flags a counter-structure trade (direction opposes H1 structure but agrees
  // with price-vs-H1-EMA position), the H1-opposes block below would wrongly force Tier 4.
  // Honour the override INSTEAD of the H1 structural check: tier off the EMA position.
  //   • EMA confirms (price above both for long / below both for short) → Tier 3, tradeable
  //   • EMA does NOT confirm → Tier 4 (override claimed but EMAs disagree → block)
  const h1Emas = ctx?.h1Emas;
  const isEmaOverride =
    plan?.emaOverride === true ||
    /momentum override|counter-structure/i.test(
      `${plan?.overrideReason || ''} ${plan?.biasReasoning || ''} ${(plan?.warnings || []).join(' ')}`
    );
  if (isEmaOverride && dir) {
    console.log('[3layer] EMA momentum override detected — dir:', dir, '| H1 structure:', h1Bias);

    // BOUNCE vs REVERSAL gate — the EMA override cannot tell a genuine REVERSAL (H4 flips too)
    // from a counter-trend BOUNCE (H4 still opposes). H1 EMAs get flipped by a few hours of
    // retrace; H4 structure does not — so H4 is the arbiter. Require H4 STRUCTURAL agreement
    // before honoring the override; otherwise it is a retrace inside the H4 trend (a trap that
    // buys the top of the bounce). Use raw structural H4 bias, not the stale-resolved live one,
    // so a short bounce can't itself flip the arbiter.
    const h4OverrideBias = ctx.h4?.structure?.bias ?? ctx.h4?.bias ?? null;
    const h4AgreesOverride =
      (dir === 'long' && h4OverrideBias === 'bullish') ||
      (dir === 'short' && h4OverrideBias === 'bearish');
    console.log('[3layer] EMA override H4 gate — H4 bias:', h4OverrideBias,
      '| direction:', dir, '| H4 agrees:', h4AgreesOverride);

    if (!h4AgreesOverride) {
      result.tier = 4;
      result.tierLabel = `TIER 4 — EMA override blocked: H4 ${h4OverrideBias} opposes ${dir} (bounce, not reversal)`;
      result.autoExecute = false;
      result.direction = null;
      result.blockingFactors.push(`EMA override blocked: H4 ${h4OverrideBias} opposes ${dir} — counter-trend bounce, not reversal. Wait for H4 to confirm.`);
      console.log(`[3layer] TIER 4 — EMA override REJECTED: H4 (${h4OverrideBias}) opposes ${dir}. Counter-trend BOUNCE, not reversal.`);
      result.summary = `${result.tierLabel} | no-trade | ${allFactors.length} total factors`;
      console.log(`[3layer] ${result.summary}`);
      return result;
    }

    // H4 co-signs → genuine reversal. Still require the H1 EMA position to confirm the direction.
    const emaConfirms = !!h1Emas && (
      (dir === 'long' && h1Emas.aboveBoth) ||
      (dir === 'short' && h1Emas.belowBoth)
    );
    if (emaConfirms) {
      result.tier = 3;
      result.tierLabel = `TIER 3 — EMA momentum override (H4 ${h4OverrideBias} co-signs, price ${dir === 'long' ? 'above' : 'below'} both H1 EMAs)`;
      result.autoExecute = true;
      result.riskMultiplier = 1.0;
      result.direction = dir;
      result.emaOverride = true;
      result.warnings.push(`EMA momentum override: H1 structure ${h1Bias} but H4 ${h4OverrideBias} co-signs + price ${dir === 'long' ? 'above' : 'below'} both H1 EMAs — genuine reversal ${dir} (quality B)`);
      console.log(`[3layer] TIER 3 — EMA override ALLOWED (H4 ${h4OverrideBias} co-signs ${dir}) ✅`);
    } else {
      result.tier = 4;
      result.tierLabel = 'TIER 4 — EMA override claimed but EMAs disagree';
      result.autoExecute = false;
      result.direction = null;
      result.blockingFactors.push('EMA override claimed but price not on the override side of both H1 EMAs');
      console.log('[3layer] TIER 4 — EMA override but EMAs do not confirm ❌');
    }
    result.summary = `${result.tierLabel} | ${result.direction || 'no-trade'} | ${allFactors.length} total factors`;
    console.log(`[3layer] ${result.summary}`);
    return result;
  }

  if (h1Opposes) {
    result.tier = 4;
    result.tierLabel = `TIER 4 — H1 (${h1Bias}) opposes ${dir || 'no-trade'}`;
    result.autoExecute = false;
    result.direction = null;
    console.log(`[3layer] TIER 4 — H1 ${h1Bias} opposes ${dir}`);
  } else if (h1Agrees && m15Agrees && h4Agrees) {
    result.tier = 1;
    result.tierLabel = 'TIER 1 — H1+M15+H4 all aligned';
    result.autoExecute = true;
    result.riskMultiplier = 1.5;
    result.direction = dir;
    console.log('[3layer] TIER 1 — H1+M15+H4 all aligned');
  } else if (h1Agrees && m15Agrees) {
    // H1 + M15 carry the signal; H4 is stale/neutral/opposing — context only, no block.
    result.tier = 2;
    result.tierLabel = `TIER 2 — H1+M15 ${dirWord}, H4 ${h4Bias}`;
    result.autoExecute = true;
    result.riskMultiplier = 1.0;
    result.direction = dir;
    if (h4Opposes) {
      result.warnings.push(`H4 ${h4Bias} opposes — may be longer-term resistance/support (context only)`);
    }
    console.log(`[3layer] TIER 2 — H1+M15 aligned, H4 ${h4Bias}`);
  } else if (h1Agrees && !m15Agrees) {
    // H1 trend intact; M15 not yet confirming = corrective pullback = classic entry.
    result.tier = 2;
    result.tierLabel = `TIER 2 — H1 ${dirWord} trend, M15 pullback entry`;
    result.autoExecute = true;
    result.riskMultiplier = 1.0;
    result.direction = dir;
    result.warnings.push(`M15 pullback against H1 ${dirWord} trend — corrective entry`);
    if (h4Opposes) {
      result.warnings.push(`H4 ${h4Bias} opposes H1 — possible reversal forming (context only)`);
    }
    console.log('[3layer] TIER 2 — H1 trend, M15 pullback entry');
  } else if (!h1Agrees && !h1Opposes && m15Agrees) {
    // H1 neutral (not opposing); M15 confirms → technical setup, signal only.
    result.tier = 3;
    result.tierLabel = `TIER 3 — H1 neutral, M15 ${dirWord} confirms`;
    result.autoExecute = false;
    result.riskMultiplier = 0;
    result.direction = dir;
    console.log('[3layer] TIER 3 — H1 neutral, M15 confirms');
  } else {
    result.tier = 4;
    result.tierLabel = `TIER 4 — insufficient confirmation (H1 ${h1Bias}, M15 ${m15Bias})`;
    result.autoExecute = false;
    result.direction = null;
    console.log('[3layer] TIER 4 — insufficient confirmation');
  }

  result.summary = `${result.tierLabel} | ${result.direction || 'no-trade'} | ${allFactors.length} total factors`;
  console.log(`[3layer] ${result.summary}`);
  return result;
}
