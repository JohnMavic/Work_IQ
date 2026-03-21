/**
 * validate-output.js — JSON Output Validator for Agent Zero Optimization
 * 
 * Validates the structured output from each optimization phase against
 * expected schemas, field values, and format rules.
 * 
 * Usage (CLI):
 *   node validate-output.js --phase 1 --file response.json
 *   node validate-output.js --phase 2 --file response.json
 * 
 * Usage (Module):
 *   import { validatePhase1Output, validatePhase2Output } from './validate-output.js';
 *   const report = validatePhase1Output(jsonString);
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const VALID_ACTIONS = new Set(['new', 'update', 'skip']);
const VALID_SOURCES = new Set(['email', 'teams']);
const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;
const MARKDOWN_JSON_WRAPPER = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/;

// ─── Validation Report Builder ───────────────────────────────────────────────

class ValidationReport {
  constructor(phase) {
    this.phase = phase;
    this.errors = [];
    this.warnings = [];
    this.info = [];
    this.itemReports = [];
    this.score = 100;
  }

  addError(message, context = null) {
    this.errors.push({ message, context });
    // Errors deduct more points
    this.score = Math.max(0, this.score - 15);
  }

  addWarning(message, context = null) {
    this.warnings.push({ message, context });
    this.score = Math.max(0, this.score - 5);
  }

  addInfo(message) {
    this.info.push(message);
  }

  addItemReport(index, errors, warnings) {
    this.itemReports.push({ index, errors, warnings });
    // Per-item penalties are smaller
    this.score = Math.max(0, this.score - (errors.length * 5) - (warnings.length * 2));
  }

  get isValid() {
    return this.errors.length === 0;
  }

  toJSON() {
    return {
      phase: this.phase,
      valid: this.isValid,
      score: Math.round(this.score),
      summary: {
        errors: this.errors.length,
        warnings: this.warnings.length,
        items: this.itemReports.length
      },
      errors: this.errors,
      warnings: this.warnings,
      info: this.info,
      itemReports: this.itemReports
    };
  }
}

// ─── Shared Helpers ──────────────────────────────────────────────────────────

/**
 * Attempt to parse JSON, stripping markdown wrappers if present.
 * @param {string} input - Raw string (possibly wrapped in ```json...```)
 * @returns {{ data: any, hadWrapper: boolean } | { error: string }}
 */
function parseJsonSafe(input) {
  if (typeof input !== 'string') {
    return { error: 'Input is not a string' };
  }

  let cleaned = input.trim();
  let hadWrapper = false;

  // Check for markdown wrapper
  const wrapperMatch = cleaned.match(MARKDOWN_JSON_WRAPPER);
  if (wrapperMatch) {
    cleaned = wrapperMatch[1].trim();
    hadWrapper = true;
  }

  try {
    const data = JSON.parse(cleaned);
    return { data, hadWrapper };
  } catch (err) {
    return { error: `JSON parse error: ${err.message}` };
  }
}

/**
 * Check if a value is a non-empty string.
 */
