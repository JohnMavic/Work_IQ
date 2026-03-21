/**
 * Timing Test: Subject-Only (Phase 1) vs. Full Content (Phase 1 + Phase 2)
 *
 * Misst den zeitlichen Unterschied zwischen:
 * - Phase 1: Nur Subject Line / Titel analysieren
 * - Phase 2: Voller Email/Teams Content lesen und zusammenfassen
 *
 * Voraussetzung: Agent Zero Server läuft auf localhost:3000
 *
 * Usage: node tests/timing_test.js
 */

const BASE_URL = 'http://localhost:3000';
const SCAN_DAYS = 7;

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  return response.json();
}

async function measureTime(label, fn) {
  const start = Date.now();
  const result = await fn();
  const duration = Date.now() - start;
  console.log(`  [TIMING] ${label}: ${(duration / 1000).toFixed(1)}s`);
  return { result, duration };
}

async function run() {
  console.log('='.repeat(70));
  console.log('TIMING TEST: Subject-Only vs. Full Content Analysis');
  console.log('='.repeat(70));
  console.log(`Datum: ${new Date().toISOString()}`);
  console.log(`Server: ${BASE_URL}`);
  console.log(`Scan-Zeitraum: ${SCAN_DAYS} Tage`);
  console.log('');

  // --- Schritt 1: Server-Check ---
  console.log('[1/4] Server-Check...');
  try {
    const tasks = await fetchJSON(`${BASE_URL}/api/tasks`);
    const taskList = tasks.tasks || tasks;
    console.log(`  Server online. ${Array.isArray(taskList) ? taskList.length : '?'} Tasks vorhanden.`);
  } catch (e) {
    console.error('  FEHLER: Server nicht erreichbar. Starte erst: node server.js');
    process.exit(1);
  }

  // --- Schritt 2: Phase 1 — Subject-Only Scan ---
  console.log('');
  console.log('[2/4] Phase 1: Subject-Only Scan (wie heute)...');

  const phase1 = await measureTime('Phase 1 gesamt', async () => {
    return fetchJSON(`${BASE_URL}/api/scan`, {
      method: 'POST',
      body: JSON.stringify({ days: SCAN_DAYS })
    });
  });

  const scanResult = phase1.result;
  const newTaskIds = scanResult.newTaskIds || [];

  console.log(`  Ergebnis: ${scanResult.added || 0} neue, ${scanResult.skipped || 0} übersprungen, ${scanResult.updated || 0} aktualisiert`);
  console.log(`  Tasks zum Enrichen: ${newTaskIds.length}`);

  // --- Schritt 3: Phase 2 — Full Content für JEDEN neuen Task ---
  console.log('');
  console.log('[3/4] Phase 2: Full Content Extraction (pro Task)...');

  // Auch bereits pending Tasks holen (nicht nur neue aus diesem Scan)
  const allTasks = await fetchJSON(`${BASE_URL}/api/tasks`);
  const taskList = allTasks.tasks || allTasks;
  const pendingTasks = Array.isArray(taskList)
    ? taskList.filter(t => t.enrichmentStatus === 'pending' && t.status !== 'done')
    : [];

  console.log(`  Tasks mit enrichmentStatus=pending: ${pendingTasks.length}`);

  const enrichTimings = [];
  const maxEnrich = Math.min(pendingTasks.length, 10); // Max 10 Tasks für den Test

  for (let i = 0; i < maxEnrich; i++) {
    const task = pendingTasks[i];
    const shortTitle = task.title.substring(0, 50) + (task.title.length > 50 ? '...' : '');
    console.log(`  [${i + 1}/${maxEnrich}] Enriching: "${shortTitle}"`);

    const enrichResult = await measureTime(`  Task ${i + 1}`, async () => {
      return fetchJSON(`${BASE_URL}/api/tasks/${task.id}/enrich`, {
        method: 'POST'
      });
    });

    enrichTimings.push({
      taskId: task.id,
      title: task.title,
      duration: enrichResult.duration,
      confidence: enrichResult.result?.task?.confidence || enrichResult.result?.confidence || 'unknown',
      source: task.source
    });
  }

  // --- Schritt 4: Ergebnis-Bericht ---
  console.log('');
  console.log('='.repeat(70));
  console.log('ERGEBNIS');
  console.log('='.repeat(70));

  const phase1Time = phase1.duration;
  const totalEnrichTime = enrichTimings.reduce((sum, t) => sum + t.duration, 0);
  const avgEnrichTime = enrichTimings.length > 0 ? totalEnrichTime / enrichTimings.length : 0;

  console.log('');
  console.log('--- Phase 1: Subject-Only Scan ---');
  console.log(`  Dauer: ${(phase1Time / 1000).toFixed(1)}s`);
  console.log(`  Nachrichten evaluiert: ${scanResult.total || 'unbekannt'}`);
  console.log(`  Tasks erstellt: ${scanResult.added || 0}`);

  console.log('');
  console.log('--- Phase 2: Full Content Extraction ---');
  console.log(`  Tasks enriched: ${enrichTimings.length}`);
  console.log(`  Gesamtzeit: ${(totalEnrichTime / 1000).toFixed(1)}s`);
  console.log(`  Durchschnitt pro Task: ${(avgEnrichTime / 1000).toFixed(1)}s`);
  console.log(`  Schnellster: ${enrichTimings.length > 0 ? (Math.min(...enrichTimings.map(t => t.duration)) / 1000).toFixed(1) : 0}s`);
  console.log(`  Langsamster: ${enrichTimings.length > 0 ? (Math.max(...enrichTimings.map(t => t.duration)) / 1000).toFixed(1) : 0}s`);

  console.log('');
  console.log('--- Vergleich ---');
  console.log(`  Subject-Only (Phase 1):              ${(phase1Time / 1000).toFixed(1)}s`);
  console.log(`  Subject + Content (Phase 1 + 2):      ${((phase1Time + totalEnrichTime) / 1000).toFixed(1)}s`);
  console.log(`  Faktor:                               ${((phase1Time + totalEnrichTime) / phase1Time).toFixed(1)}x langsamer`);

  // Hochrechnung: Was wenn Phase 1 SELBST den Body lesen würde?
  const estimatedMessages = scanResult.total || 50;
  const estimatedCombinedTime = avgEnrichTime * estimatedMessages;
  console.log('');
  console.log('--- Hochrechnung: "Was wenn Phase 1 auch Bodies lesen würde?" ---');
  console.log(`  Geschätzte Nachrichten im Zeitraum: ${estimatedMessages}`);
  console.log(`  Durchschnittliche Lesezeit pro Body: ${(avgEnrichTime / 1000).toFixed(1)}s`);
  console.log(`  Geschätzte Gesamtzeit (alle Bodies): ${(estimatedCombinedTime / 1000).toFixed(0)}s (${(estimatedCombinedTime / 60000).toFixed(1)} Minuten)`);
  console.log(`  Aktueller Phase 1 Scan:              ${(phase1Time / 1000).toFixed(1)}s`);
  console.log(`  Faktor:                              ${(estimatedCombinedTime / phase1Time).toFixed(0)}x langsamer`);

  // --- Detail-Tabelle ---
  console.log('');
  console.log('--- Detail: Enrichment pro Task ---');
  console.log('  #  | Dauer    | Source | Confidence | Titel');
  console.log('  ---|----------|--------|------------|------');
  enrichTimings.forEach((t, i) => {
    const dur = `${(t.duration / 1000).toFixed(1)}s`.padEnd(8);
    const src = (t.source || '?').padEnd(6);
    const conf = (t.confidence || '?').padEnd(10);
    const title = t.title.substring(0, 45) + (t.title.length > 45 ? '...' : '');
    console.log(`  ${String(i + 1).padStart(2)} | ${dur} | ${src} | ${conf} | ${title}`);
  });

  // --- JSON Report ---
  const report = {
    timestamp: new Date().toISOString(),
    scanDays: SCAN_DAYS,
    phase1: {
      durationMs: phase1Time,
      durationSeconds: +(phase1Time / 1000).toFixed(1),
      tasksCreated: scanResult.added || 0,
      tasksSkipped: scanResult.skipped || 0,
      tasksUpdated: scanResult.updated || 0,
      totalMessages: scanResult.total || null
    },
    phase2: {
      tasksEnriched: enrichTimings.length,
      totalDurationMs: totalEnrichTime,
      totalDurationSeconds: +(totalEnrichTime / 1000).toFixed(1),
      avgDurationMs: Math.round(avgEnrichTime),
      avgDurationSeconds: +(avgEnrichTime / 1000).toFixed(1),
      minDurationMs: enrichTimings.length > 0 ? Math.min(...enrichTimings.map(t => t.duration)) : 0,
      maxDurationMs: enrichTimings.length > 0 ? Math.max(...enrichTimings.map(t => t.duration)) : 0,
      details: enrichTimings
    },
    comparison: {
      subjectOnlySeconds: +(phase1Time / 1000).toFixed(1),
      subjectPlusContentSeconds: +((phase1Time + totalEnrichTime) / 1000).toFixed(1),
      factor: +((phase1Time + totalEnrichTime) / phase1Time).toFixed(1),
      estimatedAllBodiesSeconds: +(estimatedCombinedTime / 1000).toFixed(0),
      estimatedAllBodiesMinutes: +(estimatedCombinedTime / 60000).toFixed(1),
      estimatedFactor: +(estimatedCombinedTime / phase1Time).toFixed(0)
    }
  };

  const fs = await import('fs');
  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, '-').substring(0, 16);
  const reportPath = `results/timing_test_${dateStr}.json`;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log('');
  console.log(`[GESPEICHERT] ${reportPath}`);
  console.log('');
}

run().catch(err => {
  console.error('FEHLER:', err.message);
  process.exit(1);
});
