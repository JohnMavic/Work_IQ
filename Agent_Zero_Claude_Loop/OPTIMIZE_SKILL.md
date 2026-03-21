# Skill Optimization Loop — Hauptprozess

**Version:** 2.0 — Squad Parallel Optimization
**Projekt:** Agent Zero Skill Optimizer

---

## Dein Auftrag

Du bist ein **Skill-Optimierungs-Agent**. Du verbesserst iterativ die AI-Prompt-Skill-Files von Agent Zero, testest jede Änderung gegen die Live-Applikation, und übernimmst nur nachweislich bessere Versionen.

Im Squad-Modus arbeitest du mit parallelen Prompt-Engineers zusammen: Drei Varianten werden gleichzeitig erstellt, getestet und verglichen. Die beste Variante gewinnt.

---

## Ablauf-Übersicht

```
┌─────────────────────────────────────────────────────────────┐
│  1. SETUP: Branch erstellen, Skill Files kopieren           │
│  2. AUSWAHL: User wählt Skill(s) zur Optimierung           │
│  3. BASELINE: Aktuelles Skill File bewerten                 │
│  4. OPTIMIEREN: 3 parallele Varianten erstellen (A/B/C)    │
│  5. TESTEN: Alle Varianten gegen Live-System testen         │
│  6. VERGLEICHEN: Baseline vs. A vs. B vs. C auswerten      │
│  7. ENTSCHEIDEN: Beste Variante übernehmen oder verwerfen   │
│  8. LOOP: Zurück zu Schritt 4 oder nächstes Skill File     │
│  9. REGRESSION: Alle anderen Phasen gegentesten             │
│ 10. ABSCHLUSS: Ergebnisse dokumentieren                     │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 0: Vorbereitung

### 0.1 Branch-Sicherheit

```bash
cd E:/Work_IQ/Agent_Zero

# Sicherstellen, dass wir NICHT auf main arbeiten
git branch  # Aktuellen Branch prüfen

# Neuen Branch erstellen (falls noch nicht vorhanden)
git checkout -b squad-optimization 2>/dev/null || git checkout squad-optimization

# Verifizieren
git branch --show-current  # Muss "squad-optimization" zeigen
```

**STOPP-BEDINGUNG:** Falls `git branch --show-current` "main" zeigt → ABBRUCH. Niemals auf main arbeiten.

### 0.2 Aktuelle Skill Files sichern

```bash
# Skill Files in den Optimierungs-Ordner kopieren (Baseline)
cp E:/Work_IQ/Agent_Zero/docs/SCAN_DISCOVERY_SKILL.md E:/Work_IQ/Agent_Zero_Claude_Loop/skills/current/
cp E:/Work_IQ/Agent_Zero/docs/ENRICH_SKILL.md E:/Work_IQ/Agent_Zero_Claude_Loop/skills/current/
cp E:/Work_IQ/Agent_Zero/docs/UPDATE_CHECK_SKILL.md E:/Work_IQ/Agent_Zero_Claude_Loop/skills/current/
cp E:/Work_IQ/Agent_Zero/docs/CONSOLIDATE_SKILL.md E:/Work_IQ/Agent_Zero_Claude_Loop/skills/current/
```

### 0.3 Tasks.json doppelt sichern

```bash
cd E:/Work_IQ/Agent_Zero

# Server stoppen falls laufend
taskkill //F //IM node.exe 2>/dev/null; sleep 2

# Doppelte Sicherung
cp tasks.json tasks.json.BACKUP_OPTIMIZATION
cp tasks.json tasks.json.ORIGINAL_OPTIMIZATION

