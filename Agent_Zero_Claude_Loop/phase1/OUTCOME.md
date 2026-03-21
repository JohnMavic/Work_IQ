# Phase 1 — OUTCOME Definition

> **Scan & Discovery**: Was ist das perfekte Ergebnis und wie messen wir es?

---

## Ziel der Phase 1

Phase 1 ist der **kritischste Filter** der gesamten Pipeline. Sie scannt den M365-Posteingang (Outlook + Teams), identifiziert aktionierbare Nachrichten und klassifiziert sie in drei Kategorien:

- **`new`** — Neue Aufgabe erkannt, die noch nicht existiert
- **`update`** — Bestehende Aufgabe hat ein Update erhalten
- **`skip`** — Nachricht ist nicht aktionierbar (Newsletter, CC, Info-Mail)

**Warum ist das kritisch?** Alles, was Phase 1 übersieht, existiert für die nachfolgenden Phasen nicht. Ein vergessener Task kann nie enriched, nie geloggt, nie getrackt werden. Umgekehrt: Jeder False Positive erzeugt Müll-Tasks, die manuell bereinigt werden müssen.

**Output-Format:** JSON-Array, wobei jedes Element folgende Felder enthält:

```json
{
  "action": "new | update | skip",
  "title": "Exakter Betreff der Nachricht",
  "source": "outlook | teams",
  "from": "sender@example.com",
  "date": "2026-03-15T09:30:00Z",
  "link": "https://outlook.office365.com/..."
}
```

---

## Perfektes Resultat

Das perfekte Ergebnis von Phase 1 erfüllt **alle 7 Eigenschaften**:

### 1. VOLLSTÄNDIGKEIT — ≥95% Recall
Mindestens 95% aller tatsächlich aktionierbaren Nachrichten werden erkannt. Lieber ein False Positive zu viel als ein echter Task übersehen.

### 2. SAUBERKEIT — ≤5% False Positives
Maximal 5% der als `new` oder `update` klassifizierten Nachrichten sind tatsächlich nicht aktionierbar. Weniger Rauschen = weniger manuelle Nacharbeit.

### 3. TREUE — Subject Lines sind 1:1 Kopien
Der `title` ist eine **exakte Kopie** der Betreffzeile. Kein Kürzen, kein Umformulieren, kein "Intelligentes Zusammenfassen". Die Original-Betreffzeile ist die einzige Wahrheit.

### 4. SMART — Deduplizierung ≥90%
Wenn dieselbe Nachricht in mehreren Threads oder als Reply auftaucht, wird sie mindestens zu 90% korrekt dedupliziert. Keine doppelten Tasks im Output.

### 5. SCHNELL — <60 Sekunden
Der gesamte Scan-Vorgang (API-Call → Klassifikation → JSON-Output) dauert unter 60 Sekunden. Ziel: <30 Sekunden.

### 6. ROBUST — Immer gültiges JSON
Der Output ist **immer** ein valides JSON-Array. Auch bei leerer Inbox, bei API-Fehlern, bei Timeout. Kein kaputter Output, niemals.

### 7. KORREKT — Metadata stimmt
`source`, `from`, `date` und `link` sind korrekt aus der API übernommen. Keine vertauschten Felder, keine fehlenden Werte, keine erfundenen Links.

---

## Erfolgskriterien (detailliert)

### Kriterium 1: Klassifikation — Gewicht: 30%

**Was wird gemessen:**
Die Fähigkeit, Nachrichten korrekt als `new`, `update` oder `skip` zu klassifizieren. Gemessen als F1-Score (harmonisches Mittel aus Precision und Recall).