function isNonEmptyString(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

/**
 * Check if a string matches ISO 8601 date format.
 */
function isISO8601(val) {
  return typeof val === 'string' && ISO_8601_REGEX.test(val);
}

// ─── Phase 1 Validator (Scan Output) ─────────────────────────────────────────

/**
 * Validate Phase 1 scan output.
 * Expected: JSON array of items with fields: action, title, source, from, date, link
 * 
 * @param {string} jsonString - Raw JSON string to validate
 * @returns {ValidationReport}
 */
function validatePhase1Output(jsonString) {
  const report = new ValidationReport('phase1');
  const REQUIRED_FIELDS = ['action', 'title', 'source', 'from', 'date', 'link'];

  // Step 1: Parse JSON
  const parsed = parseJsonSafe(jsonString);
  if (parsed.error) {
    report.addError(parsed.error);
    return report;
  }

  if (parsed.hadWrapper) {
    report.addWarning('Response was wrapped in markdown code block (```json...```). Should return raw JSON.');
  }

  const data = parsed.data;

  // Step 2: Must be an array
  if (!Array.isArray(data)) {
    report.addError(`Expected JSON array, got ${typeof data}`);
    return report;
  }

  if (data.length === 0) {
    report.addWarning('Empty array — no items returned');
    return report;
  }

  report.addInfo(`Found ${data.length} items`);

  // Step 3: Validate each item
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    const itemErrors = [];
    const itemWarnings = [];

    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      itemErrors.push(`Item is not an object (got ${typeof item})`);
      report.addItemReport(i, itemErrors, itemWarnings);
      continue;
    }

    // Check required fields
    for (const field of REQUIRED_FIELDS) {
      if (!(field in item)) {
        itemErrors.push(`Missing required field: "${field}"`);
      }
    }

    // Validate action
    if (item.action !== undefined && !VALID_ACTIONS.has(item.action)) {
      itemErrors.push(`Invalid action: "${item.action}" (expected: ${[...VALID_ACTIONS].join(', ')})`);
    }

    // Validate source
    if (item.source !== undefined && !VALID_SOURCES.has(item.source)) {
      itemErrors.push(`Invalid source: "${item.source}" (expected: ${[...VALID_SOURCES].join(', ')})`);
    }

    // Validate date
    if (item.date !== undefined && !isISO8601(item.date)) {
      itemWarnings.push(`Date not ISO 8601: "${item.date}"`);
    }

    // Validate title (should be non-empty)
    if (item.title !== undefined && !isNonEmptyString(item.title)) {
      itemWarnings.push('Title is empty or not a string');
    }

    // Validate from (should be non-empty)
    if (item.from !== undefined && !isNonEmptyString(item.from)) {
      itemWarnings.push('"from" field is empty or not a string');
    }

    // Validate link (should be a URL-like string)
    if (item.link !== undefined && typeof item.link === 'string' && item.link.length > 0) {
      if (!item.link.startsWith('http://') && !item.link.startsWith('https://')) {
        itemWarnings.push(`Link doesn't look like a URL: "${item.link.substring(0, 50)}..."`);
      }
    }

    // Check for unexpected extra fields
    const extraFields = Object.keys(item).filter(k => !REQUIRED_FIELDS.includes(k));
    if (extraFields.length > 0) {
      itemWarnings.push(`Extra fields found: ${extraFields.join(', ')}`);
    }

    if (itemErrors.length > 0 || itemWarnings.length > 0) {
      report.addItemReport(i, itemErrors, itemWarnings);
    }
  }

  return report;
}

// ─── Phase 2 Validator (Summary/Briefing Output) ────────────────────────────

/**
 * Validate Phase 2 daily briefing output.
 * Expected: JSON object or structured text with summary, tasks, date references.
 * 
 * @param {string} jsonString - Raw response string
 * @returns {ValidationReport}
 */
function validatePhase2Output(jsonString) {
  const report = new ValidationReport('phase2');

  const parsed = parseJsonSafe(jsonString);
  if (parsed.error) {
    // Phase 2 may return structured text instead of JSON — that's acceptable
    report.addWarning(`Not valid JSON: ${parsed.error}. Checking as structured text.`);

    if (typeof jsonString === 'string' && jsonString.trim().length > 0) {
      const text = jsonString.trim();
      report.addInfo(`Response length: ${text.length} characters`);

      // Check for key structural elements
      if (text.length < 50) {
        report.addError('Response too short for a meaningful briefing (< 50 chars)');
      }
      if (!/\d{4}[-/]\d{2}[-/]\d{2}|today|yesterday|this week/i.test(text)) {
        report.addWarning('No date/temporal references found in briefing');
      }
    } else {
      report.addError('Response is empty');
    }
    return report;
  }

  if (parsed.hadWrapper) {
    report.addWarning('Response wrapped in markdown code block');
  }

  const data = parsed.data;

  // Validate as object
  if (typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data);
    report.addInfo(`Response has ${keys.length} top-level keys: ${keys.join(', ')}`);

    // Check for expected briefing fields
    const expectedFields = ['summary', 'tasks', 'highlights', 'items', 'date', 'briefing'];
    const found = expectedFields.filter(f => keys.some(k => k.toLowerCase().includes(f)));
    if (found.length === 0) {
      report.addWarning('No recognized briefing fields found (expected: summary, tasks, highlights, etc.)');
    }
  } else if (Array.isArray(data)) {
    report.addInfo(`Response is an array with ${data.length} items`);
  }

  return report;
}

// ─── Phase 3 Validator (Update Check Output) ─────────────────────────────────

/**
 * Validate Phase 3 update check output.
 * Expected: JSON array of updates with temporal metadata.
 * 
 * @param {string} jsonString - Raw response string
 * @returns {ValidationReport}
 */