# Verifizieren: beide Backups müssen existieren
ls -la tasks.json tasks.json.BACKUP_OPTIMIZATION tasks.json.ORIGINAL_OPTIMIZATION
```

---

## Phase 1: Skill-Auswahl

Frage den User:

> **Welche Skill Files möchtest du optimieren?**
>
> 1. **Phase 1 — SCAN_DISCOVERY_SKILL.md** (Subject-Only Scan)
> 2. **Phase 2 — ENRICH_SKILL.md** (Content Extraction & Summary)
> 3. **Phase 3 — UPDATE_CHECK_SKILL.md** (Detect New Activity)
> 4. **Phase 4 — CONSOLIDATE_SKILL.md** (Semantic Task Grouping)
> 5. **ALLE — Alle 4 Phasen nacheinander**
>
> Wähle eine oder mehrere Nummern (z.B. "1,3" oder "5" für alle).

Speichere die Auswahl und arbeite die gewählten Skills der Reihe nach ab.

---

## Phase 2: Baseline-Messung (pro Skill)

### 2.1 Success-Kriterien laden

Lies die Kriterien aus `config/success_criteria.json` für das aktuelle Skill File.

### 2.2 Baseline-Test durchführen

**WICHTIG:** Vor jedem Test frische tasks.json erstellen:

```bash
cd E:/Work_IQ/Agent_Zero
cp tasks.json.ORIGINAL_OPTIMIZATION tasks.json
```

**Für Phase 1 (Discovery):**
```bash
# Server starten
node server.js &
sleep 5

# Scan auslösen
curl -s -X POST http://localhost:3000/api/scan \
  -H "Content-Type: application/json" \
  -d '{"days": 7}'

# Server stoppen
taskkill //F //IM node.exe 2>/dev/null
```

**Für Phase 2 (Enrichment):**
```bash
node server.js &
sleep 5

# Einen Task mit enrichmentStatus='pending' enrichen
TASK_ID=$(node -e "const t=JSON.parse(require('fs').readFileSync('tasks.json','utf8')); const p=t.tasks.find(x=>x.enrichmentStatus==='pending'&&x.status!=='done'); if(p) console.log(p.id); else console.log('NONE')")

if [ "$TASK_ID" != "NONE" ]; then
  curl -s -X POST "http://localhost:3000/api/tasks/$TASK_ID/enrich" \
    -H "Content-Type: application/json"
fi

taskkill //F //IM node.exe 2>/dev/null
```

**Für Phase 3 (Update Check):**
```bash
node server.js &
sleep 5

TASK_ID=$(node -e "const t=JSON.parse(require('fs').readFileSync('tasks.json','utf8')); const p=t.tasks.find(x=>(x.enrichmentStatus==='enriched'||x.enrichmentStatus==='needs-review')&&x.status!=='done'); if(p) console.log(p.id); else console.log('NONE')")

if [ "$TASK_ID" != "NONE" ]; then
  curl -s -X POST "http://localhost:3000/api/tasks/$TASK_ID/check-update" \
    -H "Content-Type: application/json"
fi

taskkill //F //IM node.exe 2>/dev/null
```

**Für Phase 4 (Consolidation):**
```bash
node server.js &
sleep 5

curl -s -X POST http://localhost:3000/api/consolidate \
  -H "Content-Type: application/json"

taskkill //F //IM node.exe 2>/dev/null
```

### 2.3 Baseline dokumentieren

Erstelle `results/baseline_[SKILL_NAME]_[TIMESTAMP].md` mit:

```markdown
# Baseline-Messung: [SKILL NAME]

**Datum:** [ISO TIMESTAMP]
**Skill File:** [VERSION/HASH]
**Tasks getestet:** [ANZAHL]

## Ergebnisse

| Kriterium | Gewicht | Score (0-100) | Beobachtungen |
|-----------|---------|---------------|---------------|
| [Name]    | [%]     | [Score]       | [Details]     |

## Gewichteter Gesamtscore: [SCORE]/100

## API Response (Auszug)
[Relevante Teile der JSON Response]

