# Skill Optimizer starten — Anleitung für Einsteiger

## Was macht dieses Tool?

Dieses Tool verbessert automatisch die AI-Prompts (Skill Files) von Agent Zero. Es:
1. Testet die aktuelle Version eines Skill Files
2. Erstellt eine verbesserte Version
3. Testet die neue Version
4. Vergleicht alt vs. neu
5. Übernimmt nur nachweislich bessere Versionen
6. Wiederholt den Prozess bis keine Verbesserung mehr möglich ist

---

## Voraussetzungen

- Agent Zero ist installiert und funktionsfähig unter `E:\Work_IQ\Agent_Zero`
- Node.js ist installiert
- Git ist installiert
- Work IQ MCP ist konfiguriert und authentifiziert
- Claude Code CLI ist installiert

---

## Start in 3 Schritten

### Schritt 1: Terminal öffnen

Öffne ein Terminal (PowerShell, Git Bash, oder CMD) und navigiere zum Projektordner:

```bash
cd E:/Work_IQ/Agent_Zero_Claude_Loop
```

### Schritt 2: Claude Code starten

```bash
claude
```

### Schritt 3: Optimierung starten

Gib folgenden Befehl ein:

```
Lies OPTIMIZE_SKILL.md und führe den Skill-Optimierungsprozess aus.
Nutze die Success-Kriterien aus config/success_criteria.json.
```

Claude wird dich dann fragen, welche Skills du optimieren möchtest.

---

## Während der Optimierung

- Du wirst gefragt, welche Phase(n) optimiert werden sollen (1-4 oder alle)
- Claude gibt dir regelmässig Status-Updates im Terminal
- Bei Unklarheiten wirst du gefragt
- Der Prozess stoppt automatisch, wenn keine Verbesserung mehr möglich ist

## Nach der Optimierung

- Ergebnisse findest du in `results/`
- Optimierte Skill Files liegen in `skills/optimized/`
- Die verbesserten Files sind bereits im Branch `Agent_Zero_Claude_Loop` committed
- Um sie in main zu übernehmen, erstelle einen Pull Request

## Sicherheit

- Deine Daten (`tasks.json`) werden doppelt gesichert und am Ende wiederhergestellt
- Der `main` Branch wird NIEMALS verändert
- Alle Änderungen passieren nur auf dem Branch `Agent_Zero_Claude_Loop`
- Falls etwas schiefgeht: `tasks.json.BACKUP_OPTIMIZATION` ist dein Notfall-Backup
