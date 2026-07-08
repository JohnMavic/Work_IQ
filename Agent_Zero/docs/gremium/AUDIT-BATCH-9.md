AUDIT9: PASS-WITH-LIMIT attachment-content-not-indexed

# Batch 9 „ENTFESSELUNG" — Re-Audit FINAL-4 nach 9H (warm)

**Datum:** 2026-07-08 · **Branch:** `feature/agency-brain` (HEAD `3419a34` „Report Batch 9H result", nach 9H-Commit `a95f24c` „Add node obsolete marker and attachment index retry") · **Auditor:** GitHub Copilot CLI (isolierte Kind-Instanz) · **Kontext:** System **warm** (kein Neustart). Es lief **keine** Agent-Zero-Nutzer-Instanz (`:3000` refused; Lockfile-PID vom Vortag stale/tot, unangetastet). Der `node server.js` (PID **10704**) ist eine **Task-Zero**-Instanz aus `E:\Task_Zero 03` (Child `mail-worker.ps1`) — anderes Projekt, nicht angetastet.

## Verdikt
**AUDIT9: PASS-WITH-LIMIT attachment-content-not-indexed** — 9H behebt den 9G-Kern­defekt (d) **vollständig** und verbessert (a) messbar; das einzige Rest-Limit ist **Umgebungs­varianz** (M365-Index exponierte diesen Lauf keinen Anhang-Inhalt), die der Agent **ehrlich** und **mit der neuen Re-Probe-Mechanik** behandelt.
- **(d) PASS** — der veraltete **AV-Go-Live 1. Jul 2026** ist im State jetzt **`state="obsolete"`** mit **`obsoleteReason="target date passed without completion evidence — needs re-plan"`**, gebucht durch den **eigenständigen `NODE_OBSOLETE`-Marker** des **Primärlaufs** (deep `8ad20556`, `history[type=node-obsolete]` ts=13:40:26). Der Reality-Gateway hat den Marker **approved (held 0)** — die 9G-„Sippenhaft" (Obsolet-Disposition ging mit einer gehaltenen groben `PROJECT_UPDATE` verloren) ist **beseitigt**, weil `NODE_OBSOLETE` **nicht** mehr an Completion-/`userActions`-Checks gekoppelt ist.
- **(b) PASS** — **`markersApplied 4` (> 0)**, Gateway approved 4 / held 0, **granulare** Quality-Gate held 0 / review 1, **granulares** Temporal-Gate `ok:false, staleNodes 6, addressed 2, held 0, review 4`; kein Batch-Hold. reviewQueue +6 (78 → 84).
- **(c) PASS** — Stufe-1 = **23,9 s** (warm, `mcpMode:'none'`, < 90 s).
- **(a) PASS-WITH-LIMIT** — Anhang **enumeriert + geprobt + einmal wiederholt** (`attachmentIndexAttempts:2`); der M365-Index gab **nach dem Retry nachweislich keinen** Deck-Inhalt her → **ehrlich** `attachmentsHandled:"failed(content-not-indexed)"` **persistiert** (Ledger 19 → 21, `reprobeNextScan:true`) + **reviewQueue-Re-Probe-Eintrag** („attachment not indexed yet — re-probe next scan: …"). **Keine unbelegte Slide-Behauptung** (PIS 31. Aug / Port-Counts / AV-Steps **nicht** asseriert; `workiq-index` 0×; PIS/„31 Aug"-Vorkommen im State **6 = 6** identisch zur Baseline → nichts Neues erfunden).

## Kern-Befund
9H löst die zwei entkoppelten 9G-Rest-Defekte:
1. **(d) gelöst durch `NODE_OBSOLETE`-Minimal-Marker mit schmaler Gateway-Prüfung.** Der Deep-Prompt zwingt Temporal-Obsolet-Bookings jetzt in **eigenständige** `NODE_OBSOLETE`-Marker (nie gebündelt in `PROJECT_UPDATE.pmStatus`). Die Validierung ist eng (Node existiert, Datum vergangen, `obsoleteReason` vorhanden; Evidenz optional). Der Reality-Gateway-Prompt behandelt `NODE_OBSOLETE` explizit als **schmale Stale-Date-Disposition** und **nicht** als Completion-Claim — dadurch wurde der Marker **nicht** wegen „completion while waitingOn populated" oder fehlender `askQuote`-Evidenz gehalten. Das Temporal-Gate erkennt `NODE_OBSOLETE` via `nodeObsoleteHandles` als **adressierend** (`addressed 2/6`), der Applier bucht **nur** `state="obsolete"` + `obsoleteReason` (keine `pmStatus`-Ersetzung, kein Completion-Assert). **Ergebnis: der Primärlauf bucht die AV-Go-Live obsolet — sauber attribuiert an den Chat-Auftrag.**
2. **(a) verbessert durch Anhang-Index-Retry + Re-Probe-Persistenz.** Der Agent enumerierte den Anhang, las die Bodies, und probte den Deck-Inhalt **mit der vorgeschriebenen alternativen Zweit-Formulierung** (Dateiname vs. Thread+Sender+Datum). Der Index lieferte **auch nach dem Retry** keinen Inhalt (`content-not-indexed`). Anders als 9G (wo die Ledger-Disposition **gar nicht persistiert** wurde, Ledger blieb 19) wird die `failed(content-not-indexed)`-Disposition diesen Lauf **persistiert** (Ledger 21, `reprobeNextScan:true`, `attachmentIndexAttempts:2`) **plus** ein automatischer reviewQueue-Re-Probe-Eintrag — der Verarbeitungs­cursor läuft nicht über das Item hinweg. Der Agent asseriert **ausschließlich** body-/thread-verifizierte Fakten. **Welcher (a)-Fall eintrat:** der **content-not-indexed-Fall** (Index liefert nach Retry nichts) → PASS-WITH-LIMIT per Kriterium.