function validatePhase3Output(jsonString) {
  const report = new ValidationReport('phase3');

  const parsed = parseJsonSafe(jsonString);
  if (parsed.error) {
    report.addError(parsed.error);
    return report;
  }

  if (parsed.hadWrapper) {
    report.addWarning('Response wrapped in markdown code block');
  }

  const data = parsed.data;

  if (!Array.isArray(data)) {
    // Could be an object with an updates array inside
    if (typeof data === 'object' && data !== null) {
      const updateArrayKey = Object.keys(data).find(k =>
        Array.isArray(data[k]) && ['updates', 'items', 'results', 'changes'].includes(k.toLowerCase())
      );
      if (updateArrayKey) {
        report.addInfo(`Found updates array under "${updateArrayKey}" key`);
        return validatePhase3Items(data[updateArrayKey], report);
      }
    }
    report.addError(`Expected array or object with updates array, got ${typeof data}`);
    return report;
  }

  return validatePhase3Items(data, report);
}

function validatePhase3Items(items, report) {
  if (items.length === 0) {
    report.addInfo('No updates found (empty array)');
    return report;
  }

  report.addInfo(`Found ${items.length} update items`);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemErrors = [];
    const itemWarnings = [];

    if (typeof item !== 'object' || item === null) {
      itemErrors.push('Item is not an object');
      report.addItemReport(i, itemErrors, itemWarnings);
      continue;
    }

    // Updates should have some form of title/description
    if (!item.title && !item.subject && !item.description && !item.summary) {
      itemWarnings.push('No title, subject, description, or summary found');
    }

    // Should have temporal information
    if (!item.date && !item.timestamp && !item.updated && !item.time) {
      itemWarnings.push('No temporal field found (date, timestamp, updated, time)');
    }

    // Should have source information
    if (!item.source && !item.from && !item.channel) {
      itemWarnings.push('No source field found (source, from, channel)');
    }

    if (itemErrors.length > 0 || itemWarnings.length > 0) {
      report.addItemReport(i, itemErrors, itemWarnings);
    }
  }

  return report;
}

// ─── Phase 4 Validator (Merge/Dedup Output) ──────────────────────────────────

/**
 * Validate Phase 4 merge/dedup output.
 * Expected: JSON with merge decisions and reasoning.
 * 
 * @param {string} jsonString - Raw response string
 * @returns {ValidationReport}
 */
function validatePhase4Output(jsonString) {
  const report = new ValidationReport('phase4');

  const parsed = parseJsonSafe(jsonString);
  if (parsed.error) {
    report.addError(parsed.error);
    return report;
  }

  if (parsed.hadWrapper) {
    report.addWarning('Response wrapped in markdown code block');
  }

  const data = parsed.data;

  // Phase 4 can be an array of merge groups or an object
  if (Array.isArray(data)) {
    report.addInfo(`Found ${data.length} merge groups/items`);

    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      const itemErrors = [];
      const itemWarnings = [];

      if (typeof item !== 'object' || item === null) {
        itemErrors.push('Item is not an object');
        report.addItemReport(i, itemErrors, itemWarnings);
        continue;
      }

      // Should have merge decision or action
      if (!item.action && !item.decision && !item.merge && !item.keep) {
        itemWarnings.push('No merge decision field found (action, decision, merge, keep)');
      }

      // Should have title or task reference
      if (!item.title && !item.task && !item.name && !item.id) {
        itemWarnings.push('No identifier field found (title, task, name, id)');
      }

      // Reasoning is important for merge decisions
      if (!item.reason && !item.reasoning && !item.explanation) {
        itemWarnings.push('No reasoning field found (reason, reasoning, explanation)');
      }

      if (itemErrors.length > 0 || itemWarnings.length > 0) {
        report.addItemReport(i, itemErrors, itemWarnings);
      }
    }
  } else if (typeof data === 'object' && data !== null) {
    const keys = Object.keys(data);
    report.addInfo(`Response object with keys: ${keys.join(', ')}`);

    // Check for expected merge output fields
    const mergeFields = ['merges', 'groups', 'decisions', 'actions', 'tasks', 'results'];
    const found = mergeFields.filter(f => keys.some(k => k.toLowerCase().includes(f)));
    if (found.length === 0) {
      report.addWarning('No recognized merge fields found');
    }
  } else {
    report.addError(`Expected array or object, got ${typeof data}`);
  }

  return report;
}

// ─── Unified Validator ───────────────────────────────────────────────────────