## Beobachtete Probleme
- [Problem 1]
- [Problem 2]
```

---

## Phase 3: Intelligente Optimierung (Parallel — 3 Varianten)

Im Squad-Modus werden drei Varianten **gleichzeitig** erstellt. Jede Variante verfolgt eine andere Optimierungsstrategie.

### 3.1 Variante A: Strukturelle Optimierung (Prompt-Engineer A)

Fokus auf die **Struktur** des Prompts:
- Klare Rollenanweisung am Anfang (System → Task → Constraints → Output)
- Explizite Negativbeispiele bei häufigen Fehlern
- Chain-of-Thought Anweisungen für komplexe Entscheidungen
- Few-Shot Beispiele für schwierige Edge Cases
- Strukturierte Output-Spezifikation mit JSON Schema
- Anordnung der Regeln nach Priorität (wichtigste zuerst)

Speichern unter: `phase[N]/variants/[SKILL_NAME]_v[I]_A.md`

### 3.2 Variante B: Inhaltliche Optimierung (Prompt-Engineer B)

Fokus auf den **Inhalt** basierend auf Baseline-Ergebnissen:
- Schwachstellen aus der Baseline gezielt adressieren
- Anti-Patterns aus `success_criteria.json` als explizite DON'T-Regeln formulieren
- Fehlende Anweisungen für beobachtete Fehler ergänzen
- Redundante oder widersprüchliche Anweisungen bereinigen
- Edge Cases aus dem Golden Set als Beispiele einbauen

Speichern unter: `phase[N]/variants/[SKILL_NAME]_v[I]_B.md`

### 3.3 Variante C: Kompaktierung (Prompt-Engineer C)

Fokus auf **Effizienz und Kürze** ohne Qualitätsverlust:
- Unnötige Wiederholungen entfernen
- Kompaktere Formulierungen ohne Informationsverlust
- Kritische Regeln priorisieren, unwichtige streichen
- Token-Budget optimieren (Ziel: <3000 Wörter)
- Gleiches Ergebnis mit weniger Prompt-Länge

Speichern unter: `phase[N]/variants/[SKILL_NAME]_v[I]_C.md`

### 3.4 Änderungs-Dokumentation (pro Variante)

Erstelle `results/optimization_[SKILL_NAME]_v[N]_[TIMESTAMP].md`:

```markdown
# Optimierung: [SKILL NAME] v[N] — Variante [A/B/C]

**Basis:** v[N-1] (Score: [SCORE])
**Strategie:** [Strukturell / Inhaltlich / Kompaktierung]
**Ziel-Verbesserungen:**
- [Verbesserung 1 mit Begründung]
- [Verbesserung 2 mit Begründung]

## Änderungen (Diff-Summary)
- [Hinzugefügt: ...]
- [Entfernt: ...]
- [Geändert: ...]

## Erwartete Auswirkung
- [Kriterium X]: Score sollte von [A] auf [B] steigen weil [Begründung]
```

Zusätzlich werden alle drei Varianten auch ins Phasen-Verzeichnis kopiert:
```
phase[N]/variants/[SKILL_NAME]_v[I]_A.md
phase[N]/variants/[SKILL_NAME]_v[I]_B.md
phase[N]/variants/[SKILL_NAME]_v[I]_C.md
```

---

## Phase 4: Test der Optimierung (alle Varianten)

### 4.1 Skill Files einsetzen & testen (pro Variante)

Jede der drei Varianten wird einzeln gegen das Live-System getestet.
Der **Tester** führt für jede Variante (A, B, C) denselben Testlauf durch:

```bash
cd E:/Work_IQ/Agent_Zero

# Sicherstellen: NICHT auf main
git branch --show-current  # Muss squad-optimization sein
```

**Für jede Variante (A, B, C):**

```bash
# 1. Frische tasks.json
cp tasks.json.ORIGINAL_OPTIMIZATION tasks.json

# 2. Variante einsetzen
cp "E:/Work_IQ/Agent_Zero_Claude_Loop/phase[N]/variants/[SKILL_NAME]_v[I]_[A|B|C].md" \
   "E:/Work_IQ/Agent_Zero/docs/[SKILL_NAME].md"

# 3. Test durchführen (identisch zu Phase 2.2 Baseline)
# 4. Ergebnis speichern
```

### 4.2 Shared Tools nutzen

Verwende die gemeinsamen Tools aus `shared/` für konsistente Bewertung:

```bash
# Output validieren gegen Golden Set
node shared/validate-output.js --phase [N] --variant [A|B|C]

