// Three-layer consensus engine.
// Layer 1: Macro (weekly COT + DXY + yields)
// Layer 2: Flow (volume profile + VWAP + regime)
// Layer 3: Technical (SMC structure + LLM confluence)
//
// Tier 1: All layers strongly aligned → auto-execute, 1.5% risk
// Tier 2: All layers aligned → auto-execute, 1% risk
// Tier 3: Technical only → signal only, no auto-execute
// Tier 4: Blocked (regime, conflict, low confluence) → no trade

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
  const h4Bias = ctx.h4?.structure?.bias || 'neutral';
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
  // H4 sets the trend direction. A trade needs at least one lower TF to confirm:
  // H1 aligned (trend confirmed — preferred) OR M15 aligned (execution confirmed).
  // If only H4 points and BOTH H1 and M15 disagree, there is no confirmation → no trade.
  // An opposite M15 while H1 confirms is a normal pullback, NOT a conflict (see tiers).
  const macroBullish = macroScore.bullish;
  const macroBearish = macroScore.bearish;

  const techCandidateDir = (h4Direction && (h1AlignsWithH4 || h4AndM15Agree))
    ? h4Direction
    : null;

  if (techCandidateDir === 'long' && (macroBullish || macroBias === 'neutral')) result.direction = 'long';
  else if (techCandidateDir === 'short' && (macroBearish || macroBias === 'neutral')) result.direction = 'short';
  else result.direction = null;

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

  // 2. M15 vs H4 is NO LONGER a hard block. When H1 confirms H4 (trend intact),
  // an opposite M15 is a corrective pullback → handled as Tier 2 below. When NO
  // lower TF confirms H4, direction is already null above → falls through to
  // Tier 4 (no-trade). Either way, M15 opposition alone never forces a block.

  // 3. Macro AND flow both oppose technical direction — structural headwind
  if (result.direction === 'long' && macroBearish && flowScore.score >= 1) {
    result.blockingFactors.push('Macro+flow bearish headwind against long — structural conflict');
  }
  if (result.direction === 'short' && macroBullish && flowScore.score >= 1) {
    result.blockingFactors.push('Macro+flow bullish headwind against short — structural conflict');
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
  // H4 = trend, H1 = confirmation, M15 = entry timing.
  //   • H4+H1+M15 all aligned      → Tier 1 (macro strong) / Tier 2
  //   • H4+H1 aligned, M15 opposite → Tier 2 (pullback entry — M15 is corrective)
  //   • H4+M15 aligned, H1 opposite → Tier 3 (H1 pullback — weaker, signal only)
  //   • anything else with a dir    → Tier 3; no confirmation → Tier 4 (no-trade)
  const allFactors = [...macroScore.factors, ...flowFactors, ...techConfluence.factors];
  result.allFactors = allFactors;

  const dirWord = result.direction === 'long' ? 'bullish' : 'bearish';
  const macroFlowAgree = (macroBullish && result.direction === 'long') ||
                          (macroBearish && result.direction === 'short');
  const allTFsAligned = h4AndM15Agree && h1AlignsWithH4;   // H4+H1+M15 same direction
  const m15Pullback   = h1AlignsWithH4 && !h4AndM15Agree;  // H4+H1 agree, M15 corrective
  const h1Pullback    = h4AndM15Agree && !h1AlignsWithH4;  // H4+M15 agree, H1 corrective

  if (result.direction && allTFsAligned && macroFlowAgree && macroScore.strong && techConfluence.count >= 5) {
    result.tier = 1;
    result.tierLabel = 'TIER 1 — All layers strongly aligned';
    result.autoExecute = true;
    result.riskMultiplier = 1.5;
    console.log('[3layer] TIER 1 — H4+H1+M15 aligned, macro strong');
  } else if (result.direction && allTFsAligned) {
    result.tier = 2;
    result.tierLabel = 'TIER 2 — All TFs aligned';
    result.autoExecute = true;
    result.riskMultiplier = 1.0;
    console.log('[3layer] TIER 2 — H4+H1+M15 all aligned');
  } else if (result.direction && m15Pullback) {
    // H4+H1 confirm the trend; M15 opposite = corrective pullback = classic entry.
    result.tier = 2;
    result.tierLabel = `TIER 2 — H4+H1 ${dirWord}, M15 pullback entry`;
    result.autoExecute = true;
    result.riskMultiplier = 1.0;
    result.warnings = result.warnings || [];
    result.warnings.push(`M15 pullback against H4+H1 ${dirWord} trend — corrective entry`);
    console.log(`[3layer] TIER 2 — H4+H1 ${dirWord}, M15 pullback entry`);
  } else if (result.direction && h1Pullback) {
    result.tier = 3;
    result.tierLabel = 'TIER 3 — H4+M15 aligned (H1 pullback)';
    result.autoExecute = false;
    result.riskMultiplier = 0;
    result.warnings = result.warnings || [];
    result.warnings.push('H1 pullback in H4 trend — corrective move, weaker signal');
    console.log('[3layer] TIER 3 — H4+M15 aligned, H1 pullback');
  } else if (result.direction) {
    result.tier = 3;
    result.tierLabel = 'TIER 3 — Technical only (signal only)';
    result.autoExecute = false;
    result.riskMultiplier = 0;
    console.log('[3layer] TIER 3 — technical only');
  } else {
    result.tier = 4;
    result.tierLabel = 'TIER 4 — No TF confirmation';
    result.autoExecute = false;
    result.direction = null;
    console.log('[3layer] TIER 4 — no clean TF confirmation (no-trade)');
  }

  result.summary = `${result.tierLabel} | ${result.direction || 'no-trade'} | ${allFactors.length} total factors`;
  console.log(`[3layer] ${result.summary}`);
  return result;
}