## Bewertung je Kriterium
| # | Kriterium | Verdikt | Beleg |
|---|---|---|---|
| a | Anhang-Fakten **geerntet UND persistiert** (Fall 1) **ODER** ehrlicher `failed(content-not-indexed)` + Re-Probe-Eintrag + keine unbelegte Slide-Behauptung (Fall 2) | ✅ **PASS-WITH-LIMIT** (Fall 2) | Anhang „Seestrasse August Works Comms.pdf" enumeriert + geprobt + **1× Retry** (`attachmentIndexAttempts:2`) → **content-not-indexed**. Ledger 19 → 21 mit `attachmentsHandled:"failed(content-not-indexed)"`, `reprobeNextScan:true`; reviewQueue-Eintrag „attachment not indexed yet — re-probe next scan". `workiq-index` 0×; PIS/„31 Aug" im State **6 = 6** (Baseline), **keine** neue Slide-Behauptung. Deep-Antwort verbatim: „attachment-only facts (slide timeline, port counts, AV steps) are **not asserted**; re-probe next scan." |
| b | Granulares Gate — valide Marker angewandt, Rest reviewQueue; **markersApplied MUSS > 0** | ✅ **PASS** | Gateway approved 4 / held 0; granulare Quality-Gate held 0 / review 1; granulares Temporal-Gate `ok:false, staleNodes 6, addressed 2, held 0, review 4`; **`markersApplied 4`**. reviewQueue +6 (78 → 84). Keine falschen States (CorpNet/Patch-Panel/SupplierWeb blieben aus Projektstate; Teams-Doku-Query no-change). |
| c | Stufe-1-Antwort < 90 s (warm) | ✅ **PASS** | **23,9 s** (Primär, warm, `mcpMode:'none'`). Konsistent mit Warm-Nachmessung **22,0 s** und 9F 22,4 s / 9G 23,1 s. (Transparenz: ein früherer, verworfener Erst-Lauf hatte einen **API-Latenz-Spike von 109,8 s** unter zwei parallelen fremden opus-agency-Prozessen — kein 9H-Bezug; Stufe-1 hat keinen 9H-Code-Pfad. Die saubere Re-Messung 22,0 s belegt den Warm-Steady-State.) |
| d | Veralteter AV-Go-Live 1. Jul im STATE **obsolete** via `NODE_OBSOLETE` (obsoleteReason vorhanden) — Marker nicht mehr in Sippenhaft | ✅ **PASS** | `pmStatus.planned:"AV Go-Live target 1 Jul 2026 for commissioned rooms"` jetzt **`state="obsolete"`**, `obsoleteReason="target date passed without completion evidence — needs re-plan"`, `updatedAt=13:40:26`; `history[type=node-obsolete]` durch **Primär-Deep `8ad20556`** gebucht; Gateway **approved (held 0)**. Deep-Antwort verbatim: „the **AV go-live 1 Jul 2026** target has passed with no completion evidence — booked obsolete for re-plan (this is not a completion claim)." |

## Stufe-2-Antwort (Beleg, verbatim, gekürzt)
> Attachment content is **not indexed** (confirmed after the mandatory alternative-formulation retry). I'll mark it `failed(content-not-indexed)` and not assert attachment-only facts. …
> Attachment **"Seestrasse August Works Comms.pdf"** deck is **not indexed** after one alternative-formulation retry — attachment-only facts (slide timeline, port counts, AV steps) are **not asserted**; re-probe next scan.
> Temporal pass: the **AV go-live 1 Jul 2026** target has passed with no completion evidence — booked obsolete for re-plan (this is not a completion claim). The 17 Aug workspace prep and the August cabling window remain valid.

