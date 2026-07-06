import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} did not close`);
}

test('UI date helpers omit unparseable dates instead of rendering Invalid Date', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  const names = [
    'asArray',
    'validSourceHref',
    'sourceRefHref',
    'sourceRefDate',
    'parseDateValue',
    'parseDateMs',
    'formatSourceDate',
    'sourceDisplayDate',
    'sourceLinkLabel',
    'sourceRefTooltip',
    'buildTaskMeta',
    'formatDate',
    'formatDateTime'
  ];
  const code = [
    'function escHtml(value) { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }',
    ...names.map(name => extractFunction(html, name)),
    `const meta = buildTaskMeta({
      source: 'email',
      from: 'Alex',
      date: 'Same team thread',
      link: null,
      sourceRefs: [{ id: 'src-1', title: 'Source', date: 'Yesterday afternoon', link: null }]
    });
    result = {
      sourceDate: formatSourceDate('Yesterday afternoon'),
      dateTime: formatDateTime('Last Tuesday'),
      fullDate: formatDate('Same team thread'),
      sourceLabel: sourceLinkLabel('Open source', { date: 'Yesterday afternoon' }, 'bad date'),
      tooltip: sourceRefTooltip({ id: 'src-1', title: 'Source', date: 'Yesterday afternoon' }),
      meta
    };`
  ].join('\n\n');
  const context = { result: null };

  vm.runInNewContext(code, context);
  const rendered = JSON.stringify(context.result);

  assert.equal(context.result.sourceDate, '');
  assert.equal(context.result.dateTime, '');
  assert.equal(context.result.fullDate, '');
  assert.equal(context.result.meta.dateText, '');
  assert.doesNotMatch(rendered, /Invalid Date/);
});
