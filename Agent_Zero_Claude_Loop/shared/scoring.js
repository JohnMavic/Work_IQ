/**
 * scoring.js — Automated Scoring for Agent Zero Optimization
 * 
 * Calculates weighted scores for each optimization phase,
 * compares variants, and determines winners.
 * 
 * Usage (CLI):
 *   node scoring.js --phase phase1 --file scores.json
 *   node scoring.js --phase phase2 --file scores.json --compare
 * 
 * Usage (Module):
 *   import { calculateScore, compareVariants, isImproved } from './scoring.js';
 *   // or: const { calculateScore, compareVariants, isImproved } = require('./scoring.js');
 */

// ─── Phase Criteria Weights ──────────────────────────────────────────────────

const PHASE_WEIGHTS = {
  phase1: {
    classification:    0.30,
    subject_fidelity:  0.25,
    deduplication:     0.15,
    output_format:     0.15,
    performance:       0.15
  },
  phase2: {
    summary_quality:   0.30,
    content_retrieval: 0.25,
    temporal_reasoning:0.20,
    output_format:     0.15,
    language_fidelity: 0.10
  },
  phase3: {
    update_detection:      0.30,
    temporal_filtering:    0.25,
    update_summary_quality:0.20,
    search_effectiveness:  0.15,
    output_format:         0.10
  },
  phase4: {
    merge_precision:   0.35,
    reasoning_quality: 0.20,
    merge_recall:      0.20,
    title_suggestion:  0.15,
    output_format:     0.10
  }
};

// ─── Core Functions ──────────────────────────────────────────────────────────

/**
 * Calculate weighted total score for a given phase.
 * @param {string} phase - Phase identifier (phase1..phase4)
 * @param {Object} criteriaScores - Map of criterion name → score (0-100)
 * @returns {{ total: number, weighted: Object, missing: string[], phase: string }}
 */
function calculateScore(phase, criteriaScores) {
  const weights = PHASE_WEIGHTS[phase];
  if (!weights) {
    throw new Error(`Unknown phase: "${phase}". Valid phases: ${Object.keys(PHASE_WEIGHTS).join(', ')}`);
  }

  const weighted = {};
  const missing = [];
  let total = 0;

  for (const [criterion, weight] of Object.entries(weights)) {
    const score = criteriaScores[criterion];
    if (score === undefined || score === null) {
      missing.push(criterion);
      weighted[criterion] = { score: 0, weight, contribution: 0 };
    } else {
      const clamped = Math.max(0, Math.min(100, Number(score)));
      const contribution = clamped * weight;
      weighted[criterion] = { score: clamped, weight, contribution: Math.round(contribution * 100) / 100 };
      total += contribution;
    }
  }

  return {
    phase,
    total: Math.round(total * 100) / 100,
    weighted,
    missing
  };
}

/**
 * Compare multiple variants and determine the winner.
 * @param {string} phase - Phase identifier
 * @param {Object} variants - Map of variant name → criteria scores
 * @returns {{ rankings: Array, winner: string, results: Object }}
 */
function compareVariants(phase, variants) {
  const results = {};

  for (const [name, criteriaScores] of Object.entries(variants)) {
    results[name] = calculateScore(phase, criteriaScores);
  }

  // Sort by total score descending
  const rankings = Object.entries(results)
    .map(([name, result]) => ({ name, total: result.total }))
    .sort((a, b) => b.total - a.total);

  return {
    phase,
    rankings,
    winner: rankings.length > 0 ? rankings[0].name : null,
    results
  };
}

/**
 * Check if a new score represents meaningful improvement over old score.
 * @param {number} oldScore - Previous total score
 * @param {number} newScore - New total score
 * @param {number} threshold - Minimum point improvement required (default: 2)
 * @returns {boolean}
 */
function isImproved(oldScore, newScore, threshold = 2) {
  return (newScore - oldScore) >= threshold;
}

/**
 * Get the weight configuration for a phase.
 * @param {string} phase - Phase identifier
 * @returns {Object} Weight map
 */
function getWeights(phase) {
  const weights = PHASE_WEIGHTS[phase];
  if (!weights) {
    throw new Error(`Unknown phase: "${phase}". Valid phases: ${Object.keys(PHASE_WEIGHTS).join(', ')}`);
  }
  return { ...weights };
}

// ─── CLI Formatting ──────────────────────────────────────────────────────────

