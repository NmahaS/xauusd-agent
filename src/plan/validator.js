// Validates and corrects SL/TP direction at plan-generation time.
//
// The LLM occasionally emits a stop-loss on the wrong side of entry — e.g. a SHORT with SL
// *below* entry (anchored to an order block that sits below the current price). Placed
// verbatim, that stop triggers on submission and flattens the position instantly (see the
// executor-side guard in commit 698921ffc). This corrects the plan at the source so the
// Telegram message, the saved plan, the RAG record, and the executor all agree on one set
// of levels. The executor guard remains as a backstop.
//
// Invariants enforced:
//   SHORT → stopLoss.price > entry.price,  takeProfits[0].price < entry.price
//   LONG  → stopLoss.price < entry.price,  takeProfits[0].price > entry.price

export function validateAndCorrectPlanSLTP(plan, context = {}) {
  if (!plan?.direction || !plan?.entry?.price) {
    return { plan, corrected: false, reason: 'no direction or entry' };
  }

  const direction = String(plan.direction).toLowerCase();
  const entry = parseFloat(plan.entry.price);
  const slPrice = plan.stopLoss?.price != null ? parseFloat(plan.stopLoss.price) : null;
  const tpPrice = plan.takeProfits?.[0]?.price != null ? parseFloat(plan.takeProfits[0].price) : null;
  const atr = context?.m15Indicators?.atr ?? context?.m15?.indicators?.atr ?? 9;
  const targetRR = parseFloat(process.env.TARGET_RR || '2.0');

  const corrections = [];

  // ── SL side check ──
  const slValid = slPrice == null
    ? true
    : (direction === 'short' ? slPrice > entry : slPrice < entry);
  if (slPrice != null && !slValid) {
    corrections.push(`SL ${slPrice} on wrong side of entry ${entry} for ${direction.toUpperCase()}`);
  }

  // ── TP side check ──
  const tpValid = tpPrice == null
    ? true
    : (direction === 'short' ? tpPrice < entry : tpPrice > entry);
  if (tpPrice != null && !tpValid) {
    corrections.push(`TP ${tpPrice} on wrong side of entry ${entry} for ${direction.toUpperCase()}`);
  }

  let modified = false;

  // ── Correct SL: place at entry ± 1.5×ATR on the correct side ──
  if (!slValid) {
    const slDistance = atr * 1.5;
    const correctedSL = direction === 'short' ? entry + slDistance : entry - slDistance;
    console.warn(`[validator] correcting SL: ${slPrice} → ${correctedSL.toFixed(2)}`);
    plan.stopLoss = {
      ...(plan.stopLoss || {}),
      price: parseFloat(correctedSL.toFixed(2)),
      reasoning: `AUTO-CORRECTED from invalid SL ${slPrice} (was on wrong side of entry). Now entry ${direction === 'short' ? '+' : '-'} 1.5×ATR.`,
      autoCorrected: true,
    };
    modified = true;
  }

  // ── Correct TP: recompute to targetRR from the (corrected) SL whenever SL or TP was invalid ──
  if (!slValid || !tpValid) {
    const finalSL = plan.stopLoss?.price;
    if (finalSL != null && Array.isArray(plan.takeProfits) && plan.takeProfits[0]) {
      const slDist = Math.abs(entry - finalSL);
      const correctedTP = direction === 'short' ? entry - slDist * targetRR : entry + slDist * targetRR;
      console.warn(`[validator] correcting TP: ${tpPrice} → ${correctedTP.toFixed(2)}`);
      plan.takeProfits[0] = {
        ...plan.takeProfits[0],
        price: parseFloat(correctedTP.toFixed(2)),
        rr: targetRR,
        reasoning: `AUTO-CORRECTED to ${targetRR}R from corrected SL.`,
        autoCorrected: true,
      };
      modified = true;
    }
  }

  if (modified) {
    console.warn('[validator] plan corrected:', corrections.join(' | '));
    plan._validationApplied = {
      timestamp: new Date().toISOString(),
      corrections,
      original: { sl: slPrice, tp: tpPrice },
    };
  } else {
    console.log('[validator] plan SL/TP valid ✅');
  }

  return { plan, corrected: modified, reason: corrections.join(' | ') };
}
