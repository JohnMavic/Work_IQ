# Squad Routing Rules ÔÇö Agent Zero Optimierung

## Datei-basiertes Routing

Dateipfade bestimmen, welcher Agent zust├ñndig ist:

| Pattern | Agent | Begr├╝ndung |
|---------|-------|------------|
| `phase*/variants/*` | PromptEngineer-A, -B, -C | Varianten-Erstellung und -├£berarbeitung |
| `phase*/results/*` | Evaluator | Ergebnis-Bewertung und Scoring |
| `phase*/golden-set/*` | Tester | Test-Definitionen und Expected Results |
| `shared/*` | Orchestrator | Gemeinsame Konfiguration und Strategie |
| `.squad/*` | Orchestrator | Team-Konfiguration und Entscheidungen |
| `docs/*.md` | PromptEngineers (via Orchestrator) | Finale Skill-Dateien ÔÇö nur nach Adoption |
| `tests/*` | Tester | Test-Infrastruktur und Skripte |

## Task-basiertes Routing

| Task-Typ | Agent | Beschreibung |
|----------|-------|--------------|
| Strategy & Planning | Orchestrator | Phasen-Reihenfolge, Iterations-Planung |
| Structural Prompt Optimization | PromptEngineer-A | CoT, Few-Shot, Role Instructions |
| Content Prompt Optimization | PromptEngineer-B | Anti-Patterns, Edge Cases, Negative Examples |
| Compaction Optimization | PromptEngineer-C | Token-Reduktion bei gleicher Qualit├ñt |
| Test Execution | Tester | Golden-Set Tests gegen Live-System |
| Score Comparison | Evaluator | Scoring, Vergleichsreports, Trend-Analyse |
| Adoption Decision | Orchestrator | Variante ├╝bernehmen / iterieren / verwerfen |
| Rollback | Orchestrator + Tester | Regression erkannt ÔåÆ sofortiges Rollback |

## Eskalation

```
PromptEngineer ÔåÆ meldet an Orchestrator bei Unklarheiten
Tester          ÔåÆ meldet an Orchestrator bei Test-Fehlern oder Datenkorruption
Evaluator       ÔåÆ meldet an Orchestrator bei Regression oder unklaren Ergebnissen
Orchestrator    ÔåÆ entscheidet final, dokumentiert in decisions.md
```

## Parallelisierung

- PromptEngineer-A, -B, -C arbeiten **parallel** an Varianten
- Tester arbeitet **sequentiell** (ein Test-Run nach dem anderen)
- Evaluator arbeitet **nach** dem Tester (braucht Ergebnisse)
- Orchestrator arbeitet **asynchron** ÔÇö reviewed und entscheidet
