# CLAUDE.md — Agent Zero Skill Optimizer

## Projektbeschreibung

Dieses Projekt optimiert iterativ die AI-Prompt-Skill-Files von Agent Zero (E:\Work_IQ\Agent_Zero).
Es ist ein Meta-Optimierungsprozess: Prompts werden verbessert, getestet und nur bei nachweisbarer Verbesserung übernommen.

## Verzeichnisstruktur

```
Agent_Zero_Claude_Loop/
├── CLAUDE.md                  ← Diese Datei (Projektregeln)
├── START.md                   ← Anleitung für Einsteiger
├── OPTIMIZE_SKILL.md          ← Hauptprozess-Prompt
├── config/
│   ├── success_criteria.json  ← Bewertungskriterien pro Phase
│   └── optimization_config.json ← Konfiguration
├── skills/
│   ├── current/               ← Aktuelle Skill Files (Kopien)
│   ├── optimized/             ← Optimierte Versionen (v1, v2, ...)
│   └── archive/               ← Verworfene Versionen
├── phase1/                    ← SCAN_DISCOVERY — Phasen-Workspace
│   ├── OUTCOME.md             ← Ergebnis-Dokumentation dieser Phase
│   ├── golden-set/            ← Referenz-Inputs & erwartete Outputs
│   ├── variants/              ← Parallel erstellte Varianten (A, B, C)
│   ├── results/               ← Testergebnisse pro Variante
│   ├── scores.json            ← Automatisierte Score-Daten
│   └── dashboard.html         ← Visuelle Score-Übersicht
├── phase2/                    ← ENRICH — gleiche Struktur wie phase1
│   ├── golden-set/
│   ├── variants/
│   └── results/
├── phase3/                    ← UPDATE_CHECK — gleiche Struktur
│   ├── golden-set/
│   ├── variants/
│   └── results/
├── phase4/                    ← CONSOLIDATE — gleiche Struktur
│   ├── golden-set/
│   ├── variants/
│   └── results/
├── shared/                    ← Gemeinsame Tools für alle Phasen
│   ├── scoring.js             ← Automatisierte Bewertung
│   ├── validate-output.js     ← Output-Validierung gegen Golden Set
│   └── snapshot.ps1           ← tasks.json Snapshot-Tool
├── .squad/                    ← Squad-Konfiguration (Team-Rollen)
│   └── agents/
│       ├── orchestrator       ← Koordiniert den Gesamtprozess
│       ├── prompt-engineer-a  ← Variante A: Strukturelle Optimierung
│       ├── prompt-engineer-b  ← Variante B: Inhaltliche Optimierung
│       ├── prompt-engineer-c  ← Variante C: Kompaktierung
│       ├── tester             ← Testet Varianten gegen Live-System
│       └── evaluator          ← Bewertet & vergleicht Ergebnisse
├── results/                   ← Globale Test- und Vergleichsergebnisse
├── tests/
│   ├── EVALUATION_TEMPLATE.md ← Template für Skill-Bewertung
│   └── REGRESSION_TEST.md     ← Regression-Test-Protokoll
└── docs/                      ← Zusätzliche Dokumentation
```

## Phasen-Struktur

Jede der 4 Agent-Zero-Phasen hat einen eigenen Workspace unter `phase1/` bis `phase4/`:

| Ordner   | Skill File                 | Beschreibung                |
|----------|----------------------------|-----------------------------|
| phase1/  | SCAN_DISCOVERY_SKILL.md    | Subject-Only Scan           |
| phase2/  | ENRICH_SKILL.md            | Content Extraction & Summary|
| phase3/  | UPDATE_CHECK_SKILL.md      | Detect New Activity         |
| phase4/  | CONSOLIDATE_SKILL.md       | Semantic Task Grouping      |