## Gateway-/Gate-Beleg (verbatim aus dem Task-State, `history[].agentFollowups[].gateway`, jobId `8ad20556`)
```
markersParsed: 4, markersApplied: 4, markersHeld: 0, markersDropped: 0, markerProcessingStatus: "partial"
gateway: { parsed: true, approvedMarkers: 4, heldMarkers: 0 }
qualityGate: { ok: false, heldMarkers: 0, reviewItems: 1,
  reason: "ledger count mismatch for workiq-conversation-confirmation-temporary-workspace-setup-seestrasse: expected 1, got 2" }
temporalGate: { ok: false, staleNodes: 6, addressed: 2, heldMarkers: 0, reviewItems: 4 }
processing.ledger: 19 -> 21  (neu: email:…tempws-20260706-1845 attachmentsHandled="failed(content-not-indexed)" reprobeNextScan=true attachmentIndexAttempts=2;
                              teams:…sharepoint-docs-20260706-1632 disposition="no-change" attachmentsHandled="none")
reviewQueue: 78 -> 84  (+1 re-probe, +1 quality-gate, +4 "stale date unreconciled" li-see-*)
pmStatus.planned[]: "AV Go-Live target 1 Jul 2026 for commissioned rooms"  state=obsolete  obsoleteReason="target date passed without completion evidence — needs re-plan"
pmStatus.planned[]: "August cabling works scheduled 17-28 Aug 2026"        state=confirmed
```

## Timing-Baseline
Primär-Query: „Suche in der Inbox nach Updates und aktualisiere die PM-View-Felder." (POST `2026-07-08T13:40:02.339Z`, epoch `1783518002339`). Alle Rel-Werte gegen POST; Server-`ts` (ms) aus Job-Events.

**Antwortzeiten (Absetzen → …):**
| Meilenstein | Rel-POST | Beleg |
|---|---|---|
| Stufe-1-Antwort (fast job.completed) | **23,9 s** | fast `9577bae0` (state-only, `mcpMode:'none'`, `intent:answer`) — **(c)-Wert, warm** |
| Warm-Nachmessung Stufe-1 (Kontrolle) | **22,0 s** | Trivial „Summarize…", eigener fast-Job — bestätigt Warm-Steady-State |
| Stufe-2-Nachtrag (deep answer_posted) | **465,3 s ≈ 7,75 min** | deep `8ad20556`, `job.completed`/`answer_posted` |
| Stufe-2-Marker-Verarbeitung (marker_apply_done) | **565,7 s ≈ 9,43 min** | granulare Gates, `markersApplied 4 / held 0`, `markerProcessedAt 13:49:28Z` |

**Phasen-Zerlegung:**
| Phase | Fenster (rel POST) | Dauer |
|---|---|---|
| Queue (POST → fast started) | 0,0 → ~0,07 s | ~0,07 s |
| Stufe-1 Brain (state-only, `mcp=none`) | 0,07 → 23,9 s | ~23,9 s |
| Deep-Enqueue → Deep brain_run-Start | 23,9 → 24,0 s | **~0 s (kein Semaphore-Block** — Warm-up-Deep sauber gekillt) |
| Stufe-2 Brain Discovery + Anhang-Enum/Probe/Retry + Reasoning (6 WorkIQ) | 24,0 → 465,3 s | ~441,3 s |
| Stufe-2 Antwort gepostet | 465,3 s | — |
| Gateway (xhigh) + granulare Quality-Gate + granulares Temporal-Gate + Apply | 465,3 → 565,7 s | ~100,4 s |
| **Total POST → Marker-Verarbeitung** | | **565,7 s (9,43 min)** |

**WorkIQ-Einzelabfrage-Zeiten** (kumulativer `workIqCalls`-Zähler; Rel-POST bei Abschluss; Brain-`elapsedMs`):
| WorkIQ # | Rel-POST bei Abschluss | Brain-elapsed |
|---|---|---|
| 1 | 102,4 s | 78 s |
| 2–3 (parallel) | 147,4 s | 123 s |
| 4–5 (parallel) | 194,4 s | 170 s |
| 6 | 244,1 s | 220 s |
| (Compose + Anhang-Enum/Probe + 1× Retry + Antwort) | 244,1 → 465,3 s | — |

Kein Tool-Budget-Ereignis (weder 40-Call-Warnung noch 150-Call-Notstopp; **6 WorkIQ-Calls total**).