**Wie wird gemessen (Schritt für Schritt):**
1. Golden Set laden (`phase1/golden-set/` — manuell gelabelte Nachrichten)
2. Phase 1 gegen das Golden Set laufen lassen
3. Für jede Nachricht: Vergleich `erwartete_action` vs. `tatsächliche_action`
4. Confusion Matrix erstellen (True Positives, False Positives, False Negatives, True Negatives)
5. Precision berechnen: `TP / (TP + FP)`
6. Recall berechnen: `TP / (TP + FN)`
7. F1-Score berechnen: `2 × (Precision × Recall) / (Precision + Recall)`

**Scoring-Tabelle:**

| F1-Score       | Punkte |
|----------------|--------|
| ≥ 0.95         | 100    |
| 0.90 – 0.94    | 85     |
| 0.80 – 0.89    | 70     |
| 0.70 – 0.79    | 50     |
| 0.60 – 0.69    | 30     |
| < 0.60         | 0      |

**Konkretes Beispiel:**
Golden Set hat 40 Nachrichten (25× `new/update`, 15× `skip`).
- Phase 1 erkennt 23 von 25 korrekt → TP = 23, FN = 2
- Phase 1 markiert 2 von 15 Skips fälschlich als aktionierbar → FP = 2
- Precision = 23 / (23 + 2) = 0.920
- Recall = 23 / (23 + 2) = 0.920
- F1 = 2 × (0.920 × 0.920) / (0.920 + 0.920) = **0.920** → **85 Punkte**

**Automatisierbar:** ✅ Ja — Golden Set + Script vergleicht automatisch.

---

### Kriterium 2: Subject Fidelity — Gewicht: 25%

**Was wird gemessen:**
Ob der `title` im Output **zeichengenau** mit der Original-Betreffzeile übereinstimmt. Kein Zeichen darf fehlen, hinzugefügt oder verändert sein.

**Wie wird gemessen (Schritt für Schritt):**
1. Für jede Nachricht im Golden Set: Original-Betreff aus der API holen
2. `title` aus dem Phase-1-Output nehmen
3. Character-by-Character-Vergleich (case-sensitive, whitespace-sensitive)
4. Match-Rate berechnen: `Anzahl exakter Matches / Gesamtanzahl Nachrichten × 100`

**Scoring-Tabelle:**

| Match-Rate     | Punkte |
|----------------|--------|
| 100%           | 100    |
| 95% – 99%      | 80     |
| 90% – 94%      | 60     |
| 80% – 89%      | 30     |
| < 80%          | 0      |

**Konkretes Beispiel:**
30 Nachrichten gescannt. 28 haben exakt den Original-Betreff, 2 wurden leicht verändert (z.B. Whitespace getrimmt).
- Match-Rate = 28 / 30 × 100 = **93.3%** → **60 Punkte**

**Automatisierbar:** ✅ Ja — String-Vergleich ist trivial zu automatisieren.

---

### Kriterium 3: Deduplizierung — Gewicht: 15%

**Was wird gemessen:**
Ob Nachrichten, die sich auf denselben Vorgang beziehen (Reply-Chains, Forwards, Cross-Posts Outlook↔Teams), korrekt zusammengeführt werden. Gemessen als Dedup-Rate.

**Wie wird gemessen (Schritt für Schritt):**
1. Golden Set enthält bekannte Duplikat-Gruppen (z.B. 3 Nachrichten gehören zum selben Task)
2. Phase 1 laufen lassen
3. Prüfen: Wie viele Duplikat-Gruppen wurden korrekt auf einen einzigen Eintrag reduziert?
4. Task-IDs (oder Titles) im Output zählen und mit erwarteter Anzahl vergleichen
5. Dedup-Rate berechnen: `Korrekt deduplizierte Gruppen / Gesamte Duplikat-Gruppen × 100`

**Scoring-Tabelle:**

| Dedup-Rate     | Punkte |
|----------------|--------|
| ≥ 95%          | 100    |
| 85% – 94%      | 80     |
| 75% – 84%      | 60     |
| 60% – 74%      | 30     |
| < 60%          | 0      |

