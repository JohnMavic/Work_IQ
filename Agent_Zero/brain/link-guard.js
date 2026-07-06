export const FABRICATED_SOURCE_TOKEN_PATTERN = /\bturn\d+search\d+\b/i;
export const FABRICATED_SOURCE_TOKEN_GLOBAL_PATTERN = /\bturn\d+search\d+\b/gi;
export const FABRICATED_SOURCE_URL_GLOBAL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]*turn\d+search\d+[^\s<>"')\]]*/gi;

function normalizeLink(link) {
  return typeof link === 'string' ? link.trim() : link;
}

export function containsFabricatedSourceToken(value) {
  return typeof value === 'string' && FABRICATED_SOURCE_TOKEN_PATTERN.test(value);
}

export function isWhitelistedSourceLink(link) {
  const value = normalizeLink(link);
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false;
  if (containsFabricatedSourceToken(value)) return false;

  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  const host = url.hostname.toLowerCase();
  const pathname = url.pathname.toLowerCase();

  if ((host === 'outlook.office.com' || host === 'outlook.office365.com') &&
      (pathname.startsWith('/owa') || pathname.startsWith('/mail'))) {
    return true;
  }

  if (host === 'teams.microsoft.com' && pathname.startsWith('/l/')) {
    return true;
  }

  return false;
}

export function sourceLinkVerdict(link) {
  if (link === null || link === undefined || link === '') {
    return { ok: true, reason: null, normalized: null, whitelisted: false, auditOnly: false };
  }

  const normalized = normalizeLink(link);
  if (typeof normalized !== 'string') {
    return {
      ok: false,
      reason: 'sourceRef.link must be a string',
      normalized: null,
      whitelisted: false,
      auditOnly: false
    };
  }

  if (containsFabricatedSourceToken(normalized)) {
    return {
      ok: false,
      reason: 'sourceRef.link contains fabricated WorkIQ citation token',
      normalized,
      whitelisted: false,
      auditOnly: false
    };
  }

  if (!/^https?:\/\//i.test(normalized)) {
    return {
      ok: false,
      reason: 'sourceRef.link must start with http(s)://',
      normalized,
      whitelisted: false,
      auditOnly: false
    };
  }

  if (normalized.includes('...')) {
    return {
      ok: false,
      reason: 'sourceRef.link must not contain ...',
      normalized,
      whitelisted: false,
      auditOnly: false
    };
  }

  const whitelisted = isWhitelistedSourceLink(normalized);
  return {
    ok: true,
    reason: null,
    normalized,
    whitelisted,
    auditOnly: !whitelisted
  };
}

export function invalidSourceLinkReason(link) {
  const verdict = sourceLinkVerdict(link);
  return verdict.ok ? null : verdict.reason;
}

export function isUsableSourceLink(link) {
  return sourceLinkVerdict(link).ok && typeof sourceLinkVerdict(link).normalized === 'string';
}

export function sanitizeFabricatedSourceText(text) {
  if (typeof text !== 'string' || !containsFabricatedSourceToken(text)) {
    return { text, changed: false };
  }

  const sanitized = text
    .replace(FABRICATED_SOURCE_URL_GLOBAL_PATTERN, '[removed fabricated source link]')
    .replace(FABRICATED_SOURCE_TOKEN_GLOBAL_PATTERN, '[removed fabricated source token]');

  return { text: sanitized, changed: sanitized !== text };
}
