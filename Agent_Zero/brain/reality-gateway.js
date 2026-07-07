import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_TIMEOUT_MS, runBrain } from './brain-runner.js';
import { BRAIN_WORK_DIR } from './agency-cli.js';
import { BRAIN_RUN_CLASS } from './brain-scheduler.js';
import { containsFabricatedSourceToken } from './link-guard.js';
import {
  isActionLikeLineItem,
  validateActionGateForVisibleAction
} from './truth-tree.js';
import { renderBrainLearningsBlock, validateLearningPayload } from './learnings.js';

export const DEFAULT_GATEWAY_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
export const GATEWAY_DECISIONS = new Set(['approve', 'reject', 'needs-review']);
const GATEWAY_LINE_PREFIX = 'GATEWAY_DECISION';

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

function technicalGatewayReason(value) {
  const detail = String(value || 'unknown gateway error').replace(/\s+/g, ' ').trim();
  return `Gateway could not be verified this run; re-run scan (technical detail: ${detail}).`;
}

function normalizeParseText(text) {
  return String(text || '').replace(/^\uFEFF/, '').trim();
}

function balancedJsonSlice(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
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
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

function extractDecisionsObject(text) {
  const keyRegex = /"decisions"\s*:/g;
  let match;
  while ((match = keyRegex.exec(text))) {
    for (let start = match.index; start >= 0; start--) {
      if (text[start] !== '{') continue;
      const slice = balancedJsonSlice(text, start);
      if (!slice) continue;
      try {
        const parsed = JSON.parse(slice);
        if (Object.hasOwn(parsed, 'decisions')) return parsed;
      } catch {}
    }
  }

  throw new Error('gateway response is not strict JSON');
}

function extractJson(text) {
  const trimmed = normalizeParseText(text);
  if (!trimmed) throw new Error('empty gateway response');
  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(normalizeParseText(fenced[1]));
    } catch {}
  }

  return extractDecisionsObject(trimmed);
}

