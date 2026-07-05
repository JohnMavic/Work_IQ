import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const serverSource = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
const schedulerSource = fs.readFileSync(path.join(repoRoot, 'Start-WorkIQ-Scan.ps1'), 'utf8');
const whoIsSource = fs.readFileSync(path.join(repoRoot, 'who-is-agent-zero.ps1'), 'utf8');
const mcpConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'mcp.json'), 'utf8'));

function snippetBetween(startNeedle, endNeedle) {
  const start = serverSource.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing start marker: ${startNeedle}`);
  const end = serverSource.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `missing end marker after ${startNeedle}: ${endNeedle}`);
  return serverSource.slice(start, end);
}

test('legacy SDK HTTP routes are gated before legacy runtime work', () => {
  const routes = [
    {
      start: "app.post('/api/tasks/:id/log'",
      end: "// GET /api/tasks",
      guard: "guardLegacyRoute(res, '/api/tasks/:id/log'",
      legacyWork: 'runLogJob(job)'
    },
    {
      start: "app.post('/api/scan'",
      end: "// POST /api/tasks/:id/enrich",
      guard: "guardLegacyRoute(res, '/api/scan'",
      legacyWork: 'askWorkIQDirect(emailQuery'
    },
    {
      start: "app.post('/api/tasks/:id/enrich'",
      end: "// POST /api/tasks/:id/check-update",
      guard: "guardLegacyRoute(res, '/api/tasks/:id/enrich'",
      legacyWork: 'new CopilotClient()'
    },
    {
      start: "app.post('/api/tasks/:id/check-update'",
      end: "// POST /api/consolidate",
      guard: "guardLegacyRoute(res, '/api/tasks/:id/check-update'",
      legacyWork: 'new CopilotClient()'
    },
    {
      start: "app.post('/api/consolidate'",
      end: "// POST /api/tasks/merge",
      guard: "guardLegacyRoute(res, '/api/consolidate'",
      legacyWork: 'new CopilotClient()'
    },
    {
      start: "app.post('/api/tasks/merge'",
      end: "app.post('/api/tasks/:id/dismiss-merge'",
      guard: "guardLegacyRoute(res, '/api/tasks/merge'",
      legacyWork: 'new CopilotClient()'
    },
    {
      start: "app.post('/api/tasks/:id/review'",
      end: "// POST /api/tasks/:id/correct",
      guard: "guardLegacyRoute(res, '/api/tasks/:id/review'",
      legacyWork: 'new CopilotClient()'
    },
    {
      start: "app.post('/api/tasks/:id/correct'",
      end: "// POST /api/tasks/:id/correct/resolve",
      guard: "guardLegacyRoute(res, '/api/tasks/:id/correct'",
      legacyWork: 'new CopilotClient()'
    }
  ];

  for (const route of routes) {
    const body = snippetBetween(route.start, route.end);
    const guardIndex = body.indexOf(route.guard);
    const workIndex = body.indexOf(route.legacyWork);
    assert.notEqual(guardIndex, -1, `${route.start} missing legacy guard`);
    assert.notEqual(workIndex, -1, `${route.start} missing expected legacy work marker`);
    assert.ok(guardIndex < workIndex, `${route.start} guard must run before legacy work`);
  }
});

test('legacy merge and consolidate jobs are rejected before job enqueue in agency mode', () => {
  const jobsRoute = snippetBetween("app.post('/api/jobs'", "// GET /api/jobs?active=true");
  const guardIndex = jobsRoute.indexOf("kind === 'consolidate' || kind === 'merge'");
  const enqueueIndex = jobsRoute.indexOf('registerJob(job)');
  assert.notEqual(guardIndex, -1);
  assert.notEqual(enqueueIndex, -1);
  assert.ok(guardIndex < enqueueIndex);
});

test('legacy WorkIQ subprocess is skipped outside legacy engine while health remains compatible', () => {
  const startupBlock = snippetBetween('app.listen(PORT', "}).on('error'");
  assert.match(startupBlock, /if \(isLegacyScanEngine\(\)\) \{/);
  assert.match(startupBlock, /await startWorkIQMCP\(\)/);
  assert.match(startupBlock, /Skipped legacy persistent MCP subprocess/);

  const healthBlock = snippetBetween("app.get('/api/health'", '// GET/POST /api/debug-log');
  assert.match(healthBlock, /scanEngine: currentScanEngine\(\)/);
  assert.match(healthBlock, /wiqPid:/);
});

test('diagnostic and scheduler scripts tolerate agency health with wiqPid null', () => {
  assert.match(schedulerSource, /\$scanEngine = if \(\$health\.scanEngine\)/);
  assert.match(schedulerSource, /\$wiqHealthy = \(-not \$wiqRequired\) -or \[bool\]\$health\.wiqPid/);
  assert.match(schedulerSource, /Agency engine \(wiqPid not required\)/);
  assert.match(whoIsSource, /engine=\$\(\$h\.scanEngine\)/);
});

test('mcp.json documents legacy-only handling', () => {
  assert.match(mcpConfig.mcpServers.workiq.description, /Legacy SDK-only/);
  assert.match(mcpConfig.mcpServers.workiq.description, /Agency runner does not read this file/);
});