# Automatisiertes Scoring
node shared/scoring.js --phase [N] --variant [A|B|C]

# tasks.json Snapshot für Vergleich
powershell -File shared/snapshot.ps1 -Phase [N] -Variant [A|B|C]
```

### 4.3 Ergebnisse dokumentieren

Pro Variante identisches Format wie Baseline, gespeichert als:
```
phase[N]/results/test_[SKILL_NAME]_v[I]_[A|B|C]_[TIMESTAMP].md
```

Scores werden automatisch in `phase[N]/scores.json` geschrieben.

---

## Phase 5: Vergleich & Entscheidung (Multi-Variante)

### 5.1 Score-Vergleich (Baseline vs. 3 Varianten)

Der **Evaluator** vergleicht alle Varianten:

```markdown
# Vergleich: [SKILL NAME] v[I] — Baseline vs. A vs. B vs. C

| Kriterium       | Gewicht | Baseline | Var. A  | Var. B  | Var. C  |
|-----------------|---------|----------|---------|---------|---------|
| [Kriterium 1]   | [%]     | [Score]  | [Score] | [Score] | [Score] |
| [Kriterium 2]   | [%]     | [Score]  | [Score] | [Score] | [Score] |
| **Gesamt**       | 100%    | [Score]  | [Score] | [Score] | [Score] |

## Gewinner: Variante [A/B/C] mit Score [SCORE]
## Delta vs. Baseline: [+/- %]
## Entscheidung: [ÜBERNOMMEN / VERWORFEN]
## Begründung: [...]
```

### 5.2 Entscheidungslogik

```
best_variant = MAX(score_A, score_B, score_C)

IF best_variant > gewichteter_gesamtscore_baseline + 2%:
    → ÜBERNEHMEN (Gewinner-Variante)
    → Gewinner wird neue Baseline
    → Ergebnis in phase[N]/OUTCOME.md dokumentieren
    → Weiter mit nächster Iteration (Phase 3)

IF best_variant <= gewichteter_gesamtscore_baseline + 2%:
    → ALLE VERWERFEN
    → consecutive_no_improvement += 1

IF consecutive_no_improvement >= 3:
    → STOPP für dieses Skill File
    → "Skill File ist ausoptimiert"

IF iteration >= max_iterations (10):
    → STOPP für dieses Skill File
    → "Maximum an Iterationen erreicht"
```

### 5.3 Bei Übernahme: Regression Check

**KRITISCH:** Nach Übernahme einer Optimierung MÜSSEN alle anderen Phasen getestet werden.

```bash
cd E:/Work_IQ/Agent_Zero
cp tasks.json.ORIGINAL_OPTIMIZATION tasks.json
node server.js &
sleep 5

# Vollständigen Scan durchführen (Phase 1 → 2 → 3 → 4)
curl -s -X POST http://localhost:3000/api/scan -H "Content-Type: application/json" -d '{"days": 7}'

# Warten auf Completion, dann manuell Phase 2-4 für Stichproben-Tasks testen
# ...

taskkill //F //IM node.exe 2>/dev/null
```

**STOPP-BEDINGUNG:** Falls eine andere Phase dadurch schlechter wird (Score sinkt > 0%):
- Optimierung ZURÜCKROLLEN
- Original-Skill-File wiederherstellen
- In Dokumentation festhalten: "Verworfen wegen Regression in Phase [X]"

---

## Phase 6: Abschluss

### 6.1 Finale Dokumentation

Erstelle `results/FINAL_REPORT_[TIMESTAMP].md`:

```markdown
# Skill Optimization — Final Report

**Durchgeführt:** [DATUM]
**Dauer:** [ZEIT]
**Branch:** squad-optimization

## Ergebnisübersicht

| Skill File | Baseline Score | Finaler Score | Verbesserung | Iterationen |
|------------|---------------|---------------|--------------|-------------|
| Phase 1    | [Score]       | [Score]       | [+%]         | [N]         |
| Phase 2    | [Score]       | [Score]       | [+%]         | [N]         |
| Phase 3    | [Score]       | [Score]       | [+%]         | [N]         |
| Phase 4    | [Score]       | [Score]       | [+%]         | [N]         |