Jeder Phasen-Ordner enthält:
- **OUTCOME.md** — Dokumentation der Ergebnisse für diese Phase
- **golden-set/** — Referenz-Inputs und erwartete Outputs (Ground Truth)
- **variants/** — Parallel erstellte Prompt-Varianten (A, B, C)
- **results/** — Testergebnisse pro Variante
- **scores.json** — Automatisierte Score-Daten
- **dashboard.html** — Visuelle Score-Übersicht

## Squad-Integration

Die Optimierung läuft über ein Squad-Team (`.squad/agents/`):

1. **Orchestrator** — Koordiniert den Gesamtprozess, weist Aufgaben zu
2. **Prompt-Engineer A** — Erstellt Variante A (strukturelle Optimierung)
3. **Prompt-Engineer B** — Erstellt Variante B (inhaltliche Optimierung)
4. **Prompt-Engineer C** — Erstellt Variante C (Kompaktierung)
5. **Tester** — Testet alle Varianten gegen das Live-System
6. **Evaluator** — Bewertet Ergebnisse, vergleicht Scores, empfiehlt Gewinner

**Squad-Workflow:**
```
Orchestrator → Engineer A + B + C (parallel) → Tester → Evaluator → Entscheidung
```

Die drei Prompt-Engineers arbeiten **gleichzeitig** an verschiedenen Optimierungsstrategien.
Der Tester validiert alle Varianten gegen das Golden Set.
Der Evaluator vergleicht die Scores und empfiehlt die beste Variante.

## Unverletzliche Regeln

### 1. Quellprojekt schützen
- `E:\Work_IQ\Agent_Zero` hat NUR Leserechte (ausser Skill Files im Branch)
- `server.js`, `index.html`, `package.json` dürfen NICHT verändert werden
- Nur `docs/*.md` Skill Files dürfen auf dem Branch `squad-optimization` geändert werden

### 2. main ist tabu
- NIEMALS auf main committen, mergen oder pushen
- Alle Arbeit passiert auf Branch `squad-optimization`
- Vor JEDEM git-Befehl prüfen: `git branch --show-current`

### 3. Daten schützen
- `tasks.json` wird VOR Tests doppelt gesichert
- Nach Tests wird das Original IMMER wiederhergestellt
- Backups: `tasks.json.ORIGINAL_OPTIMIZATION` + `tasks.json.BACKUP_OPTIMIZATION`

### 4. Keine Regression
- Optimierung einer Phase darf andere Phasen NICHT verschlechtern
- Nach jeder Übernahme: Regression Test aller 4 Phasen
- Bei Regression: sofort zurückrollen

### 5. Dokumentation ist Pflicht
- Jeder Test, jede Optimierung, jeder Vergleich wird dokumentiert
- Ergebnisse in `results/` mit Zeitstempel
- Verworfene Versionen in `skills/archive/`

## Arbeitsablauf

1. Lies `OPTIMIZE_SKILL.md` für den vollständigen Prozess
2. Nutze `config/success_criteria.json` für die Bewertungskriterien
3. Folge dem Prozess Schritt für Schritt
4. Dokumentiere alles in `results/`

## Best Practices für Prompt-Optimierung

### Was funktioniert:
- Klare Rollenanweisung am Anfang
- Explizite Negativbeispiele (DON'T-Regeln)
- Chain-of-Thought für komplexe Entscheidungen
- Few-Shot Beispiele für Edge Cases
- Strikte Output-Spezifikation (JSON Schema)
- Priorisierung: Wichtigste Regeln zuerst

### Was vermeiden:
- Redundante Anweisungen (verwirrt das Modell)
- Widersprüchliche Regeln
- Zu lange Prompts (>3000 Wörter)
- Vage Formulierungen ("versuche...", "wenn möglich...")
- Fehlende Negativbeispiele bei häufigen Fehlern

## Befehle

### Server starten/stoppen (Agent Zero)
```bash
cd E:/Work_IQ/Agent_Zero
node server.js &          # Starten
taskkill //F //IM node.exe # Stoppen (Windows)
```

### Branch-Sicherheit prüfen
```bash
cd E:/Work_IQ/Agent_Zero
git branch --show-current  # MUSS "squad-optimization" sein
```

### tasks.json sichern/wiederherstellen
```bash
# Sichern
cp tasks.json tasks.json.ORIGINAL_OPTIMIZATION
cp tasks.json tasks.json.BACKUP_OPTIMIZATION

# Wiederherstellen
cp tasks.json.ORIGINAL_OPTIMIZATION tasks.json
```
