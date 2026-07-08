AUDIT9: FAIL a,d

# Batch 9 „ENTFESSELUNG" — Re-Audit nach 9B/9C/9D (Direktvergleich, Brief §5)

**Datum:** 2026-07-08 · **Branch:** `feature/agency-brain` (HEAD `bb1f535`, nach 9B/9C/9D) · **Auditor:** GitHub Copilot CLI (isolierte Kind-Instanz)

## Verdikt
**AUDIT9: FAIL a,d** — Zwei der vier Erfolgskriterien aus Brief §5 sind (wie im Erst-Audit) nicht erfüllt. Die 9B/9C/9D-Fixes haben die **Fähigkeit** ergänzt (WorkIQ-Attachment-Index-Regel im Deep-Prompt, Temporal-Pass-Gate), aber im **Chat-Deep-Verify-Pfad**, den §5 fährt, greift beides an diesem Lauf nicht:

- **(a) FAIL** — Die entfesselte Stufe 2 (5 echte WorkIQ-Inbox-Discovery-Calls, `mcpMode:'default'`) **fand** den Laith-Skeik/Belinda-Thread („Confirmation: Temporary Workspace Setup at Seestrasse") und erntete **frisch** den **½-Tag-Vorbehalt Nicolas** (waitingOn). Sie **öffnete den PDF-Anhang „Microsoft Seestrasse - August Works.pdf" aber nicht** und stellte **keine gezielte WorkIQ-Anhang-Abfrage**: **PIS 31. Aug** (0 Treffer), **Scope-Liste** (Cable room optimisation / AV life cycle renewal = 0 Treffer) und **24-Port-Panel-Mitigation** (0 Treffer) fehlen im gesamten Task-State. Es gibt **keinen** Ledger-Eintrag `attachmentsHandled='yes(workiq-index)'` (String `workiq-index` = 0× im ganzen File; das Ledger blieb bei 19 Einträgen, alle datiert 06.07., dieser Lauf schrieb **keinen**). Die Antwort **benennt** „the deck" (= den Anhang), **las ihn aber nicht** — exakt das „Nicht-Nutzen verfügbarer Quellen inkl. Anhängen = Mangel" aus Batch 9 §1/§3, und dieselbe Fehlerlage wie im Erst-Audit.
- **(d) FAIL** — Der **veraltete AV-Go-Live 1. Jul 2026** (7 Tage verstrichen) wurde **nicht erkannt und nicht bereinigt**: er steht unverändert in `pmStatus.planned` als `state:"unconfirmed"` (`"AV Go-Live target 1 Jul 2026 for commissioned rooms"`, kein `obsoleteReason`) und in `lineItems[li-see-av-commissioning].currentState` („…sign-off requested toward a 1 Jul 2026 go-live.", `state:unconfirmed`). Die Stufe-2-Antwort erwähnt ihn mit keinem Wort.

Erfüllt:
- **(c) PASS** — Stufe-1-Antwort in **28,1 s** (brain `durationMs=27769` ≈ 27,8 s) < 90 s.
- **(b) PASS** — Update-Disziplin sauber: Reality-Gateway (xhigh) **approved 6 / held 1**; angewandt 5, 2 no-op verworfen. Der **1 gehaltene** Marker war ein `PROJECT_UPDATE`, der „completion claims while waitingOn is still populated" (korrekt gehalten → reviewQueue +1). Nur wirklich geänderte Knoten angefasst; das DLP-/automatische Netzwartungs-Signal (ZURICH-SEE Aruba POE-AGG, 22. Jul) wurde **als Review geroutet statt als State behauptet**; `li-see-corpnet` blieb unverändert als NEEDS_REVIEW; die 6 unveränderten offenen Punkte unberührt.

Kein katastrophaler Fehlschlag — die Entfesselung wirkt (5 WorkIQ-Calls, echte Inbox-Discovery, frische Live-Evidenz, Disziplin intakt, Latenz gehalten). Aber die zwei ausdrücklichen Kern-Ansprüche von Batch 9 (Pflicht-Anhang-Evidenz + Stale-Bereinigung) sind an diesem Lauf **erneut nicht** eingelöst.

## Bewertungsmassstab (bekannte Wahrheit aus Brief §5a; 9D-Anhang-Beweis)
Das Jul-6-Paket von Laith Skeik trägt — inkl. PDF-Anhang „Microsoft Seestrasse - August Works.pdf" (per 9D-Proof über den M365-Copilot-Index nachweisbar) — u. a.: PIS **31. Aug**; Scope **Full office recabling / Cable room optimisation / Security System renewal / AV life cycle renewal**; Büro-Schließung 17.–28. Aug; AV-Räume ab 14. Aug; Temp-Workspace bestätigt; ½-Tag-Vorbehalt Nicolas.

Faktenlage nach dem Lauf (isolierte Kopie, Seestrasse-Subtree; Treffer im gesamten Task-State):
| Fakt | Baseline (Kopie) | Diesen Lauf geerntet? | Quelle |
|---|---|---|---|
| Büro-Schließung 17.–28. Aug | ✅ vorbestehend | refiniert | Projektstand |
| AV-Räume ab 14. Aug | ✅ vorbestehend | nein | Projektstand |
| Temp-Workspace bestätigt (6 Jul) | ✅ vorbestehend | bestärkt | Projektstand |
| ½-Tag-Vorbehalt Nicolas | ❌ war neu (0) | ✅ **frisch geerntet** | Outlook (live) |
| **PIS 31. Aug** | ❌ fehlt (0) | **nein** | (Anhang, ungelesen) |
| **Scope-Liste (Cable room optim / AV life cycle)** | ❌ fehlt (0) | **nein** | (Anhang, ungelesen) |
| **24-Port-Panel-Mitigation** | ❌ fehlt (0) | **nein** | (Anhang, ungelesen) |

→ Genau die drei **anhang-exklusiven** Fakten blieben unerreicht — konsistent damit, dass keine gezielte WorkIQ-Anhang-Abfrage lief.

## Testmethodik (produktionsäquivalente Isolation)
1. **Isolierte Kind-Instanz** aus gepatchtem `server.js` (`_audit9-server.mjs`, im Repo-Dir wegen `./brain`-Imports), **Port 3131** (>3100), `AGENT_ZERO_SCAN_ENGINE=agency`, **PID 56932**, cmdline `"…node.exe" _audit9-server.mjs` (eindeutig), build `bb1f535`. Fünf Env-Patches: `AZ_AUDIT_TASKS_FILE`/`AZ_AUDIT_JOBS_FILE`/`AZ_AUDIT_LOCK_FILE` (isolierte Kopien + eigener `.agent-zero.audit9.lock`), `AZ_AUDIT_NO_DETECT=1` (→ `detectExistingInstance()` liefert `null`, sonst hätte der Port-Scan die Nutzer-Instanz :3000 beendet), `AZ_AUDIT_NO_REAPER=1` (→ `reapOrphanedSessions()` früher Return, schützt die :3000-Subprozesse vor dem pfadbasierten Startup-/Shutdown-Reaper). Session-Vars `AGENCY_SESSION_ID`/`COPILOT_AGENT_SESSION_ID` waren nicht gesetzt (zusätzlich strippt `buildAgencyEnv` sie).
   - `TASKS_FILE`/`JOBS_FILE` → **isolierte Kopien** (`…\files\audit9\tasks.json` / `jobs.json`). Die echte `tasks.json` wurde vom Kind **nie geöffnet**: SHA-256 vor **und** nach identisch `BB9CE3D4…C2CF6A4`; die isolierte Kopie änderte sich (`BB9CE3D4…` → `E067A6E2…`) — der Schreibpfad lief also ausschliesslich auf der Kopie.
2. **Exakter Chat-Auftrag** per Chat-API an den Seestrasse-Projekt-Task:
   `POST /api/tasks/proj-seestrasse-356/log` mit `{"text":"Suche in der Inbox nach Updates und aktualisiere die PM-View-Felder."}` → Fast-Log-Job `f2ead96c` (POST 2026-07-08T06:28:11.676Z).
3. **Zwei-Stufen-Verlauf** über SSE `/api/events` (server-`ts`-gestempelt): Stufe 1 (`mcpMode:'none'`, state-only) → Stufe 2 deep_verify `7016c8b7` (entfesselt, `mcpMode:'default'`, alle Default-MCPs, 25-min-Fenster) → asynchroner Reality-Gateway-Marker-Apply (xhigh).

## Bewertung je Kriterium
| # | Kriterium | Verdikt | Beleg |
|---|---|---|---|
| a | Jul-6-Paket **inkl. PDF-Anhang** — PIS 31. Aug + Scope-Liste via gezielter WorkIQ-Anhang-Abfrage, Ledger `attachmentsHandled='yes(workiq-index)'` | ❌ **FAIL** | Thread + „deck" gefunden, ½-Tag frisch geerntet; aber **keine** Anhang-Abfrage → PIS 31. Aug / Scope / 24-Port = **0 Treffer**; **kein** Ledger-Eintrag dieses Laufs (19/19 vom 06.07.), `workiq-index` 0× im File. |
| b | Nur wirklich geänderte Knoten (Gateway zeigt Abklärung) | ✅ **PASS** | Gateway approved 6 / held 1 (Completion-Overclaim korrekt gehalten → reviewQueue +1), 5 applied / 2 no-op-dropped; Netzwartungs-Signal → Review statt State; CorpNet unverändert (NEEDS_REVIEW); 6 offene Punkte unberührt. |
| c | Stufe-1-Antwort < 90 s | ✅ **PASS** | 28,1 s (brain 27,8 s, `agency-task-chat-fast-fallback-v1`, state-only). |
| d | Veralteter AV-Go-Live 1. Jul erkannt & bereinigt/überholt | ❌ **FAIL** | Unverändert in `pmStatus.planned` (`unconfirmed`, kein `obsoleteReason`) + `li-see-av-commissioning` („…1 Jul 2026 go-live"); in Stufe 2 nicht erwähnt. |

## Stufe-2-Antwort (Beleg, verbatim, gekürzt)
> **Deep verification complete.** I searched the Outlook inbox and Teams for updates since the cursor date (2026-07-06T16:54Z, 14-day lookback) …
> 1. **August timeline confirmation is now pending before employee comms** — verified in Outlook: Belinda Schott (07 Jul 2026 14:48, thread „RE: Confirmation: Temporary Workspace Setup at Seestrasse") asked Laith to confirm the 17–28 Aug timeline … Laith „is waiting on final confirmation from Nicolas if half a day is sufficient" … updated `li-see-pc-relocation`.
> 2. **Network-maintenance approval at ZURICH-SEE (signal only — unverified …)** — automated MINT/NCU notification … 22 Jul 2026 … raised for review rather than asserted.
> 3. **SharePoint has no execution-planning docs (signal).**
> **CorpNet conflict — still unverified via system of record** … kept `li-see-corpnet` unchanged … NEEDS_REVIEW.

→ Der **„deck" (PDF-Anhang)** wird benannt, aber **nicht geöffnet/gelesen**; PIS 31. Aug und 24-Port-Panel tauchen nicht auf. Der **AV-Go-Live 1. Jul** wird nicht angesprochen.

## Root-Cause (Befund, non-blocking — Audit ändert keinen Produktcode)
1. **(a):** Der Deep-Verify-Prompt (`brain/task-chat.js:594`) instruiert „targeted WorkIQ attachment-content questions … mark attachment ledger items yes(workiq-index)". Der Agent **wählte** an diesem Lauf trotzdem **keine** Anhang-Abfrage (nur Träger-Mails/Bodies), und der **Chat-Deep-Verify-Pfad erzeugt ohnehin keine `processing.ledger`-Dispositionen** (dort lebt `attachmentsHandled`) — das 9C/9D-Ledger-Artefakt wurde in einem **Scan-**Kontext (9D-runBrain-Harness) belegt, nicht im Chat-Pfad, den §5 fährt.
2. **(d):** Das Temporal-Pass-Gate (`brain/temporal-pass.js`, `evaluateTemporalPassGate`) ist **nur in `brain/scan-brain.js:359`** verdrahtet, **nicht** im Chat-Deep-Verify-Pfad (`task-chat.js`). Im Chat-Pfad gibt es also **keine erzwungene Stale-Date-Reconciliation**, und der Brain reconcilte den verstrichenen 1-Jul-Go-Live nicht von sich aus.

Empfehlung (nicht Teil dieses Audits): (i) im Chat-Deep-Verify eine Anhang-Abfrage bei erkanntem „deck/PDF/Attachment" **erzwingen** + eine Ledger-/Nachweis-Disposition auch im Chat-Pfad führen; (ii) `evaluateTemporalPassGate` (oder eine Pflicht-Reconciliation verstrichener datierter `planned`-Einträge) auch in den Chat-Deep-Verify-Pfad einhängen.

## Timing-Baseline
Einzige Query dieses Audits: „Suche in der Inbox nach Updates und aktualisiere die PM-View-Felder." (POST `2026-07-08T06:28:11.676Z`). Alle Rel-Werte gegen POST; Server-`ts` aus SSE.

**Antwortzeiten (Absetzen → …):**
| Meilenstein | Rel-POST | Beleg |
|---|---|---|
| Stufe-1-Antwort (fast job.completed) | **28,1 s** | brain `durationMs=27769` ≈ 27,8 s |
| Stufe-2-Nachtrag (deep answer_posted) | **518,3 s ≈ 8,64 min** | deep brain-elapsed ≈ 488 s; < 25-min-Cap |
| Stufe-2-Marker angewandt (gateway apply done) | **776,7 s ≈ 12,94 min** | `markerProcessedAt` 06:41:08.328 |

**Phasen-Zerlegung:**
| Phase | Fenster (rel POST) | Dauer |
|---|---|---|
| Queue (POST → job.started, fast) | 0,0 → 0,3 s | 0,3 s |
| Stufe-1 Brain (state-only, `mcp=none`, fallback) | 0,3 → 28,1 s | 27,8 s |
| Deep-Enqueue (fast done → deep started) | 28,1 → 28,1 s | ~0 s |
| Stufe-2 Spawn + MCP-Startup (deep brain_run → 1. Status) | 28,2 → 56,0 s | ~27,8 s |
| Stufe-2 Brain Discovery + Reasoning (5 WorkIQ) | 56,0 → 518,3 s | ~462 s |
| Stufe-2 Antwort gepostet | 518,3 s | — |
| Gateway (xhigh) + Marker-Apply | 518,3 → 776,7 s | 258,4 s (4,3 min) |
| **Total POST → Apply-Done** | | **776,7 s (12,94 min)** |

**WorkIQ-Einzelabfrage-Zeiten** (Tool-*Start*-Offsets; der Runner streamt nur `tool.execution_start`, nicht das Ende — Einzel-*Dauern* sind daher nicht direkt messbar):
| WorkIQ # | Brain-elapsed bei Start | Abstand zum Vorgänger |
|---|---|---|
| 1 | 133,9 s | ~28 s Startup + ~106 s erste Runde |
| 2 | 174,1 s | 40,2 s |
| 3 | 174,1 s | 0,0 s (gebündelt mit #2) |
| 4 | 251,0 s | 76,9 s (inkl. Reasoning-Lücke) |
| 5 | 251,0 s | 0,0 s (gebündelt mit #4) |
| (Compose) | 251,0 → 488 s | ~237 s für finale(n) Call(s) + Body-Reads + Antwort |

Kein Tool-Budget-Ereignis: weder die 40-Call-Warnung noch der 150-Call-Notstopp feuerten (5 WorkIQ-Calls total). Stufe-1-Methode `agency-task-chat-fast-fallback-v1` (deterministischer State-only-Fallback; liefert korrekte Antwort + queued Stufe 2, non-blocking).

## Audit-Hygiene / Sicherheit
- **Keine** STOP/START-Skripte. **Keine** breiten/namensbasierten Prozess-Kills.
- Nur die **eigenen** Prozesse per expliziter PID beendet: Kind-Server **56932** (`node _audit9-server.mjs`) und SSE-Recorder **57912**; keine Agency-Kinder übrig (Deep-Run sauber beendet).
- **Nicht angetastet:** Nutzer-Instanz **:3000** (PID **21644**, agency, uptime durchgehend 71 172 s → 72 515 s), deren Subprozesse, `.agent-zero.lock` (Owner 21644 unverändert), die **echte `tasks.json`** (nie geöffnet; SHA-256 vor/nach identisch `BB9CE3D4…C2CF6A4`), `jobs.json`.
- **Rückstandsfrei entfernt:** `_audit9-server.mjs`, die zwei `brain-work/runs/`-Run-Dirs dieses Laufs, `.agent-zero.audit9.lock`. `git status` sauber; `npm test` **146/146** grün. Git-Änderung nur an den zwei Docs (AUDIT-BATCH-9.md, STATE.md).
