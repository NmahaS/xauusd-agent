import fs from 'node:fs/promises';
import path from 'node:path';

const README_PATH = path.resolve('README.md');
const PLANS_DIR = path.resolve('plans');
const MARKER_START = '<!-- LATEST_PLAN_START -->';
const MARKER_END = '<!-- LATEST_PLAN_END -->';

function planDatePath(timestampIso) {
  const d = new Date(timestampIso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hour = String(d.getUTCHours()).padStart(2, '0');
  return { dir: path.join(PLANS_DIR, `${y}-${m}-${day}`), filename: `${hour}.json` };
}

export async function savePlan(plan) {
  const { dir, filename } = planDatePath(plan.timestamp);
  await fs.mkdir(dir, { recursive: true });
  const fullPath = path.join(dir, filename);
  await fs.writeFile(fullPath, JSON.stringify(plan, null, 2), 'utf8');
  console.log(`[writer] saved plan to ${path.relative(process.cwd(), fullPath)}`);
  return fullPath;
}

function buildLatestMarkdown(plan) {
  const lines = [];
  lines.push(`**Generated:** ${plan.timestamp}`);
  lines.push('');
  lines.push(`- **Bias:** ${plan.bias}`);
  lines.push(`- **Setup Quality:** ${plan.setupQuality}`);
  lines.push(`- **Confluence:** ${plan.confluenceCount} — ${plan.confluenceFactors.join('; ') || 'none'}`);
  lines.push(`- **Session:** ${plan.session.current} — ${plan.session.recommendedExecutionWindow}`);
  if (plan.direction) {
    lines.push(`- **Direction:** ${plan.direction}`);
    if (plan.poi) lines.push(`- **POI:** ${plan.poi.type} @ [${plan.poi.zone.join(', ')}]`);
    if (plan.entry) lines.push(`- **Entry:** ${plan.entry.trigger} @ ${plan.entry.price} — ${plan.entry.confirmation}`);
    if (plan.stopLoss) lines.push(`- **Stop Loss:** ${plan.stopLoss.price}`);
    if (plan.takeProfits) {
      plan.takeProfits.forEach((tp, i) => {
        lines.push(`- **TP${i + 1}:** ${tp.price} (RR ${tp.rr})`);
      });
    }
    if (plan.invalidation) lines.push(`- **Invalidation:** ${plan.invalidation.price}`);
  } else {
    lines.push(`- **Direction:** no-trade`);
  }
  lines.push('');
  lines.push(`**Macro Context:** ${plan.macroContext}`);
  if (plan.warnings.length) {
    lines.push('');
    lines.push(`**Warnings:**`);
    for (const w of plan.warnings) lines.push(`- ⚠ ${w}`);
  }
  return lines.join('\n');
}

export async function getTodayStats(timestampIso) {
  const d = timestampIso ? new Date(timestampIso) : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const dir = path.join(PLANS_DIR, `${y}-${m}-${day}`);
  const counts = { 'A+': 0, 'A': 0, 'B': 0, 'no-trade': 0 };
  try {
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
    await Promise.all(files.map(async (file) => {
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        const plan = JSON.parse(raw);
        if (plan.setupQuality in counts) counts[plan.setupQuality]++;
      } catch {}
    }));
  } catch {}
  return counts;
}

export async function updateReadmeLatestPlan(plan) {
  let readme;
  try {
    readme = await fs.readFile(README_PATH, 'utf8');
  } catch (err) {
    console.warn(`[writer] README not found: ${err.message}`);
    return;
  }

  const latestMd = buildLatestMarkdown(plan);
  const block = `${MARKER_START}\n${latestMd}\n${MARKER_END}`;

  let updated;
  if (readme.includes(MARKER_START) && readme.includes(MARKER_END)) {
    updated = readme.replace(
      new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`),
      block
    );
  } else {
    updated = readme.replace(
      /## Latest Plan[\s\S]*?(?=\n## |\n---|$)/,
      `## Latest Plan\n\n${block}\n\n`
    );
    if (!updated.includes(MARKER_START)) {
      updated += `\n\n## Latest Plan\n\n${block}\n`;
    }
  }

  await fs.writeFile(README_PATH, updated, 'utf8');
  console.log(`[writer] README.md Latest Plan section updated`);
}
