/**
 * Timing Test: Phase 2 Only — Full Content Extraction
 * Misst wie lange es dauert, den Email/Teams Body zu lesen und zusammenzufassen.
 */

const BASE_URL = 'http://localhost:3000';

async function measureTime(label, fn) {
  const start = Date.now();
  const result = await fn();
  const duration = Date.now() - start;
  console.log(`  [TIMING] ${label}: ${(duration / 1000).toFixed(1)}s`);
  return { result, duration };
}

async function run() {
  console.log('='.repeat(70));
  console.log('TIMING TEST: Phase 2 — Full Content Extraction');
  console.log('='.repeat(70));
  console.log(`Datum: ${new Date().toISOString()}`);
  console.log('');

  // Get pending tasks
  const r = await fetch(`${BASE_URL}/api/tasks`);
  const data = await r.json();
  const tasks = data.tasks || data;
  const pending = tasks.filter(t => t.enrichmentStatus === 'pending' && t.status !== 'done');

  console.log(`Pending tasks: ${pending.length}`);
  console.log('');

  const results = [];

  for (let i = 0; i < pending.length; i++) {
    const task = pending[i];
    const shortTitle = task.title.substring(0, 55);
    console.log(`[${i + 1}/${pending.length}] "${shortTitle}"`);
    console.log(`  Source: ${task.source} | From: ${task.from}`);

    const enrichResult = await measureTime('Enrichment', async () => {
      const resp = await fetch(`${BASE_URL}/api/tasks/${task.id}/enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      return resp.json();
    });

    const enrichedTask = enrichResult.result.task || enrichResult.result;
    const summary = enrichedTask.summary || enrichedTask.notes || 'keine Summary';

    results.push({
      title: task.title,
      source: task.source,
      from: task.from,
      durationMs: enrichResult.duration,
      durationSeconds: +(enrichResult.duration / 1000).toFixed(1),
      confidence: enrichedTask.confidence || 'unknown',
      summaryLength: summary.length,
      summaryPreview: summary.substring(0, 120)
    });

    console.log(`  Confidence: ${enrichedTask.confidence || '?'} | Summary: ${summary.substring(0, 80)}...`);
    console.log('');
  }

  // Zusammenfassung
  console.log('='.repeat(70));
  console.log('ERGEBNIS: Phase 2 Timing');
  console.log('='.repeat(70));
  console.log('');

  const totalTime = results.reduce((s, r) => s + r.durationMs, 0);
  const avgTime = results.length > 0 ? totalTime / results.length : 0;

  console.log(`Tasks enriched: ${results.length}`);
  console.log(`Gesamtzeit: ${(totalTime / 1000).toFixed(1)}s`);
  console.log(`Durchschnitt pro Task: ${(avgTime / 1000).toFixed(1)}s`);
  console.log(`Schnellster: ${results.length > 0 ? (Math.min(...results.map(r => r.durationMs)) / 1000).toFixed(1) : 0}s`);
  console.log(`Langsamster: ${results.length > 0 ? (Math.max(...results.map(r => r.durationMs)) / 1000).toFixed(1) : 0}s`);
  console.log('');

  // Vergleich mit Phase 1
  const phase1Time = 140.5; // Gemessen im vorherigen Test
  console.log('='.repeat(70));
  console.log('VERGLEICH: Subject-Only vs. Full Content');
  console.log('='.repeat(70));
  console.log('');
  console.log(`Phase 1 (Subject-Only Scan, alle Messages):  ${phase1Time}s`);
  console.log(`Phase 2 (Full Content, ${results.length} Tasks):            ${(totalTime / 1000).toFixed(1)}s`);
  console.log(`Phase 2 Durchschnitt pro Task:                ${(avgTime / 1000).toFixed(1)}s`);
  console.log('');

  // Hochrechnung
  const messagesInInbox = 50; // typische Inbox-Grösse
  const estimatedFullScan = messagesInInbox * (avgTime / 1000);
  console.log('--- Hochrechnung: Was wenn JEDE Nachricht auch Body lesen würde? ---');
  console.log(`Typische Inbox (${messagesInInbox} Messages):`);
  console.log(`  Subject-Only:        ${phase1Time}s (${(phase1Time / 60).toFixed(1)} Minuten)`);
  console.log(`  Subject + Body:      ${estimatedFullScan.toFixed(0)}s (${(estimatedFullScan / 60).toFixed(1)} Minuten)`);
  console.log(`  Faktor:              ${(estimatedFullScan / phase1Time).toFixed(0)}x langsamer`);
  console.log('');

  // Detail-Tabelle
  console.log('#  | Dauer   | Source | Confidence | Titel');
  console.log('---|---------|--------|------------|------');
  results.forEach((r, i) => {
    console.log(`${String(i+1).padStart(2)} | ${String(r.durationSeconds + 's').padEnd(7)} | ${r.source.padEnd(6)} | ${(r.confidence || '?').padEnd(10)} | ${r.title.substring(0, 45)}`);
  });

  // Save report
  const fs = await import('fs');
  const report = {
    timestamp: new Date().toISOString(),
    phase1_reference: { durationSeconds: phase1Time },
    phase2_results: results,
    summary: {
      totalSeconds: +(totalTime / 1000).toFixed(1),
      avgSeconds: +(avgTime / 1000).toFixed(1),
      minSeconds: results.length > 0 ? +(Math.min(...results.map(r => r.durationMs)) / 1000).toFixed(1) : 0,
      maxSeconds: results.length > 0 ? +(Math.max(...results.map(r => r.durationMs)) / 1000).toFixed(1) : 0
    },
    projection: {
      inboxSize: messagesInInbox,
      subjectOnlySeconds: phase1Time,
      subjectPlusBodySeconds: +estimatedFullScan.toFixed(0),
      factor: +(estimatedFullScan / phase1Time).toFixed(0)
    }
  };

  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 16);
  const path = `results/timing_phase2_${dateStr}.json`;
  fs.writeFileSync(path, JSON.stringify(report, null, 2));
  console.log('');
  console.log(`[GESPEICHERT] ${path}`);
}

run().catch(err => {
  console.error('FEHLER:', err.message);
  process.exit(1);
});