function formatScoreTable(result) {
  const lines = [];
  const divider = '─'.repeat(62);

  lines.push(`\n  ${result.phase.toUpperCase()} — Score Report`);
  lines.push(`  ${divider}`);
  lines.push(`  ${'Criterion'.padEnd(25)} ${'Score'.padStart(6)} ${'Weight'.padStart(7)} ${'Contrib.'.padStart(9)}`);
  lines.push(`  ${divider}`);

  for (const [criterion, data] of Object.entries(result.weighted)) {
    const name = criterion.replace(/_/g, ' ');
    const scoreStr = data.score === 0 && result.missing.includes(criterion)
      ? '  N/A' : String(data.score).padStart(5);
    lines.push(
      `  ${name.padEnd(25)} ${scoreStr} ${(data.weight * 100).toFixed(0).padStart(5)}%  ${data.contribution.toFixed(2).padStart(8)}`
    );
  }

  lines.push(`  ${divider}`);
  lines.push(`  ${'TOTAL'.padEnd(25)} ${String(result.total).padStart(6)}  / 100`);

  if (result.missing.length > 0) {
    lines.push(`\n  ⚠  Missing criteria: ${result.missing.join(', ')}`);
  }

  lines.push('');
  return lines.join('\n');
}

function formatComparisonTable(comparison) {
  const lines = [];
  const divider = '═'.repeat(62);

  lines.push(`\n  ${comparison.phase.toUpperCase()} — Variant Comparison`);
  lines.push(`  ${divider}`);

  for (const ranking of comparison.rankings) {
    const result = comparison.results[ranking.name];
    const marker = ranking.name === comparison.winner ? ' 🏆' : '';
    lines.push(`\n  ▸ ${ranking.name}${marker}  —  Total: ${ranking.total}/100`);

    for (const [criterion, data] of Object.entries(result.weighted)) {
      const name = criterion.replace(/_/g, ' ');
      const bar = '█'.repeat(Math.round(data.score / 5)) + '░'.repeat(20 - Math.round(data.score / 5));
      lines.push(`    ${name.padEnd(25)} ${bar} ${String(data.score).padStart(3)}`);
    }
  }

  lines.push(`\n  ${divider}`);
  lines.push(`  Winner: ${comparison.winner} (${comparison.rankings[0]?.total}/100)`);

  if (comparison.rankings.length >= 2) {
    const delta = comparison.rankings[0].total - comparison.rankings[1].total;
    lines.push(`  Margin: +${delta.toFixed(2)} points over ${comparison.rankings[1].name}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };

  const phase = getArg('--phase');
  const file = getArg('--file');
  const doCompare = args.includes('--compare');

  if (!phase || !file) {
    console.log(`
  Usage: node scoring.js --phase <phase> --file <scores.json> [--compare]

  Options:
    --phase     Phase identifier (phase1, phase2, phase3, phase4)
    --file      Path to scores.json file
    --compare   Compare all variants in the file

  scores.json format (single variant):
    { "classification": 85, "subject_fidelity": 90, ... }

  scores.json format (multiple variants for --compare):
    {
      "baseline": { "classification": 85, ... },
      "variant_a": { "classification": 90, ... }
    }
    `);
    process.exit(1);
  }

  // Load scores file
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');

  let data;
  try {
    const filePath = resolve(file);
    const raw = readFileSync(filePath, 'utf-8');
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`  ✗ Error reading ${file}: ${err.message}`);
    process.exit(1);
  }

  if (doCompare) {
    // Expect { variantName: { criteria }, ... }
    const comparison = compareVariants(phase, data);
    console.log(formatComparisonTable(comparison));
  } else {
    // Check if it's a single variant or named variant
    const firstValue = Object.values(data)[0];
    if (typeof firstValue === 'object' && !Array.isArray(firstValue) && typeof Object.values(firstValue)[0] === 'number') {
      // Multiple variants — score each
      for (const [name, scores] of Object.entries(data)) {
        console.log(`  ▸ Variant: ${name}`);
        const result = calculateScore(phase, scores);
        console.log(formatScoreTable(result));
      }
    } else {
      // Single variant
      const result = calculateScore(phase, data);
      console.log(formatScoreTable(result));
    }
  }
}

// ─── Module Exports (dual ESM/CJS support) ───────────────────────────────────

const exports_ = { calculateScore, compareVariants, isImproved, getWeights, PHASE_WEIGHTS };

// ESM export
export { calculateScore, compareVariants, isImproved, getWeights, PHASE_WEIGHTS };
export default exports_;

// CJS compatibility — detect if running as main script
const isMain = process.argv[1] && (
  process.argv[1].endsWith('scoring.js') ||
  process.argv[1].endsWith('scoring')
);

if (isMain) {
  main().catch(err => {
    console.error(`  ✗ Fatal: ${err.message}`);
    process.exit(1);
  });
}