**Konkretes Beispiel:**
Golden Set hat 10 Duplikat-Gruppen. Phase 1 erkennt 8 davon korrekt und reduziert sie auf je einen Eintrag. 2 Gruppen bleiben als separate Einträge.
- Dedup-Rate = 8 / 10 × 100 = **80%** → **60 Punkte**

**Automatisierbar:** ✅ Ja — Voraussetzung: Golden Set definiert Duplikat-Gruppen explizit.

---

### Kriterium 4: Output Format — Gewicht: 15%

**Was wird gemessen:**
Ob der Output valides JSON ist, das dem definierten Schema entspricht. Jedes Feld muss vorhanden sein, den richtigen Typ haben und sinnvolle Werte enthalten.

**Wie wird gemessen (Schritt für Schritt):**
1. Output von Phase 1 als String nehmen
2. `JSON.parse()` — muss ohne Fehler durchlaufen
3. JSON Schema Validation gegen das definierte Schema:
   - `action`: String, enum `["new", "update", "skip"]`
   - `title`: String, nicht leer
   - `source`: String, enum `["outlook", "teams"]`
   - `from`: String, gültiges E-Mail-Format oder Teams-Username
   - `date`: String, gültiges ISO 8601 Datum
   - `link`: String, gültige URL oder leerer String
4. Jedes Item einzeln validieren
5. Schema-Compliance berechnen: `Valide Items / Gesamte Items × 100`

**Scoring-Tabelle:**

| Schema-Compliance | Punkte |
|-------------------|--------|
| 100%              | 100    |
| 95% – 99%         | 70     |
| 90% – 94%         | 40     |
| < 90%             | 0      |

**Sonderfall:** Wenn `JSON.parse()` fehlschlägt → **0 Punkte**, unabhängig vom Inhalt.

**Konkretes Beispiel:**
Output enthält 25 Items. 24 sind schema-konform, 1 hat ein fehlendes `date`-Feld.
- Schema-Compliance = 24 / 25 × 100 = **96%** → **70 Punkte**

**Automatisierbar:** ✅ Ja — JSON Schema Validator (z.B. `ajv`) prüft automatisch.

---

### Kriterium 5: Performance — Gewicht: 15%

**Was wird gemessen:**
Die Gesamtdauer vom Start des Scans bis zum fertigen JSON-Output. Gemessen in Sekunden.

**Wie wird gemessen (Schritt für Schritt):**
1. Timestamp vor dem Start: `const start = Date.now()`
2. Phase 1 ausführen (inkl. API-Calls, Klassifikation, Dedup, JSON-Erstellung)
3. Timestamp nach dem Ende: `const end = Date.now()`
4. Dauer berechnen: `(end - start) / 1000` Sekunden
5. Über 3 Durchläufe mitteln (um Netzwerk-Schwankungen auszugleichen)

**Scoring-Tabelle:**

| Dauer          | Punkte |
|----------------|--------|
| < 15 Sek       | 100    |
| 15 – 29 Sek    | 85     |
| 30 – 44 Sek    | 70     |
| 45 – 59 Sek    | 50     |
| 60 – 89 Sek    | 25     |
| ≥ 90 Sek       | 0      |

**Konkretes Beispiel:**
3 Durchläufe: 22s, 25s, 24s → Durchschnitt = **23.7 Sekunden** → **85 Punkte**

**Automatisierbar:** ✅ Ja — Timer um den Scan-Aufruf.

---

## Gesamtscore-Berechnung

Der Gesamtscore wird als gewichteter Durchschnitt berechnet:

```
Gesamtscore = (Klassifikation × 0.30)
            + (Subject Fidelity × 0.25)
            + (Deduplizierung × 0.15)
            + (Output Format × 0.15)
            + (Performance × 0.15)
```

**Rechenbeispiel mit den Werten von oben:**

