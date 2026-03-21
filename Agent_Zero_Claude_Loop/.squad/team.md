# Squad Team — Agent Zero Prompt-Optimierung

## Team-Übersicht

Dieses Squad-Team optimiert die Agent Zero Skill-Prompts systematisch.
Jedes Mitglied hat eine klar definierte Rolle im Optimierungsprozess.

## Roster

| # | Role | Agent | Expertise | Zuständigkeit |
|---|------|-------|-----------|---------------|
| 1 | 🏗️ Lead | **Orchestrator** | Strategy & Decision-Making | Manages optimization strategy, compares results, makes adoption decisions |
| 2 | ✏️ Engineer | **PromptEngineer-A** | Structural Optimization | Chain-of-Thought, Few-Shot, Role Instructions, Prompt-Architektur |
| 3 | ✏️ Engineer | **PromptEngineer-B** | Content Optimization | Anti-Patterns, Edge Cases, Negative Examples, Fehlerbehandlung |
| 4 | ✏️ Engineer | **PromptEngineer-C** | Compaction | Kürzer, präziser, priorisiert — gleiche Qualität mit weniger Tokens |
| 5 | 🧪 Tester | **Tester** | Test Execution | Runs tests against live Agent Zero system, measures results |
| 6 | 📊 Analyst | **Evaluator** | Scoring & Reporting | Scores results against success criteria, creates comparison reports |

## Workflow

```
Orchestrator → definiert Strategie & Phasen-Reihenfolge
    ├── PromptEngineer-A → erstellt Variante (Struktur)
    ├── PromptEngineer-B → erstellt Variante (Inhalt)
    └── PromptEngineer-C → erstellt Variante (Kompakt)
         ↓
    Tester → testet alle Varianten gegen Golden Set
         ↓
    Evaluator → bewertet Ergebnisse, erstellt Vergleichsreport
         ↓
    Orchestrator → entscheidet: Adopt / Iterate / Move On
```

## Kommunikation

- **Ergebnisse** werden in `phase*/results/` dokumentiert
- **Varianten** werden in `phase*/variants/` abgelegt
- **Entscheidungen** werden in `.squad/decisions.md` festgehalten
- **Shared Context** liegt in `shared/` für alle Agents zugänglich
