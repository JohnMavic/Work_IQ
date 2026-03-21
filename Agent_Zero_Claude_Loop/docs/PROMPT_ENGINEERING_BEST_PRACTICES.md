# Prompt Engineering Best Practices für Skill File Optimierung

Dieses Dokument sammelt bewährte Techniken für die Optimierung von AI-Prompt-Skill-Files.
Referenz: Anthropic Prompt Engineering Guide, OpenAI Best Practices, Google DeepMind Research.

---

## 1. Struktur-Prinzipien

### 1.1 Optimale Prompt-Reihenfolge
```
1. Rollendefinition (Wer bist du?)
2. Kontext (Was weisst du?)
3. Aufgabe (Was sollst du tun?)
4. Constraints (Was darfst du NICHT tun?)
5. Beispiele (Wie sieht gute Arbeit aus?)
6. Output-Format (Wie soll die Antwort aussehen?)
```

### 1.2 Wichtigkeits-Priorisierung
- **Kritische Regeln am ANFANG und am ENDE** des Prompts (Primacy + Recency Effekt)
- Weniger wichtige Details in der Mitte
- Wiederhole die allerwichtigste Regel am Ende noch einmal

### 1.3 Klare Abschnitt-Trennung
- Verwende `##` Headers für Hauptabschnitte
- Verwende `###` für Unterabschnitte
- Trenne logische Blöcke mit `---`
- Nutze Bullet Points statt Fliesstext für Regeln

---

## 2. Anweisungs-Techniken

### 2.1 Positive vor Negative Anweisungen
```markdown
## DO:
- Copy the subject line character by character
- Include sender name and date

## DON'T:
- Do NOT rephrase or summarize subject lines
- Do NOT add prefixes like "Action Item:"
```

### 2.2 Chain-of-Thought (CoT)
Für komplexe Entscheidungen den Denkprozess vorgeben:
```markdown
Before classifying a message, ask yourself:
1. Is the user directly addressed (not just CC)?
2. Is there a specific action requested?
3. Is there a deadline or deliverable mentioned?
Only if at least one answer is YES → classify as actionable.
```

### 2.3 Few-Shot Beispiele
Konkrete Beispiele sind effektiver als abstrakte Regeln:
```markdown
### Example: Actionable message
Subject: "Please review the attached proposal by Friday"
→ Action required: YES (review + deadline)

### Example: Non-actionable message
Subject: "FYI: New office policy starting next month"
→ Action required: NO (informational, no specific request)
```

### 2.4 Grenzfall-Dokumentation
Edge Cases explizit ansprechen:
```markdown
### Edge Case: Calendar invites
- Calendar invite WITH action request in body → actionable
- Calendar invite WITHOUT body text → NOT actionable
- Calendar invite with "Please prepare..." → actionable
```

---

## 3. Output-Optimierung

### 3.1 JSON Schema spezifizieren
```markdown
Return ONLY a JSON object matching this schema:
{
  "summary": "string (2-4 sentences, same language as source)",
  "language": "string (iso 639-1: 'en', 'de', 'fr')",
  "confidence": "string (one of: 'high', 'medium', 'low', 'none')"
}
```

### 3.2 Output-Hygiene
```markdown
Return ONLY the JSON. No markdown formatting, no ```json blocks,
no explanation text, no preamble, no trailing text.
```

### 3.3 Fehler-Output definieren
Immer einen klaren Fehlerfall-Output spezifizieren:
```markdown
If the content cannot be retrieved:
{
  "summary": null,
  "confidence": "none",
  "error": "Brief explanation of what went wrong"
}
```

---

## 4. Mess-Techniken für Prompt-Qualität

### 4.1 A/B-Vergleich
- Gleiche Eingabe, unterschiedliche Prompts
- Mindestens 3 Durchläufe pro Variante (wegen Nicht-Determinismus)
- Gewichteter Score über alle Kriterien

### 4.2 Ablation Testing
- Eine Regel/Anweisung entfernen
- Testen ob die Qualität sinkt
- Falls nicht: die Regel war redundant → entfernen (kürzerer Prompt = besser)

### 4.3 Regression Testing
- Nach jeder Änderung ALLE Phasen testen
- Nicht nur die geänderte Phase
- Dokumentieren welche Phasen getestet wurden

---

## 5. Häufige Fehler bei Prompt-Optimierung

### 5.1 Over-Prompting
- Zu viele Regeln → Modell ignoriert einige
- Lösung: Priorisieren, zusammenfassen, redundante entfernen

### 5.2 Widersprüchliche Anweisungen
- "Be concise" + "Include all details" → Konflikt
- Lösung: Spezifisch sein ("2-4 sentences that include names, dates, deadlines")

### 5.3 Implizite Erwartungen
- Annahmen, die nicht im Prompt stehen
- Lösung: Alles explizit machen, nichts voraussetzen

### 5.4 Fehlende Negativbeispiele
- Nur positive Beispiele zeigen → Modell kennt Grenzen nicht
- Lösung: Immer auch DON'T-Beispiele mitgeben

### 5.5 Prompt-Bloat
- Jede Iteration fügt Regeln hinzu, keine werden entfernt
- Lösung: Regelmässig Ablation Testing, redundante Regeln entfernen
