# Squad Decisions Log ÔÇö Agent Zero Optimierung

## Grundsatz-Entscheidungen (Initial Seed)

### ­ƒöÆ Branch Protection
- **Regel:** Alle Arbeiten erfolgen auf dem Branch `squad-optimization`
- **NIEMALS** direkt auf `main` arbeiten
- Merge zu `main` nur nach vollst├ñndiger Validierung durch Orchestrator
- **Status:** Ô£à Aktiv seit Squad-Gr├╝ndung

### ­ƒøí´©Å tasks.json Safety
- **Regel:** Triple-Backup + Hash-Verification vor und nach jedem Test-Run
- Backup-Pfad: `shared/backups/tasks-{timestamp}.json`
- Hash-Algorithmus: SHA-256
- Bei Hash-Mismatch: sofortiger Abbruch + Rollback
- **Status:** Ô£à Aktiv seit Squad-Gr├╝ndung

### ­ƒÜ½ Regression Policy
- **Regel:** 0% Toleranz ÔÇö jede Verschlechterung anderer Phasen ÔåÆ sofortiges Rollback
- Eine Variante darf Phase X verbessern, aber NICHT Phase Y verschlechtern
- Tester pr├╝ft alle Phasen nach jeder ├änderung (Full Regression)
- **Status:** Ô£à Aktiv seit Squad-Gr├╝ndung

### ­ƒôê Improvement Threshold
- **Regel:** Eine Variante muss ÔëÑ 2 Punkte besser scoren, um adoptiert zu werden
- Marginale Verbesserungen (< 2 Punkte) rechtfertigen das ├änderungsrisiko nicht
- Scoring-Skala wird vom Evaluator definiert (siehe `shared/scoring-criteria.md`)
- **Status:** Ô£à Aktiv seit Squad-Gr├╝ndung

### ­ƒöä Max Iterations
- **Regel:** Maximal 10 Runden pro Phase
- **Stop-Kriterium:** Nach 3 aufeinanderfolgenden Runden ohne Verbesserung ÔåÆ Phase abschlie├ƒen
- Orchestrator kann fr├╝hzeitig stoppen, wenn Plateau erkennbar ist
- **Status:** Ô£à Aktiv seit Squad-Gr├╝ndung

### ­ƒôü Code Protection
- **Regel:** Nur `docs/*.md` Skill-Dateien d├╝rfen modifiziert werden
- **KEINE ├änderungen** an: `server.js`, `index.html`, `package.json`, oder anderen Code-Dateien
- Prompt-Optimierung betrifft ausschlie├ƒlich die Skill-Dokumentation
- **Status:** Ô£à Aktiv seit Squad-Gr├╝ndung

### ­ƒîÉ Language Policy
- **Regel:** Dokumentation und Zusammenfassungen in Deutsch (Projektsprache)
- Technische Begriffe (Prompt Engineering, Chain-of-Thought, etc.) bleiben Englisch
- Code-Kommentare und Variable-Namen bleiben Englisch
- **Status:** Ô£à Aktiv seit Squad-Gr├╝ndung

---

## Entscheidungs-Protokoll

> Hier werden alle Squad-Entscheidungen chronologisch dokumentiert.
> Format: `[Datum] [Entscheidung] [Begr├╝ndung] [Entscheider]`

_Noch keine Entscheidungen getroffen ÔÇö Squad wurde gerade gegr├╝ndet._

## Phase 1 Optimization Learnings

### Round 1 (2026-03-21)
**Winner:** Variant A (structural) ÔÇö 79/100 (+9 vs Baseline 70)

- Ô£à Decision Frameworks wirken: "Does the user need to DO something specific?" verbessert Klassifikation
- Ô£à Teams-spezifische Regeln sind essentiell: Casual Chats werden sonst als Tasks erkannt
- Ô£à Dedup-Verbesserung durch "match by title similarity, never guess IDs"
- ÔØî DON'T-Beispiele allein (Variant B) machen den Prompt zu konservativ ÔåÆ nur 1 Task gefunden
- ÔØî Kompaktierung ohne ausreichende Guidance (Variant C) findet falsche Tasks
- ÔÜá´©Å Performance ist API-gebunden, nicht Prompt-l├ñngen-abh├ñngig (k├╝rzerer Prompt Ôëá schneller)

### Round 2 (2026-03-21)
**Winner:** Keine ÔÇö alle Varianten schlechter als v1a

- ÔØî "FN is permanent, FP is temporary" Framing verwirrt das Copilot-Modell komplett ÔåÆ 0 Tasks
- ÔØî "100% certain" Dedup-Schwelle ist zu strikt ÔåÆ Model skippt alles
- ÔÜá´©Å Few-Shot-Beispiele helfen bei Precision (100%) aber nicht bei Recall (nur 2/5)
- ÔÜá´©Å Jede ├änderung an v1a machte den Prompt KONSERVATIVER, nicht offener
- ­ƒöæ **Key Insight:** v1a hat einen Sweet Spot getroffen. Das Copilot-Modell reagiert auf zus├ñtzliche Guidance tendenziell mit mehr Vorsicht, nicht weniger. Minimale ├änderungen destabilisieren die Balance.
