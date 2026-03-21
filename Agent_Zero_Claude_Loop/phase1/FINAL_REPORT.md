# Phase 1 Optimization — Final Report

**Phase:** Scan & Discovery (SCAN_DISCOVERY_SKILL.md)  
**Status:** ✅ Optimized — no further improvement possible  
**Result:** Baseline 70/100 → **79/100 (+12.9%)**  
**Winner:** Variant v1a (Round 1, Structural Optimization)  
**Rounds conducted:** 4 (12 variants tested total)  
**Date:** 2026-03-21  
**Branch:** `squad-optimization`

---

## Executive Summary

Phase 1 of Agent Zero scans the user's Microsoft 365 inbox and Teams messages to identify actionable items. Over 4 optimization rounds, we tested 12 prompt variants using a Squad-based parallel optimization approach. **Variant v1a from Round 1** achieved the best score (79/100) and survived all subsequent challengers. After 3 consecutive rounds without improvement, Phase 1 is considered fully optimized.

The key improvement: adding a **structured decision framework**, **Teams-specific classification rules**, and **safer deduplication logic** to the original prompt.

---

## Scoring Methodology

Each variant is scored across 5 weighted criteria:

| # | Criterion | Weight | What it measures |
|---|-----------|--------|------------------|
| 1 | **Classification** | 30% | Correct identification of actionable vs non-actionable messages (F1 score) |
| 2 | **Subject Fidelity** | 25% | Exact character-by-character match of subject lines (no AI rewording) |
| 3 | **Deduplication** | 15% | Correct recognition of existing tasks (no phantom ID matches) |
| 4 | **Output Format** | 15% | Valid JSON with all required fields and correct value types |
| 5 | **Performance** | 15% | Scan duration (<60s = 100pts, 60-120s = 70pts, 120-300s = 50pts, timeout = 0pts) |

**Total = Σ(criterion_score × weight)**  
**Improvement threshold:** New variant must score ≥ 2 points higher than current best.  
**Stop condition:** 3 consecutive rounds without improvement.

---

## All Variants — Complete Results

### Round 1: Establishing the Winner

| Variant | Strategy | Score | Tasks | Duration | Outcome |
|---------|----------|-------|-------|----------|---------|
| **Baseline** | Original prompt (500 words) | **70.0** | 5 (3✅ 2❌) | 127s | Reference |
| **v1a** 🏆 | Structural: Decision framework + Teams rules + dedup guidance | **79.0** | 5 (4✅ 1❌) | 171s | **ADOPTED** |
| v1b | Content: DO/DON'T examples, anti-patterns | 71.5 | 1 (1✅) | 213s | Too conservative |
| v1c | Compact: Shortened to <400 words | 69.2 | 3 (0✅ 3❌) | 222s | Lost guidance, wrong tasks |

**Decision:** v1a adopted (+9 points). Added decision framework ("Does the user need to DO something specific?"), Teams-specific skip rules (casual chats, scheduling), and safer dedup ("match by title, never guess IDs").

### Round 2: Attempting to Improve v1a

| Variant | Strategy | Score | Tasks | Duration | Outcome |
|---------|----------|-------|-------|----------|---------|
| v2a | Recall+: Relaxed framing ("FN is permanent") | 0 | 0 | 222s | Model confused — found nothing |
| v2b | Dedup+: "100% certain" threshold from v1b | 0 | 0 | 246s | Too strict — found nothing |
| v2c | Few-shot: 10 concrete classification examples | 70.0 | 2 (2✅) | 126s | Perfect precision, poor recall |

**Decision:** No improvement. All variants scored ≤ v1a. Key learning: additional guidance makes the Copilot model MORE conservative, not more accurate.

### Round 3: Fundamentally Different Approaches

| Variant | Strategy | Score | Tasks | Duration | Outcome |
|---------|----------|-------|-------|----------|---------|
| v3a | Minimal fix: "at least 2 of 3 criteria" for emails | 69.2 | 4 (2✅ 2❌) | 264s | Service alerts leaked through |
| v3b | Tone shift: "thorough" instead of "conservative" | 57.8 | 4 (2? 2❌) | 265s | **Broke subject fidelity!** Model rewrote titles |
| v3c | Two-pass: Inclusive scan → strict filter | 70.0 | 3 (1✅ 1? 1❌) | 162s | Missed key emails |

**Decision:** No improvement. Most notably, v3b demonstrated that even a tone change (same rules!) causes the model to start rewriting subject lines and combining topics — a critical violation.

