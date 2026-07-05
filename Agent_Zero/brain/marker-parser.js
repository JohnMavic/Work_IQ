export const MARKER_TYPES = Object.freeze([
  'PROJECT_NEW',
  'PROJECT_UPDATE',
  'LINEITEM_NEW',
  'LINEITEM_UPDATE',
  'TASK_NEW',
  'TASK_UPDATE',
  'NEEDS_REVIEW',
  'SCAN_DONE'
]);

const MARKER_TAG_PATTERN = MARKER_TYPES.map(type => type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
export const MARKER_REGEX = new RegExp(`^\\[(${MARKER_TAG_PATTERN})\\]\\s+(\\{.*\\})\\s*$`);

export function parseMarkers(text) {
  const markers = [];
  const errors = [];
  let inFence = false;
  const lines = String(text || '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = line.match(MARKER_REGEX);
    if (!match) continue;

    try {
      markers.push({
        type: match[1],
        payload: JSON.parse(match[2]),
        line: i + 1,
        raw: line
      });
    } catch (err) {
      errors.push({
        line: i + 1,
        raw: line,
        error: err.message
      });
    }
  }

  return { markers, errors };
}