## Testmethodik (produktionsäquivalente Isolation)
1. **Isolierte Kind-Instanz** aus gepatchtem `server.js` (`_audit9-server.mjs`, im Repo-Dir wegen `./brain`-Imports), **Port 3151** (>3100), `AGENT_ZERO_SCAN_ENGINE=agency`, version 5.0.0, Build `3419a34`. Fünf Env-Patches: `AZ_AUDIT_TASKS_FILE`/`AZ_AUDIT_JOBS_FILE`/`AZ_AUDIT_LOCK_FILE` (isolierte Kopien im Session-Ordner + eigener `.agent-zero.audit9.lock`), `AZ_AUDIT_NO_DETECT=1` (→ `detectExistingInstance()` liefert `null`), `AZ_AUDIT_NO_REAPER=1` (→ `reapOrphanedSessions()` früher Return, schützt fremde node-Kinder vor dem pfadbasierten Reaper). `buildAgencyEnv` strippt `AGENCY_SESSION_ID`/`COPILOT_AGENT_SESSION_ID` (built-in). Die echte `tasks.json` wurde vom Kind **nie geöffnet**: SHA-256 vor **und** nach identisch `BB9CE3D4…C2CF6A4`.
2. **Exakter Chat-Auftrag** per Chat-API an den Seestrasse-Projekt-Task: `POST /api/tasks/proj-seestrasse-356/log` mit `{"text":"Suche in der Inbox nach Updates und aktualisiere die PM-View-Felder."}` (POST 13:40:02.339Z) → Fast-Job `9577bae0` → deep_verify `8ad20556`.
3. **Warm-Vorlauf:** Vor der Primär-Query ein Trivial-Call „Summarize this task in two sentences." (Fast-Job `54b67126`), um die agency-Runtime zu wärmen; sein Deep-Job (`81ae1216`) wurde per API storniert und sein agency-Kind (PID) **vor** jeglichem Marker-Apply per **expliziter PID** beendet. Isolierter State nach Warm-up = Baseline (reviewQueue 78, ledger 19, AV Go-Live unverändert `unconfirmed`).
4. **Zwei-Stufen-Verlauf:** Stufe 1 (`mcpMode:'none'`, state-only, `intent:answer`) → Stufe 2 deep_verify `8ad20556` (entfesselt, `mcpMode:'default'`, alle Default-MCPs) → **Antwort gepostet vor Marker-Apply** → asynchroner Reality-Gateway-Marker-Apply (xhigh) → **granulare Gates** → `markersApplied 4 / held 0`. Der Primär-Deep lief **ununterbrochen** bis zum vollständigen Marker-Apply (Discovery-Kind + Gateway-Apply-Kind), ohne konkurrierende Fremd-Deep-Jobs.
5. **Transparenz (Erst-Lauf verworfen):** Ein erster Primärlauf wurde **nicht** gewertet, weil eine dazwischen abgesetzte Warm-Nachmessung während des Primär-Deep-Fensters die 1-fach-agency-Semaphore staute → der Primär-Apply blieb `scheduled`, während die Nachmessung selbst die Obsolet-Buchung auslöste (keine saubere Attribution). Deshalb: isolierten State **auf Baseline zurückgesetzt** (Re-Copy der echten `tasks.json`, SHA `BB9CE3D4…`), Kind neu gestartet, Primärlauf **ohne** jede konkurrierende Query bis zum Ende gefahren. Die hier berichteten Zahlen stammen ausschließlich aus diesem sauberen Lauf (deep `8ad20556`, Kind-PID 36276).

## Audit-Hygiene / Sicherheit
- **Keine** STOP/START-Skripte. **Keine** breiten/namensbasierten Prozess-Kills (`taskkill` nicht verwendet; ausschließlich `Stop-Process -Id <PID>`).
- Nur die **eigenen** Prozesse per expliziter PID beendet: Kind-Server (PID 34980 Erst-Lauf, 36276 Wert-Lauf), die eigenen Warm-up-/verworfenen agency-Streu-Kinder (11704, 34184) sowie beim Teardown verbliebene eigene Kinder. Die legitimen Primär-Deep-agency-Kinder (Discovery + Gateway-xhigh) **beendeten sich selbst**.
- **Nicht angetastet:** die **Task-Zero**-Instanz `node server.js` (PID **10704**, `E:\Task_Zero 03`), die `:3000`-Lockfile-PID (stale, unverändert), die **echte `tasks.json`** (nie geöffnet; SHA-256 vor/nach identisch `BB9CE3D4…C2CF6A4`), die echte `jobs.json`, sowie **fremde** `agency.exe`-Prozesse (u. a. 24424, 36840, 36748 — Copilot-CLI/andere Projekte, andere Parents) und die fremden Copilot-CLI-WorkIQ-/Playwright-node-Kinder.
- **Rückstandsfrei entfernt:** `_audit9-server.mjs`, alle 10 brain-work-Run-Dirs beider Läufe (task-chat-fast/deep-*), die isolierten Session-Kopien + `.agent-zero.audit9.lock` + Logs. Die vorbestehenden (fremden) brain-work-Run-Dirs vom 07.07. blieben unangetastet.
- `git status` sauber (nur die zwei Docs AUDIT-BATCH-9.md, STATE.md geändert); `npm test` grün (**153/153**).
