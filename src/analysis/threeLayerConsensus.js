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
  const { weeklyMacro, smcH4, smcH1, volumeProfile, vwap, regime, plan } = ctx;

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
  const h4Bias = smcH4?.structure?.bias || 'neutral';
  const h1Bias = smcH1?.structure?.bias || 'neutral';
  const techBullish = h4Bias === 'bullish' && h1Bias === 'bullish';
  const techBearish = h4Bias === 'bearish' && h1Bias === 'bearish';

  const techConfluence = {
    count: plan?.confluenceCount || 0,
    grade: plan?.setupQuality || 'no-trade',
    factors: plan?.confluenceFactors || [],
  };
  result.layers.technical = {
    h4Bias,
    h1Bias,
    confluenceCount: techConfluence.count,
    confluenceGrade: techConfluence.grade,
    factors: techConfluence.factors,
    score: techConfluence.count,
  };

  // ─── DIRECTION ────────────────────────────────────────────────────────────
  const macroBullish = macroScore.bullish;
  const macroBearish = macroScore.bearish;

  if (techBullish && (macroBullish || macroBias === 'neutral')) result.direction = 'long';
  else if (techBearish && (macroBearish || macroBias === 'neutral')) result.direction = 'short';
  else result.direction = null;

  // ─── BLOCKING CONDITIONS ──────────────────────────────────────────────────
  if (!regimeOK && regime?.regime !== 'transitioning') {
    result.blockingFactors.push(`Market regime: ${regime?.regime} — SMC ineffective`);
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
  const allFactors = [...macroScore.factors, ...flowFactors, ...techConfluence.factors];
  result.allFactors = allFactors;

  const macroFlowAgree = (macroBullish && result.direction === 'long') ||
                          (macroBearish && result.direction === 'short');
  const allThreeAgree = macroFlowAgree && flowScore.score >= 1 && techConfluence.count >= 5;

  if (result.direction && allThreeAgree && macroScore.strong) {
    result.tier = 1;
    result.tierLabel = 'TIER 1 — All layers strongly aligned';
    result.autoExecute = true;
    result.riskMultiplier = 1.5;
  } else if (result.direction && allThreeAgree) {
    result.tier = 2;
    result.tierLabel = 'TIER 2 — All layers aligned';
    result.autoExecute = true;
    result.riskMultiplier = 1.0;
  } else if (result.direction && techConfluence.count >= 5) {
    result.tier = 3;
    result.tierLabel = 'TIER 3 — Technical only (signal only)';
    result.autoExecute = false;
    result.riskMultiplier = 0;
  } else {
    result.tier = 4;
    result.tierLabel = 'TIER 4 — Insufficient confluence';
    result.autoExecute = false;
    result.direction = null;
  }

  result.summary = `${result.tierLabel} | ${result.direction || 'no-trade'} | ${allFactors.length} total factors`;
  console.log(`[3layer] ${result.summary}`);
  return result;
}