| Kriterium          | Punkte | Gewicht | Gewichtet |
|--------------------|--------|---------|-----------|
| Klassifikation     | 85     | 0.30    | 25.50     |
| Subject Fidelity   | 60     | 0.25    | 15.00     |
| Deduplizierung     | 60     | 0.15    | 9.00      |
| Output Format      | 70     | 0.15    | 10.50     |
| Performance        | 85     | 0.15    | 12.75     |
| **Gesamtscore**    |        |         | **72.75** |

**Interpretation:**
- **≥ 90 Punkte:** Exzellent — Phase 1 ist produktionsreif
- **75 – 89 Punkte:** Gut — kleinere Optimierungen möglich
- **60 – 74 Punkte:** Akzeptabel — gezielte Verbesserungen nötig
- **< 60 Punkte:** Ungenügend — grundlegende Überarbeitung erforderlich

---

## Verbesserungsschwelle

Die Optimierungs-Loop folgt strikten Regeln:

### Variante wird übernommen wenn:
```
Neuer Score > Alter Score + 2 Punkte
```
Eine Verbesserung von ≤2 Punkten gilt als **Rauschen**, nicht als echte Verbesserung. Nur signifikante Fortschritte werden akzeptiert.

### Variante wird verworfen wenn:
```
Neuer Score ≤ Alter Score + 2 Punkte
```
Die alte Variante bleibt bestehen. Der Versuch wird als "keine Verbesserung" gezählt.

### Ausoptimiert (Exit-Condition):
```
3× hintereinander keine Verbesserung → Phase 1 ist ausoptimiert
```
Nach drei aufeinanderfolgenden Versuchen ohne signifikante Verbesserung wird Phase 1 als "gut genug" betrachtet. Die Loop geht weiter zur nächsten Phase.

### Beispiel-Verlauf:
| Versuch | Score  | Delta  | Entscheidung            |
|---------|--------|--------|-------------------------|
| v1      | 65.0   | —      | Baseline                |
| v2      | 71.5   | +6.5   | ✅ Übernommen           |
| v3      | 73.0   | +1.5   | ❌ Verworfen (≤2)       |
| v4      | 78.2   | +6.7   | ✅ Übernommen           |
| v5      | 79.0   | +0.8   | ❌ Verworfen (≤2) — 1/3 |
| v6      | 79.5   | +0.5   | ❌ Verworfen (≤2) — 2/3 |
| v7      | 80.1   | +1.1   | ❌ Verworfen (≤2) — 3/3 |
| —       | —      | —      | 🛑 Ausoptimiert bei 78.2 |

---

## Anti-Patterns

Phase 1 darf folgendes **NICHT** tun:

### ❌ Betreffzeilen verändern
Kein Kürzen, kein Zusammenfassen, kein "Intelligentes Umformulieren". Der `title` ist eine 1:1-Kopie. Immer.

### ❌ Nachrichten-Inhalte lesen oder analysieren
Phase 1 arbeitet nur mit **Metadaten** (Betreff, Absender, Datum, Source). Der Body der Nachricht wird nicht gelesen — das ist Aufgabe späterer Phasen.

### ❌ Tasks erstellen oder in DevOps schreiben
Phase 1 **identifiziert** nur. Sie erstellt keine Tasks, schreibt nichts in Azure DevOps, verändert keinen externen State.

### ❌ Priorisierung vornehmen
Keine Sortierung nach Wichtigkeit, keine Urgency-Labels. Phase 1 liefert eine flache Liste. Priorisierung ist Aufgabe späterer Phasen.

### ❌ Halluzinierte Daten erfinden
Wenn ein Feld nicht aus der API kommt, wird es nicht geraten. Fehlende Daten werden als leerer String (`""`) oder `null` geliefert, niemals erfunden.

### ❌ Stille Fehler
Wenn die API nicht erreichbar ist oder ein Fehler auftritt, muss dies im Output sichtbar sein (z.B. als Error-Objekt). Kein leerer Output ohne Erklärung.