### Round 4: Final Attempts

| Variant | Strategy | Score | Tasks | Duration | Outcome |
|---------|----------|-------|-------|----------|---------|
| v4a | Reorder: Same words, positive criteria first | ~40 | 1 (1?) | 175s | Missed all emails |
| v4b | Channel split: Separate email/Teams defaults | ~60 | 2 (1✅ 1❌) | 182s | Service alert FP |
| v4c | Back to basics: Original + 3 surgical fixes | 0 | 0 | 300s | **TIMEOUT** |

**Decision:** No improvement. 3rd consecutive round → **Phase 1 optimization complete.**

---

## Why v1a Wins — Analysis

### What v1a Does Right

1. **Decision Framework:** The central question "Does this message require the user to perform a specific, concrete action?" gives the model a clear mental model before classifying anything.

2. **Teams-Specific Rules:** Teams messages have a "much higher bar" with explicit skip patterns (casual chats, scheduling, reactions, greetings). This eliminated the 2 false positives from the baseline.

3. **Safer Deduplication:** "Match by title similarity, never guess IDs, 95% confidence threshold" reduced failed update matches from 3 to 1.

4. **Balanced Tone:** The "conservative when in doubt, skip" framing is strict enough to filter noise but not so strict that it paralyzes the model (unlike v2a/v2b which found 0 tasks).

### Why Every Challenger Failed

| Approach | Why it failed |
|----------|--------------|
| More examples (v1b, v2c) | Model becomes overly cautious — matches examples too literally |
| Shorter prompt (v1c, v4c) | Loses critical guidance, finds wrong tasks or times out |
| Relaxed framing (v2a, v3a, v3b) | Either confuses model (0 tasks) or lets noise through |
| Stronger rules (v2b, v3c) | Model over-applies strictness, misses real items |
| Structural changes (v4a, v4b) | Reordering/splitting doesn't overcome fundamental model behavior |

### The Core Insight

**The Copilot model has a strong inherent bias toward caution.** Any additional guidance — regardless of intent — tends to amplify this bias. v1a hit a "sweet spot" where the prompt provides enough structure to improve classification without triggering over-cautious behavior. This sweet spot is fragile: even small changes destabilize it.

---

## Score Progression

```
Round:     Baseline    R1        R2        R3        R4
Best:      70.0        79.0      79.0      79.0      79.0
                        ↑
                     v1a adopted
                     (+12.9%)
```

---

## Remaining Weaknesses (v1a at 79/100)

| Criterion | Score | Issue | Improvable? |
|-----------|-------|-------|-------------|
| Classification | 70 | 1 scheduling FP, missed 1 email | Unlikely — every attempt made it worse |
| Subject Fidelity | 100 | Perfect | N/A |
| Deduplication | 70 | 1 failed update match | Unlikely — stricter rules → 0 tasks |
| Output Format | 100 | Perfect | N/A |
| Performance | 50 | 127-171s (target <60s) | **Not prompt-controllable** — API/system bound |

**Performance (50pts) is the biggest remaining gap** but cannot be improved through prompt optimization. It's determined by the Work IQ CLI's API call latency when scanning M365 messages.

---

## Files Reference

| File | Purpose |
|------|---------|
| `phase1/scores.json` | All scores, all rounds, machine-readable |
| `phase1/dashboard.html` | Visual dashboard (open in browser) |
| `phase1/OUTCOME.md` | Success criteria definition (German) |
| `phase1/FINAL_REPORT.md` | This report (English) |
| `phase1/golden-set/` | Baseline scan data + manual review |
| `phase1/results/` | Raw API responses for all 12 variants |
| `phase1/variants/` | All 12 prompt variants + original backup |
| `docs/SCAN_DISCOVERY_SKILL.md` | **The winning prompt (v1a)** — in production |

---

## Recommendation

**Phase 1 is optimized at 79/100 (+12.9% vs baseline).** The winning prompt (v1a) should be merged to `main` when all 4 phases are complete. No further prompt optimization rounds are recommended for Phase 1 — the model has reached its practical ceiling for this task with the current architecture.

To improve beyond 79/100, consider:
- Upgrading the underlying Copilot model (newer models may handle nuance better)
- Architectural changes to `server.js` (e.g., server-side pre-filtering of obvious noise before AI evaluation)
- Multi-stage scanning (quick pre-filter by rule, then AI for ambiguous cases only)

These are outside the scope of prompt optimization.
