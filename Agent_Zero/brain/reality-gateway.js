import fs from 'node:fs';
import path from 'node:path';
import { runBrain } from './brain-runner.js';
import { BRAIN_WORK_DIR } from './agency-cli.js';
import { containsFabricatedSourceToken } from './link-guard.js';

export const DEFAULT_GATEWAY_TIMEOUT_MS = 5 * 60 * 1000;
export const GATEWAY_DECISIONS = new Set(['approve', 'reject', 'needs-review']);

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function markerLine(marker) {
  return marker?.raw || `[${marker.type}] ${JSON.stringify(marker.payload || {})}`;
}

function truncateReason(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'Gateway did not provide a reason.';
  const firstSentence = text.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || text;
  return firstSentence.length <= 240 ? firstSentence : `${firstSentence.slice(0, 237).trimEnd()}...`;
}

function extractJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('empty gateway response');
  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1].trim());

  const decisionsStart = trimmed.indexOf('{"decisions"');
  if (decisionsStart >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = decisionsStart; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return JSON.parse(trimmed.slice(decisionsStart, i + 1));
      }
    }
  }

  throw new Error('gateway response is not strict JSON');
}

export function parseGatewayDecisions(text, markerCount) {
  let parsed;
  try {
    parsed = extractJson(text);
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      decisions: Array.from({ length: markerCount }, (_, index) => ({
        markerIndex: index,
        decision: 'needs-review',
        reason: `Gateway parse failed: ${err.message}`
      }))
    };
  }

  const rawDecisions = normalizeArray(parsed.decisions);
  const byIndex = new Map();
  const errors = [];

  for (const item of rawDecisions) {
    const markerIndex = Number.isInteger(item?.markerIndex) ? item.markerIndex : null;
    const decision = typeof item?.decision === 'string' ? item.decision : null;
    if (markerIndex === null || markerIndex < 0 || markerIndex >= markerCount) {
      errors.push('decision has invalid markerIndex');
      continue;
    }
    if (!GATEWAY_DECISIONS.has(decision)) {
      byIndex.set(markerIndex, {
        markerIndex,
        decision: 'needs-review',
        reason: 'Gateway decision was missing or invalid.'
      });
      continue;
    }
    byIndex.set(markerIndex, {
      markerIndex,
      decision,
      reason: truncateReason(item.reason)
    });
  }

  const decisions = [];
  for (let i = 0; i < markerCount; i++) {
    decisions.push(byIndex.get(i) || {
      markerIndex: i,
      decision: 'needs-review',
      reason: 'Gateway omitted this marker.'
    });
  }

  return { ok: errors.length === 0, errors, decisions };
}

function isGatewayExempt(marker) {
  return marker?.type === 'NEEDS_REVIEW' || marker?.type === 'SCAN_DONE';
}

function isGatewayFailureAutoApply(marker) {
  return marker?.type === 'TASK_NEW' || marker?.type === 'NEEDS_REVIEW' || marker?.type === 'SCAN_DONE';
}

function statusIsDone(value) {
  return ['done', 'completed'].includes(String(value || '').toLowerCase());
}

function textClaimsDone(value) {
  return /\b(done|complete|completed|closed|finished|abgeschlossen|erledigt)\b/i.test(String(value || ''));
}

function hasWaitingValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (!value) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

function payloadHasFabricatedFreeText(value, pathParts = []) {
  if (typeof value === 'string') {
    const key = pathParts.at(-1);
    if (key === 'link' || key === 'url') return null;
    return containsFabricatedSourceToken(value) ? pathParts.join('.') || 'payload' : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = payloadHasFabricatedFreeText(value[i], [...pathParts, String(i)]);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const found = payloadHasFabricatedFreeText(child, [...pathParts, key]);
      if (found) return found;
    }
  }
  return null;
}

export function deterministicMarkerIssue(marker) {
  const payload = marker?.payload || {};

  const fabricatedField = payloadHasFabricatedFreeText(payload);
  if (fabricatedField) return `Fabricated WorkIQ citation token found in ${fabricatedField}.`;

  if (marker.type === 'LINEITEM_NEW') {
    const item = payload.lineItem || {};
    if (statusIsDone(item.status) && hasWaitingValue(item.waitingOn)) {
      return 'Line item is marked done while still waiting on another party.';
    }
  }

  if (marker.type === 'LINEITEM_UPDATE') {
    const patch = payload.patch || {};
    if (statusIsDone(patch.status) && hasWaitingValue(patch.waitingOn)) {
      return 'Line item update marks the item done while still waiting on another party.';
    }
  }

  if (marker.type === 'TASK_UPDATE') {
    const patch = payload.patch || {};
    if (statusIsDone(patch.status) && /\b(waiting|wartet|blocked by)\b/i.test(String(patch.summary || patch.notes || ''))) {
      return 'Task update marks the task done while the text says it is still waiting.';
    }
  }

  if (marker.type === 'PROJECT_UPDATE' || marker.type === 'PROJECT_NEW') {
    const pm = payload.pmStatus || {};
    if (textClaimsDone(pm.current) && normalizeArray(pm.waitingOn).length > 0) {
      return 'Project PM status claims completion while waitingOn is still populated.';
    }
    for (const item of normalizeArray(payload.lineItems)) {
      if (statusIsDone(item.status) && hasWaitingValue(item.waitingOn)) {
        return 'Project line item is marked done while still waiting on another party.';
      }
    }
  }

  return null;
}

