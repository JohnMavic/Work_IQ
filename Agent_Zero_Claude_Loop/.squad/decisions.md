# Squad Decisions Log — Agent Zero Optimierung

## Grundsatz-Entscheidungen (Initial Seed)

### 🔒 Branch Protection
- **Regel:** Alle Arbeiten erfolgen auf dem Branch `squad-optimization`
- **NIEMALS** direkt auf `main` arbeiten
- Merge zu `main` nur nach vollständiger Validierung durch Orchestrator
- **Status:** ✅ Aktiv seit Squad-Gründung

### 🛡️ tasks.json Safety
- **Regel:** Triple-Backup + Hash-Verification vor und nach jedem Test-Run
- Backup-Pfad: `shared/backups/tasks-{timestamp}.json`
- Hash-Algorithmus: SHA-256
- Bei Hash-Mismatch: sofortiger Abbruch + Rollback
- **Status:** ✅ Aktiv seit Squad-Gründung

### 🚫 Regression Policy
- **Regel:** 0% Toleranz — jede Verschlechterung anderer Phasen → sofortiges Rollback
- Eine Variante darf Phase X verbessern, aber NICHT Phase Y verschlechtern
- Tester prüft alle Phasen nach jeder Änderung (Full Regression)
- **Status:** ✅ Aktiv seit Squad-Gründung

### 📈 Improvement Threshold
- **Regel:** Eine Variante muss ≥ 2 Punkte besser scoren, um adoptiert zu werden
- Marginale Verbesserungen (< 2 Punkte) rechtfertigen das Änderungsrisiko nicht
- Scoring-Skala wird vom Evaluator definiert (siehe `shared/scoring-criteria.md`)
- **Status:** ✅ Aktiv seit Squad-Gründung

### 🔄 Max Iterations
- **Regel:** Maximal 10 Runden pro Phase
- **Stop-Kriterium:** Nach 3 aufeinanderfolgenden Runden ohne Verbesserung → Phase abschließen
- Orchestrator kann frühzeitig stoppen, wenn Plateau erkennbar ist
- **Status:** ✅ Aktiv seit Squad-Gründung

### 📁 Code Protection
- **Regel:** Nur `docs/*.md` Skill-Dateien dürfen modifiziert werden
- **KEINE Änderungen** an: `server.js`, `index.html`, `package.json`, oder anderen Code-Dateien
- Prompt-Optimierung betrifft ausschließlich die Skill-Dokumentation
- **Status:** ✅ Aktiv seit Squad-Gründung

### 🌐 Language Policy
- **Regel:** Dokumentation und Zusammenfassungen in Deutsch (Projektsprache)
- Technische Begriffe (Prompt Engineering, Chain-of-Thought, etc.) bleiben Englisch
- Code-Kommentare und Variable-Namen bleiben Englisch
- **Status:** ✅ Aktiv seit Squad-Gründung

---

## Entscheidungs-Protokoll

> Hier werden alle Squad-Entscheidungen chronologisch dokumentiert.
> Format: `[Datum] [Entscheidung] [Begründung] [Entscheider]`

_Noch keine Entscheidungen getroffen — Squad wurde gerade gegründet._

## Phase 1 Optimization Learnings

### Round 1 (2026-03-21)
**Winner:** Variant A (structural) — 79/100 (+9 vs Baseline 70)

- ✅ Decision Frameworks wirken: "Does the user need to DO something specific?" verbessert Klassifikation
- ✅ Teams-spezifische Regeln sind essentiell: Casual Chats werden sonst als Tasks erkannt
- ✅ Dedup-Verbesserung durch "match by title similarity, never guess IDs"
- ❌ DON'T-Beispiele allein (Variant B) machen den Prompt zu konservativ → nur 1 Task gefunden
- ❌ Kompaktierung ohne ausreichende Guidance (Variant C) findet falsche Tasks
- ⚠️ Performance ist API-gebunden, nicht Prompt-längen-abhängig (kürzerer Prompt ≠ schneller)

### Round 2 (2026-03-21)
**Winner:** Keine — alle Varianten schlechter als v1a

- ❌ "FN is permanent, FP is temporary" Framing verwirrt das Copilot-Modell komplett → 0 Tasks
- ❌ "100% certain" Dedup-Schwelle ist zu strikt → Model skippt alles
- ⚠️ Few-Shot-Beispiele helfen bei Precision (100%) aber nicht bei Recall (nur 2/5)
- ⚠️ Jede Änderung an v1a machte den Prompt KONSERVATIVER, nicht offener
- 🔑 **Key Insight:** v1a hat einen Sweet Spot getroffen. Das Copilot-Modell reagiert auf zusätzliche Guidance tendenziell mit mehr Vorsicht, nicht weniger. Minimale Änderungen destabilisieren die Balance.