/**
 * Route to the correct phase validator.
 * @param {number|string} phase - Phase number (1-4) or name (phase1..phase4)
 * @param {string} jsonString - Raw response string
 * @returns {ValidationReport}
 */
function validateOutput(phase, jsonString) {
  const phaseNum = typeof phase === 'string' ? parseInt(phase.replace('phase', ''), 10) : phase;

  switch (phaseNum) {
    case 1: return validatePhase1Output(jsonString);
    case 2: return validatePhase2Output(jsonString);
    case 3: return validatePhase3Output(jsonString);
    case 4: return validatePhase4Output(jsonString);
    default:
      throw new Error(`Unknown phase: ${phase}. Valid phases: 1, 2, 3, 4`);
  }
}

// ─── CLI Formatting ──────────────────────────────────────────────────────────

function formatReport(report) {
  const json = report.toJSON();
  const lines = [];
  const divider = '─'.repeat(60);

  lines.push(`\n  Phase ${json.phase.replace('phase', '')} — Validation Report`);
  lines.push(`  ${divider}`);
  lines.push(`  Status:   ${json.valid ? '✓ VALID' : '✗ INVALID'}`);
  lines.push(`  Score:    ${json.score}/100`);
  lines.push(`  Errors:   ${json.summary.errors}`);
  lines.push(`  Warnings: ${json.summary.warnings}`);

  if (json.info.length > 0) {
    lines.push(`  ${divider}`);
    for (const info of json.info) {
      lines.push(`  ℹ ${info}`);
    }
  }

  if (json.errors.length > 0) {
    lines.push(`  ${divider}`);
    lines.push('  Errors:');
    for (const err of json.errors) {
      lines.push(`    ✗ ${err.message}`);
      if (err.context) lines.push(`      Context: ${err.context}`);
    }
  }

  if (json.warnings.length > 0) {
    lines.push(`  ${divider}`);
    lines.push('  Warnings:');
    for (const warn of json.warnings) {
      lines.push(`    ⚠ ${warn.message}`);
    }
  }

  if (json.itemReports.length > 0) {
    lines.push(`  ${divider}`);
    lines.push(`  Item Issues (${json.itemReports.length} items):`);
    // Show first 10 item issues to avoid flooding
    const shown = json.itemReports.slice(0, 10);
    for (const item of shown) {
      lines.push(`    [${item.index}]`);
      for (const e of item.errors)   lines.push(`      ✗ ${e}`);
      for (const w of item.warnings) lines.push(`      ⚠ ${w}`);
    }
    if (json.itemReports.length > 10) {
      lines.push(`    ... and ${json.itemReports.length - 10} more items with issues`);
    }
  }

  lines.push(`  ${divider}\n`);
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
  const jsonOutput = args.includes('--json');

  if (!phase || !file) {
    console.log(`
  Usage: node validate-output.js --phase <1-4> --file <response.json> [--json]

  Options:
    --phase     Phase number (1, 2, 3, or 4)
    --file      Path to the response file to validate
    --json      Output report as JSON instead of formatted text

  Examples:
    node validate-output.js --phase 1 --file scan-response.json
    node validate-output.js --phase 2 --file briefing.json --json
    `);
    process.exit(1);
  }

  // Load response file
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');

  let content;
  try {
    content = readFileSync(resolve(file), 'utf-8');
  } catch (err) {
    console.error(`  ✗ Error reading ${file}: ${err.message}`);
    process.exit(1);
  }

  const report = validateOutput(phase, content);

  if (jsonOutput) {
    console.log(JSON.stringify(report.toJSON(), null, 2));
  } else {
    console.log(formatReport(report));
  }

  // Exit with error code if invalid
  process.exit(report.isValid ? 0 : 1);
}

// ─── Module Exports (dual ESM/CJS support) ───────────────────────────────────

const exports_ = {
  validatePhase1Output,
  validatePhase2Output,
  validatePhase3Output,
  validatePhase4Output,
  validateOutput,
  ValidationReport
};

export {
  validatePhase1Output,
  validatePhase2Output,
  validatePhase3Output,
  validatePhase4Output,
  validateOutput,
  ValidationReport
};
export default exports_;

// CJS compatibility — detect if running as main script
const isMain = process.argv[1] && (
  process.argv[1].endsWith('validate-output.js') ||
  process.argv[1].endsWith('validate-output')
);

if (isMain) {
  main().catch(err => {
    console.error(`  ✗ Fatal: ${err.message}`);
    process.exit(1);
  });
}