function parseMarkerIndex(value) {
  if (!/^\d+$/.test(String(value || '').trim())) return null;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function needsReviewDecision(markerIndex, reason) {
  return {
    markerIndex,
    decision: 'needs-review',
    reason: truncateReason(reason)
  };
}

function buildDecisionResult(rawDecisions, markerCount, { format, errors = [] } = {}) {
  const byIndex = new Map();
  const localErrors = [...errors];

  for (const item of normalizeArray(rawDecisions)) {
    const markerIndex = Number.isInteger(item?.markerIndex) ? item.markerIndex : null;
    const decision = typeof item?.decision === 'string' ? item.decision : null;
    if (markerIndex === null || markerIndex < 0 || markerIndex >= markerCount) {
      localErrors.push('decision has invalid markerIndex');
      continue;
    }
    if (!GATEWAY_DECISIONS.has(decision)) {
      byIndex.set(markerIndex, needsReviewDecision(markerIndex, 'Gateway decision was missing or invalid.'));
      localErrors.push(`decision ${markerIndex} has invalid decision`);
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
    decisions.push(byIndex.get(i) || needsReviewDecision(i, 'Gateway omitted this marker.'));
  }

  return {
    ok: localErrors.length === 0,
    errors: localErrors,
    decisions,
    totalParseFailure: false,
    format
  };
}

function parseGatewayDecisionLines(text, markerCount) {
  const lines = String(text || '').split(/\r?\n/);
  const rawDecisions = [];
  const errors = [];
  let matchedLines = 0;

  for (const line of lines) {
    const trimmed = normalizeParseText(line);
    if (!trimmed.startsWith(GATEWAY_LINE_PREFIX)) continue;
    matchedLines++;

    const tabParts = trimmed.split('\t');
    let markerIndex = null;
    let decision = null;
    let reason = null;

    if (tabParts.length >= 4 && tabParts[0] === GATEWAY_LINE_PREFIX) {
      markerIndex = parseMarkerIndex(tabParts[1]);
      decision = tabParts[2]?.trim();
      reason = tabParts.slice(3).join('\t').trim();
    } else {
      const match = trimmed.match(/^GATEWAY_DECISION\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (match) {
        markerIndex = parseMarkerIndex(match[1]);
        decision = match[2];
        reason = match[3].trim();
      }
    }

    if (markerIndex === null || markerIndex < 0 || markerIndex >= markerCount) {
      errors.push('gateway decision line has invalid markerIndex');
      continue;
    }

    if (!GATEWAY_DECISIONS.has(decision) || !reason) {
      errors.push(`gateway decision line ${markerIndex} is malformed`);
      rawDecisions.push({
        markerIndex,
        decision: 'needs-review',
        reason: 'Gateway decision line was malformed; marker held for review.'
      });
      continue;
    }

    rawDecisions.push({ markerIndex, decision, reason });
  }

  if (!matchedLines) {
    return { totalParseFailure: true };
  }

  return buildDecisionResult(rawDecisions, markerCount, { format: 'lines', errors });
}

export function parseGatewayDecisions(text, markerCount) {
  const lineParse = parseGatewayDecisionLines(text, markerCount);
  if (!lineParse.totalParseFailure) return lineParse;

  try {
    const parsed = extractJson(text);
    return buildDecisionResult(parsed.decisions, markerCount, { format: 'json' });
  } catch (err) {
    const reason = technicalGatewayReason(err.message);
    return {
      ok: false,
      error: err.message,
      decisions: Array.from({ length: markerCount }, (_, index) => needsReviewDecision(index, reason)),
      totalParseFailure: true,
      format: null
    };
  }
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

function flatSectionPatches(sectionPatches) {
  if (Array.isArray(sectionPatches)) return sectionPatches;
  if (!sectionPatches || typeof sectionPatches !== 'object' || Array.isArray(sectionPatches)) return [];
  const result = [];
  for (const [section, patches] of Object.entries(sectionPatches)) {
    for (const patch of normalizeArray(patches)) result.push({ section, ...patch });
  }
  return result;
}

function actionGateIssue(marker) {
  const payload = marker?.payload || {};
  const pmActions = normalizeArray(payload.pmStatus?.userActions);
  for (const [index, entry] of pmActions.entries()) {
    const error = validateActionGateForVisibleAction(entry, { pathName: `pmStatus.userActions[${index}]` });
    if (error) return error;
  }

  const lineItems = [
    ...normalizeArray(payload.lineItems),
    payload.lineItem
  ].filter(Boolean);
  for (const [index, item] of lineItems.entries()) {
    if (!isActionLikeLineItem(item)) continue;
    const error = validateActionGateForVisibleAction(item, { pathName: `lineItems[${index}]` });
    if (error) return error;
  }

  if (marker?.type === 'LINEITEM_UPDATE' && payload.patch && isActionLikeLineItem(payload.patch)) {
    const error = validateActionGateForVisibleAction(payload.patch, { pathName: 'LINEITEM_UPDATE.patch' });
    if (error) return error;
  }

  for (const [index, patch] of flatSectionPatches(payload.sectionPatches).entries()) {
    if (patch.section !== 'openActions') continue;
    if ((patch.op || 'add') === 'remove') continue;
    const error = validateActionGateForVisibleAction(patch, { pathName: `factSheet.openActions[${index}]` });
    if (error) return error;
  }

  return null;
}

export function deterministicMarkerIssue(marker) {
  const payload = marker?.payload || {};

  const fabricatedField = payloadHasFabricatedFreeText(payload);
  if (fabricatedField) return `Fabricated WorkIQ citation token found in ${fabricatedField}.`;

  const actionIssue = actionGateIssue(marker);
  if (actionIssue) return `Batch 7 action gate failed: ${actionIssue}.`;

  if (marker.type === 'LEARNING') {
    const learningIssue = validateLearningPayload(payload);
    if (learningIssue) return `Learning gate failed: ${learningIssue}.`;
  }

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
          reason: technicalGatewayReason(gatewayResult.error?.message || gatewayResult.error || 'gateway failed')
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

export function buildGatewayPrompt({ stateFile, factSheetFiles = [], markers, runId, learningsBlock = renderBrainLearningsBlock().markdown }) {
  const stateFileName = path.basename(stateFile);
  const markerLines = markers.map((marker, index) => `${index}: ${markerLine(marker)}`).join('\n');
  const factSheetList = factSheetFiles.length
    ? factSheetFiles.map(name => `- ./${name}`).join('\n')
    : '- none';

  return [
    '# Agent Zero Reality-Check Gateway',
    '',
    'You are an adversarial verifier. You may only approve or hold the proposed marker lines.',
    'Read the state file, Fact Sheets, Brain Learnings, and available evidence before deciding. Read/research/browse tools are allowed when they help verify marker evidence.',
    'External write actions are forbidden unless the user explicitly requested that exact write in this same conversation. Do not send mail, click approvals, edit external systems, or mutate Agent Zero state directly.',
    'Always write gateway reasons and any generated review text in English.',
    '',
    `runId: ${runId}`,
    `stateFile: ./${stateFileName}`,
    '',
    learningsBlock.trimEnd(),
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
    '- Is every pmStatus.userActions entry really an action for Martin, the app user, rather than another project member?',
    '- For every visible action, does the payload include askQuote {text, from, date, threadRef}, threadRef as a stable conversation/item id, resolutionStatus:"open", complete threadCheck coverage, messageCount, lastMessageDate, and lastVerifiedMessageDate not older than the last thread message?',
    '- Did the action proof check later messages for resolution, and does it avoid stale past-date requests unless currentJustificationQuote proves the action remains open?',
    '- Are actions for other people represented as lineItems or Fact Sheet Open Actions with an explicit owner?',
    '- Are processing ledger items well-formed, including quote and reason for no-change or not-this-project dispositions?',
    '- If a node is disputed, does it keep both conflicting positions with person/date/quote and surface the conflict instead of choosing silently?',
    '- If a user action was marked done by Martin, does current evidence confirm closure or show it is still open?',
    '- Is the result internally consistent, e.g. not done and waiting at the same time?',
    '- Are source links verbatim real WorkIQ links, not constructed citation-token URLs?',
    '- Was available evidence used instead of ignored, including full message bodies and attachments when the marker depends on them?',
    '- If the run discovered or referenced PDF, DOCX, XLSX, or other source attachments, were they downloaded/read and represented as source evidence before approving?',
    '- For LEARNING markers: approve only reusable principles, patterns, or stable general facts; reject task facts, secrets, credentials, and one-off project state.',
    '',
    'Default to needs-review on country/location/organization mismatch, missing evidence, mixed projects, fabricated links, or inconsistency.',
    'NEEDS_REVIEW and SCAN_DONE markers are exempt from veto.',
    'You are subtractive only: never add, rewrite, or fix marker payloads.',
    '',
    'Output contract:',
    `- Return exactly one physical line per marker using: ${GATEWAY_LINE_PREFIX}<TAB>markerIndex<TAB>approve|reject|needs-review<TAB>one sentence reason`,
    `- The first characters of your reply must be ${GATEWAY_LINE_PREFIX}.`,
    '- No preamble, no reasoning outside the reason field, no JSON, no code fence.',
    '',
    'Markers:',
    markerLines
  ].join('\n');
}

function buildGatewayRetryPrompt({ stateFile, factSheetFiles = [], markers, runId, parseError }) {
  return [
    buildGatewayPrompt({ stateFile, factSheetFiles, markers, runId }),
    '',
    '# Retry Constraint',
    `The previous gateway response could not be parsed (${parseError || 'unknown parse error'}).`,
    'This is the only retry. Return only the tab-delimited GATEWAY_DECISION lines, with no prose and no code fence.'
  ].join('\n');
}

function addGatewayCounters(first = {}, second = {}) {
  const keys = new Set([...Object.keys(first || {}), ...Object.keys(second || {})]);
  const result = {};
  for (const key of keys) {
    const a = typeof first?.[key] === 'number' ? first[key] : 0;
    const b = typeof second?.[key] === 'number' ? second[key] : 0;
    result[key] = a + b;
  }
  return result;
}

function normalizeGatewayRunResult(result) {
  return {
    ok: Boolean(result.ok),
    text: result.assistantText || result.text || '',
    error: result.error || null,
    counters: result.counters || {},
    durationMs: result.durationMs
  };
}

export async function runRealityGateway({
  stateFile,
  factSheetFiles = [],
  markers,
  brainWorkDir = BRAIN_WORK_DIR,
  runId = `gateway-${Date.now()}`,
  runClass = BRAIN_RUN_CLASS.BACKGROUND,
  onSchedulerUpdate = null,
  _runBrain = runBrain
} = {}) {
  if (!stateFile || !fs.existsSync(stateFile)) {
    return { ok: false, error: `missing stateFile: ${stateFile || '(none)'}` };
  }

  const prompt = buildGatewayPrompt({ stateFile, factSheetFiles, markers, runId });
  const firstResult = await _runBrain({
    prompt,
    brainWorkDir,
    timeoutMs: DEFAULT_GATEWAY_TIMEOUT_MS,
    runClass,
    effort: process.env.AGENT_ZERO_BRAIN_EFFORT || 'xhigh',
    schedulerLabel: `${runClass}:gateway:${runId}`,
    onSchedulerUpdate,
    cleanBrainWorkDir: false
  });
  const first = normalizeGatewayRunResult(firstResult);
  const firstParse = first.ok ? parseGatewayDecisions(first.text, markers.length) : null;

  if (!firstParse?.totalParseFailure) return first;

  const retryPrompt = buildGatewayRetryPrompt({
    stateFile,
    factSheetFiles,
    markers,
    runId,
    parseError: firstParse.error
  });
  const retryResult = await _runBrain({
    prompt: retryPrompt,
    brainWorkDir,
    timeoutMs: DEFAULT_GATEWAY_TIMEOUT_MS,
    runClass,
    effort: process.env.AGENT_ZERO_BRAIN_EFFORT || 'xhigh',
    schedulerLabel: `${runClass}:gateway-retry:${runId}`,
    onSchedulerUpdate,
    cleanBrainWorkDir: false
  });
  const retry = normalizeGatewayRunResult(retryResult);
  return {
    ...retry,
    error: retry.ok ? retry.error : retry.error || `gateway retry failed after parse failure: ${firstParse.error}`,
    counters: addGatewayCounters(first.counters, retry.counters),
    durationMs: (first.durationMs || 0) + (retry.durationMs || 0),
    retryCount: 1,
    firstParseError: firstParse.error
  };
}