## Regression Check: [BESTANDEN / FEHLGESCHLAGEN]

## Optimierte Skill Files
- [Dateiname] → Bereit für Übernahme in main
```

### 6.2 Aufräumen

```bash
cd E:/Work_IQ/Agent_Zero

# Original tasks.json wiederherstellen
taskkill //F //IM node.exe 2>/dev/null; sleep 2
rm -f tasks.json
mv tasks.json.ORIGINAL_OPTIMIZATION tasks.json
rm -f tasks.json.BACKUP_OPTIMIZATION

# Verifizieren
ls -la tasks.json*  # Nur tasks.json darf übrig sein
```

### 6.3 Commit (nur auf Branch)

```bash
git branch --show-current  # MUSS squad-optimization sein

git add docs/
git commit -m "optimize: [Skill Name] improved from [Score] to [Score]

- [Änderung 1]
- [Änderung 2]
- Regression check: all phases passed"
```

**NIEMALS:** `git checkout main`, `git merge`, `git push --force`

---

## Sicherheitsregeln

1. **main ist tabu** — Alle Änderungen NUR auf Branch `squad-optimization`
2. **tasks.json ist heilig** — Immer doppelt sichern, immer wiederherstellen
3. **Kein Code ändern** — NUR Skill Files (docs/*.md) dürfen verändert werden
4. **Kein npm install** — Keine Dependency-Änderungen
5. **Regression ist Veto** — Eine Verschlechterung anderer Phasen blockiert die Übernahme
6. **Dokumentation ist Pflicht** — Jeder Schritt wird protokolliert
7. **User entscheidet** — Bei Unklarheiten den User fragen
8. **Phasen-Isolation** — Jede Phase hat ihren eigenen Workspace (phase1-4/), keine Überschneidung
9. **Golden Set ist Referenz** — Varianten werden immer gegen das Golden Set validiert

---

## User-Feedback während des Prozesses

Gib dem User regelmässig Status-Updates:

```
[SETUP] Branch squad-optimization erstellt ✓
[AUSWAHL] User wählt: Phase 2 (ENRICH_SKILL.md)
[BASELINE] Teste aktuelles ENRICH_SKILL.md...
[BASELINE] Score: 72/100 — Schwächen: temporal reasoning (55/100), perspective attribution (60/100)
[OPTIMIERUNG v1] 3 Varianten parallel erstellen...
  ├─ [Engineer A] Variante A (strukturell): fertig ✓
  ├─ [Engineer B] Variante B (inhaltlich): fertig ✓
  └─ [Engineer C] Variante C (kompakt): fertig ✓
[TEST v1] Teste alle 3 Varianten gegen Golden Set...
  ├─ [Tester] Variante A: 78/100
  ├─ [Tester] Variante B: 81/100
  └─ [Tester] Variante C: 75/100
[VERGLEICH] Baseline: 72 → A: 78 | B: 81 ★ | C: 75 — GEWINNER: B (+12.5%) ✓
[REGRESSION] Teste alle anderen Phasen... Phase 1: OK, Phase 3: OK, Phase 4: OK ✓
[OPTIMIERUNG v2] 3 Varianten parallel auf Basis von B...
  ├─ [Engineer A] Variante A (strukturell): fertig ✓
  ├─ [Engineer B] Variante B (inhaltlich): fertig ✓
  └─ [Engineer C] Variante C (kompakt): fertig ✓
[TEST v2] Teste alle 3 Varianten...
  ├─ [Tester] Variante A: 82/100
  ├─ [Tester] Variante B: 80/100
  └─ [Tester] Variante C: 83/100
[VERGLEICH] v1-Best (81) → A: 82 | B: 80 | C: 83 ★ — GEWINNER: C (+2.5%) ✓
...
[FERTIG] ENRICH_SKILL.md optimiert: 72 → 83/100 (+15.3%) in 2 Runden (6 Varianten)
```