### ❌ Endlos laufen
Wenn der Scan nach 90 Sekunden nicht fertig ist, wird abgebrochen und der aktuelle Stand zurückgegeben. Kein Hängenbleiben.

---

## Golden Set

### Was ist das Golden Set?

Das Golden Set ist eine **manuell kuratierte Sammlung von Nachrichten** mit bekannten, korrekten Klassifikationen. Es ist die einzige Wahrheitsquelle für die Bewertung von Phase 1.

### Aufbau

```
phase1/golden-set/
├── messages.json          # Die Nachrichten (simulierte API-Responses)
├── expected-output.json   # Die erwarteten Klassifikationen
├── dedup-groups.json      # Definierte Duplikat-Gruppen
└── README.md              # Beschreibung und Pflegehinweise
```

### messages.json — Struktur

```json
[
  {
    "id": "msg-001",
    "subject": "RE: Sprint Review Feedback benötigt",
    "from": "anna.schmidt@contoso.com",
    "date": "2026-03-15T09:30:00Z",
    "source": "outlook",
    "link": "https://outlook.office365.com/mail/id/msg-001",
    "isReply": true,
    "threadId": "thread-042"
  }
]
```

### expected-output.json — Struktur

```json
[
  {
    "id": "msg-001",
    "expected_action": "update",
    "reason": "Reply auf bestehenden Thread mit Handlungsbedarf"
  }
]
```

### dedup-groups.json — Struktur

```json
[
  {
    "group_id": "dedup-001",
    "message_ids": ["msg-003", "msg-007", "msg-012"],
    "expected_survivor": "msg-003",
    "reason": "Gleicher Thread, Cross-Post Outlook → Teams"
  }
]
```

### Zusammensetzung des Golden Sets

Das Golden Set muss **repräsentativ** sein und folgende Kategorien abdecken:

| Kategorie                     | Anzahl | Erwartete Action |
|-------------------------------|--------|------------------|
| Echte neue Tasks              | 8–10   | `new`            |
| Updates auf bestehende Tasks  | 5–7    | `update`         |
| Newsletter / Automatisiert    | 4–5    | `skip`           |
| CC-Nachrichten ohne Aktion    | 3–4    | `skip`           |
| Teams-Nachrichten (neue)      | 3–4    | `new`            |
| Teams-Nachrichten (Updates)   | 2–3    | `update`         |
| Duplikate (Outlook ↔ Teams)   | 3–4    | Dedup-Gruppen    |
| Edge Cases (leer, Unicode)    | 2–3    | Variiert         |
| **Gesamt**                    | **30–40** |               |

### Pflege des Golden Sets

- **Wer pflegt es:** Manuell, durch den Entwickler
- **Wann aktualisieren:** Bei neuen Nachrichtentypen oder Edge Cases
- **Versionierung:** Das Golden Set wird mit Git versioniert
- **Regel:** Das Golden Set wird **nie** an den Code angepasst — der Code wird an das Golden Set angepasst

### Reproduzierbarkeit

Jeder Testlauf mit demselben Golden Set und demselben Code muss **identische Ergebnisse** liefern. Dafür gelten:

1. **Keine Zufallselemente** — Kein `Math.random()`, kein Date-basiertes Verhalten
2. **Deterministische Sortierung** — Output wird immer nach `date` sortiert
3. **Fixierte Testdaten** — Das Golden Set verwendet statische Daten, keine Live-API-Calls
4. **Seed-basierte IDs** — Falls IDs generiert werden, mit festem Seed

---

> **Zusammenfassung:** Phase 1 ist dann perfekt, wenn sie alle aktionierbaren Nachrichten findet (≥95%), kaum Fehler macht (≤5% FP), Betreffzeilen nicht antastet, Duplikate erkennt, schnell ist, und immer sauberes JSON liefert. Das Golden Set ist der Maßstab — der Code wird daran gemessen, nie umgekehrt.
