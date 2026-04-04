// Agent Zero — Summary Migration Script
// Transforms all open task summaries from the old stacked-update format
// to the new structured format (Context → Aktuell → Erledigt).
//
// Usage:
//   node migrate-summaries.js --dry-run    (preview changes without saving)
//   node migrate-summaries.js              (apply changes)
//
// IMPORTANT: Stop the Agent Zero server before running this script.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CopilotClient } from '@github/copilot-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TASKS_FILE = path.join(__dirname, 'tasks.json');

const isDryRun = process.argv.includes('--dry-run');

const MIGRATION_PROMPT = `Du erhältst die aktuelle Zusammenfassung eines Action Items. Schreibe sie in das neue strukturierte Format um.

FORMAT (PFLICHT — exakt diese Struktur):

[1-2 Sätze Kontext: Worum geht es bei diesem Task?]

---

🔴 **Nächste Schritte:**
- Was steht JETZT an? Wer muss was tun? Worauf warten wir?
- 📧 *Quellenreferenz wenn bekannt*

---

✅ **Bisheriger Verlauf:**
- TT.MM. — Kompakter Einzeiler pro Meilenstein (neueste zuerst)
- TT.MM. — Kompakter Einzeiler

REGELN:
- VERBOTEN: "📌 Update (Datum):" Blöcke — dieses Format ist veraltet
- VERBOTEN: Duplikation von Information zwischen Sektionen
- VERBOTEN: Fließtext-Absätze pro Update — nur kompakte Einzeiler im Verlauf
- Trennlinien ("---") zwischen den 3 Sektionen verwenden
- Sprache beibehalten (Deutsch ODER Englisch — wie das Original)
- Nichts erfinden — nur vorhandene Information umstrukturieren
- Wenn kein "Bisheriger Verlauf" ableitbar ist, Sektion weglassen
- Wenn keine "Nächste Schritte" bekannt sind, Sektion mit "Keine offenen Aktionen" füllen

Schreibe NUR die neue Zusammenfassung. Kein JSON, kein Markdown-Codeblock, keine Erklärung.`;

async function migrate() {
  console.log('\n========================================');
  console.log('  Agent Zero — Summary Migration');
  console.log(`  Mode: ${isDryRun ? 'DRY RUN (no changes)' : 'LIVE (will modify tasks.json)'}`);
  console.log('========================================\n');

  // Read tasks
  const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
  const openTasks = data.tasks.filter(t => t.status !== 'done' && t.summary);

  console.log(`Found ${openTasks.length} open tasks with summaries to migrate.\n`);

  if (!isDryRun) {
    // Create backup
    const backupPath = TASKS_FILE.replace('.json', `.backup-${Date.now()}.json`);
    fs.copyFileSync(TASKS_FILE, backupPath);
    console.log(`Backup created: ${path.basename(backupPath)}\n`);
  }

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const task of openTasks) {
    console.log(`--- [${migrated + skipped + failed + 1}/${openTasks.length}] "${task.title.substring(0, 60)}..." ---`);
    console.log(`    Current: ${task.summary.length} chars`);

    // Skip if already in new format
    if (task.summary.includes('🔴 **N') && task.summary.includes('---')) {
      console.log(`    ✅ Already in new format — skipping\n`);
      skipped++;
      continue;
    }

    try {
      const client = new CopilotClient();
      const session = await client.createSession({});

      const prompt = MIGRATION_PROMPT + `\n\nAktuelle Zusammenfassung:\n${task.summary}\n\nTask-Titel: "${task.title}"`;

      const response = await session.sendAndWait({ prompt }, 120000);
      try { await session.destroy(); } catch {}
      try { await client.forceStop(); } catch {}
      try { await client.dispose(); } catch {}

      if (!response || !response.data || !response.data.content) {
        console.log(`    ❌ No response from AI — skipping\n`);
        failed++;
        continue;
      }

      let newSummary = response.data.content.trim();
      // Strip markdown code fences if the AI wrapped it
      newSummary = newSummary.replace(/^```(?:markdown)?\n?/, '').replace(/\n?```$/, '').trim();

      // Validate: must have separator lines and be shorter or similar length
      if (!newSummary.includes('---')) {
        console.log(`    ❌ Invalid format (no separators) — skipping\n`);
        failed++;
        continue;
      }

      console.log(`    New:     ${newSummary.length} chars (${Math.round((1 - newSummary.length / task.summary.length) * 100)}% shorter)`);

      if (isDryRun) {
        console.log(`    [DRY RUN] Would migrate. Preview:\n`);
        console.log(newSummary.split('\n').map(l => `    │ ${l}`).join('\n'));
        console.log();
      } else {
        // Apply migration
        const idx = data.tasks.findIndex(t => t.id === task.id);
        data.tasks[idx].summary = newSummary;
        if (!data.tasks[idx].history) data.tasks[idx].history = [];
        data.tasks[idx].history.push({
          timestamp: new Date().toISOString(),
          type: 'summary-update',
          text: `📋 Summary migrated to structured format (${task.summary.length} → ${newSummary.length} chars)`
        });
        console.log(`    ✅ Migrated\n`);
      }
      migrated++;

      // Brief pause between API calls
      await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      console.log(`    ❌ Error: ${err.message} — skipping\n`);
      failed++;
    }
  }

  // Save if not dry run
  if (!isDryRun && migrated > 0) {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
    console.log(`\nSaved ${migrated} migrated tasks to tasks.json.`);
  }

  console.log('\n========================================');
  console.log(`  Results: ${migrated} migrated, ${skipped} skipped, ${failed} failed`);
  console.log('========================================\n');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
