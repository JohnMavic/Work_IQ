# Skill Evaluation Template

**Skill:** [SKILL_NAME]
**Version:** [baseline / v1 / v2 / ...]
**Datum:** [ISO TIMESTAMP]
**Evaluator:** Claude Code CLI

---

## 1. Testbedingungen

| Parameter | Wert |
|-----------|------|
| Branch | Agent_Zero_Claude_Loop |
| tasks.json | Frische Kopie von ORIGINAL_OPTIMIZATION |
| Server | localhost:3000 |
| Scan-Zeitraum | Letzte 7 Tage |
| Tasks getestet | [ANZAHL] |

---

## 2. Ergebnisse pro Kriterium

### [Kriterium 1]: [Name] (Gewicht: [%])

**Score: [0-100]**

| Metrik | Ziel | Ergebnis | Status |
|--------|------|----------|--------|
| [Metrik 1] | [Zielwert] | [Messwert] | OK/FAIL |
| [Metrik 2] | [Zielwert] | [Messwert] | OK/FAIL |

**Beobachtungen:**
- [Detail 1]
- [Detail 2]

### [Kriterium 2]: [Name] (Gewicht: [%])

[... gleiches Format ...]

---

## 3. Anti-Pattern Check

| Anti-Pattern | Beobachtet? | Details |
|--------------|-------------|---------|
| [Pattern 1]  | JA/NEIN     | [...]   |

---

## 4. Gesamtbewertung

| Kriterium | Gewicht | Score | Gewichteter Score |
|-----------|---------|-------|-------------------|
| [Name]    | [%]     | [/100]| [berechnet]       |
| **GESAMT**| 100%    |       | **[SCORE]/100**   |

---

## 5. API Responses (Auszüge)

### Request
```bash
[curl Befehl]
```

### Response
```json
[Relevante JSON-Auszüge — keine vollständigen Responses, nur relevante Felder]
```

---

## 6. Timing

| Phase | Dauer |
|-------|-------|
| Server-Start | [Xs] |
| API-Call | [Xs] |
| Gesamt | [Xs] |

---

## 7. Zusammenfassung

**Stärken:**
- [...]

**Schwächen:**
- [...]

**Empfohlene Optimierungen:**
- [...]