function reviewMarkerFor(original, reason, index) {
  const payload = {
    kind: 'other',
    ref: null,
    question: `Reality gateway held marker #${index + 1} (${original.type}): ${truncateReason(reason)}`,
    confidence: 'low'
  };
  return {
    type: 'NEEDS_REVIEW',
    payload,
    line: original.line ?? null,
    raw: `[NEEDS_REVIEW] ${JSON.stringify(payload)}`
  };
}

export function filterMarkersThroughGateway(markers, gatewayResult = {}) {
  const approved = [];
  const held = [];
  const parse = gatewayResult.ok
    ? parseGatewayDecisions(gatewayResult.text || gatewayResult.assistantText || '', markers.length)
    : {
        ok: false,
        error: gatewayResult.error?.message || gatewayResult.error || 'gateway failed',
        decisions: markers.map((_, markerIndex) => ({
          markerIndex,
          decision: 'needs-review',
          reason: gatewayResult.error?.message || gatewayResult.error || 'gateway failed'
        }))
      };

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    if (isGatewayExempt(marker)) {
      approved.push(marker);
      continue;
    }

    const deterministicIssue = deterministicMarkerIssue(marker);
    if (deterministicIssue) {
      held.push({ index: i, marker, reason: deterministicIssue, source: 'deterministic' });
      continue;
    }

    if (!gatewayResult.ok) {
      if (isGatewayFailureAutoApply(marker)) approved.push(marker);
      else held.push({ index: i, marker, reason: parse.decisions[i]?.reason || 'Gateway failed fail-closed.', source: 'gateway-failure' });
      continue;
    }

    const decision = parse.decisions[i];
    if (decision?.decision === 'approve') {
      approved.push(marker);
    } else {
      held.push({
        index: i,
        marker,
        reason: decision?.reason || 'Gateway did not explicitly approve this marker.',
        source: 'gateway'
      });
    }
  }

  const reviewMarkers = held.map(item => reviewMarkerFor(item.marker, item.reason, item.index));
  return {
    markers: [...approved, ...reviewMarkers],
    approved,
    held,
    reviewMarkers,
    gatewayParsed: parse.ok,
    gatewayParseError: parse.error || null,
    decisions: parse.decisions
  };
}

function buildGatewayPrompt({ stateFile, factSheetFiles = [], markers, runId }) {
  const stateFileName = path.basename(stateFile);
  const markerLines = markers.map((marker, index) => `${index}: ${markerLine(marker)}`).join('\n');
  const factSheetList = factSheetFiles.length
    ? factSheetFiles.map(name => `- ./${name}`).join('\n')
    : '- none';

  return [
    '# Agent Zero Reality-Check Gateway',
    '',
    'You are an adversarial verifier. You may only approve or hold the proposed marker lines.',
    'Do not call WorkIQ or any external tool. Read only files in the current working directory.',
    '',
    `runId: ${runId}`,
    `stateFile: ./${stateFileName}`,
    '',
    'Read the state file and every Fact Sheet file listed below before deciding.',
    '',
    'Fact Sheet files:',
    factSheetList,
    '',
    'Apply this checklist to every non-exempt marker:',
    '- Which task/project can this information be safely assigned to?',
    '- Is it new or stale versus the Fact Sheet and lastEvidenceAt?',
    '- Must the project be updated, and would not updating be wrong?',
    '- Does the Fact Sheet contain an error corrected by this information?',
    '- Is it really this project, not a similar one in another country, location, or organization?',
    '- Is Martin involved?',
    '- Is the result internally consistent, e.g. not done and waiting at the same time?',
    '- Are source links verbatim real WorkIQ links, not constructed citation-token URLs?',
    '',
    'Default to needs-review on country/location/organization mismatch, missing evidence, mixed projects, fabricated links, or inconsistency.',
    'NEEDS_REVIEW and SCAN_DONE markers are exempt from veto.',
    'You are subtractive only: never add, rewrite, or fix marker payloads.',
    '',
    'Return strict JSON only, exactly:',
    '{"decisions":[{"markerIndex":0,"decision":"approve|reject|needs-review","reason":"one sentence"}]}',
    '',
    'Markers:',
    markerLines
  ].join('\n');
}

export async function runRealityGateway({
  stateFile,
  factSheetFiles = [],
  markers,
  brainWorkDir = BRAIN_WORK_DIR,
  runId = `gateway-${Date.now()}`,
  _runBrain = runBrain
} = {}) {
  if (!stateFile || !fs.existsSync(stateFile)) {
    return { ok: false, error: `missing stateFile: ${stateFile || '(none)'}` };
  }

  const prompt = buildGatewayPrompt({ stateFile, factSheetFiles, markers, runId });
  const result = await _runBrain({
    prompt,
    brainWorkDir,
    timeoutMs: DEFAULT_GATEWAY_TIMEOUT_MS,
    workIqHardLimit: 0,
    callerArgs: ['--disable-mcp-server', 'workiq'],
    cleanBrainWorkDir: false
  });

  return {
    ok: Boolean(result.ok),
    text: result.assistantText || result.text || '',
    error: result.error || null,
    counters: result.counters || {},
    durationMs: result.durationMs
  };
}
