# Regression Test Protocol

**Zweck:** Sicherstellen, dass die Optimierung eines Skill Files keine andere Phase verschlechtert.

---

## Wann durchführen?

Nach JEDER übernommenen Optimierung eines Skill Files.

## Ablauf

### 1. Vorbereitung

```bash
cd E:/Work_IQ/Agent_Zero

# Sicherstellen: Branch korrekt
git branch --show-current  # MUSS Agent_Zero_Claude_Loop sein

# Frische tasks.json
cp tasks.json.ORIGINAL_OPTIMIZATION tasks.json

# Server starten
node server.js &
sleep 5
```

### 2. Phase 1 testen (Discovery)

```bash
RESPONSE=$(curl -s -X POST http://localhost:3000/api/scan \
  -H "Content-Type: application/json" \
  -d '{"days": 7}')

echo "$RESPONSE" | node -e "
  const r = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log('Phase 1 Results:');
  console.log('  Added:', r.added);
  console.log('  Skipped:', r.skipped);
  console.log('  Updated:', r.updated);
  console.log('  Total:', r.total);
  console.log('  New Task IDs:', (r.newTaskIds||[]).length);
"
```

**Bewertung:**
- Anzahl gefundener Tasks soll ± 10% der Baseline sein
- Keine neuen Timeout-Fehler
- JSON ist valide

### 3. Phase 2 testen (Enrichment — Stichprobe)

```bash
# Einen pending Task enrichen
TASK_ID=$(node -e "
  const t=JSON.parse(require('fs').readFileSync('tasks.json','utf8'));
  const p=t.tasks.find(x=>x.enrichmentStatus==='pending'&&x.status!=='done');
  console.log(p ? p.id : 'NONE');
")

if [ "$TASK_ID" != "NONE" ]; then
  RESPONSE=$(curl -s -X POST "http://localhost:3000/api/tasks/$TASK_ID/enrich" \
    -H "Content-Type: application/json")
  echo "Phase 2: $RESPONSE" | head -c 500
fi
```

**Bewertung:**
- Summary vorhanden und 2-4 Sätze
- Confidence ist high/medium/low (nicht none ohne error)
- Sprache korrekt erkannt

### 4. Phase 3 testen (Update Check — Stichprobe)

```bash
TASK_ID=$(node -e "
  const t=JSON.parse(require('fs').readFileSync('tasks.json','utf8'));
  const p=t.tasks.find(x=>(x.enrichmentStatus==='enriched')&&x.status!=='done');
  console.log(p ? p.id : 'NONE');
")

if [ "$TASK_ID" != "NONE" ]; then
  RESPONSE=$(curl -s -X POST "http://localhost:3000/api/tasks/$TASK_ID/check-update" \
    -H "Content-Type: application/json")
  echo "Phase 3: $RESPONSE" | head -c 500
fi
```

**Bewertung:**
- hasUpdate ist boolean
- Kein Timeout
- Falls hasUpdate=true: updateSummary vorhanden

### 5. Phase 4 testen (Consolidation)

```bash
RESPONSE=$(curl -s -X POST http://localhost:3000/api/consolidate \
  -H "Content-Type: application/json")
echo "Phase 4: $RESPONSE" | head -c 500
```

**Bewertung:**
- Valides JSON-Array
- Keine Task-ID in mehreren Gruppen
- Reasoning vorhanden

### 6. Aufräumen

```bash
taskkill //F //IM node.exe 2>/dev/null; sleep 2
cp tasks.json.ORIGINAL_OPTIMIZATION tasks.json
```

---

## Ergebnis-Dokumentation

```markdown
# Regression Test: nach [SKILL_NAME] v[N]

**Datum:** [ISO TIMESTAMP]
**Optimiertes Skill:** [SKILL_NAME] v[N]

| Phase | Status | Beobachtungen |
|-------|--------|---------------|
| 1 — Discovery | OK/FAIL | [Details] |
| 2 — Enrichment | OK/FAIL | [Details] |
| 3 — Update Check | OK/FAIL | [Details] |
| 4 — Consolidation | OK/FAIL | [Details] |

## Ergebnis: [BESTANDEN / FEHLGESCHLAGEN]

Falls FEHLGESCHLAGEN:
- Betroffene Phase: [...]
- Symptom: [...]
- Aktion: Optimierung zurückrollen
```

Speichern unter: `results/regression_[SKILL_NAME]_v[N]_[TIMESTAMP].md`
