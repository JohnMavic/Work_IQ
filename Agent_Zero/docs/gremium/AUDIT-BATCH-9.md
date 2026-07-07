AUDIT9: FAIL a,d

# Batch 9 „ENTFESSELUNG" — Abnahme-Audit (Direktvergleich, Brief §5)

**Datum:** 2026-07-07 · **Branch:** `feature/agency-brain` (HEAD `7fb904d`) · **Auditor:** GitHub Copilot CLI (isolierte Kind-Instanz)

## Verdikt
**AUDIT9: FAIL a,d** — Zwei der vier Erfolgskriterien aus Brief §5 sind nicht erfüllt:
- **(a) FAIL** — Die entfesselte Stufe 2 **fand** das Kommunikationspaket von Laith Skeik vom 6. Jul (Thread „Confirmation: Temporary Workspace Setup at Seestrasse", 06.07. 18:45) und erntete den **½-Tag-Vorbehalt Nicolas** korrekt frisch. Aber sie **öffnete den PDF-/Deck-Anhang nicht** und erntete dessen Fakten nicht: **PIS 31. Aug** und **24-Port-Panel-Mitigation** sind im gesamten Task-State **nirgends vorhanden** (0 Treffer). Der Agent verwies auf „an August office-closure communication **deck**" (= den Anhang), las ihn aber nicht — genau das „Nicht-Nutzen verfügbarer Quellen (inkl. Anhängen)", das Batch 9 §1/§3 als **Mangel** definiert.
- **(d) FAIL** — Der **veraltete AV-Go-Live 1. Jul 2026** (6 Tage verstrichen) wurde **nicht erkannt und nicht bereinigt**: er steht unverändert in `pmStatus.planned` als `state:"unconfirmed"` (`"AV Go-Live target 1 Jul 2026 for commissioned rooms"`) und in `lineItems[li-see-av-commissioning].currentState` („…sign-off requested toward a 1 Jul 2026 go-live."). Die Stufe-2-Antwort erwähnt ihn mit keinem Wort.

Erfüllt:
- **(c) PASS** — Stufe-1-Antwort in **31,8 s** (< 90 s).
- **(b) PASS** — Update-Disziplin sauber: Gateway (xhigh) prüfte und **genehmigte 7/7** Marker (held 0, dropped 0), es wurden **nur die wirklich geänderten Knoten** angefasst (2 lineItems + pmStatus mit 7-Jul-Fakten), die 6 unveränderten offenen Punkte blieben unberührt, und das DLP-verdeckte Netz-Wartungs-Approval-Signal wurde **als Review geroutet statt als State behauptet**.

Das ist kein katastrophaler Fehlschlag — die Entfesselung wirkt teilweise (frische Live-Evidenz geerntet, Disziplin intakt, Latenz gehalten). Aber die zwei ausdrücklichen Kern-Ansprüche von Batch 9 (Pflicht-Anhang-Evidenz + Stale-Bereinigung) sind an diesem Lauf nicht eingelöst.

## Bewertungsmassstab (bekannte Wahrheit aus Brief §5a)
Das Jul-6-Paket von Laith Skeik soll — inkl. PDF-Anhang — diese Fakten tragen:
1. Büro-Schließung 17.–28. Aug
2. AV-Räume ab 14. Aug gesperrt
3. **PIS 31. Aug**
4. Temp-Workspace formal bestätigt
5. **24-Port-Panel-Mitigation**
6. ½-Tag-Vorbehalt Nicolas

Faktenlage nach dem Lauf (isolierte Kopie, Seestrasse-Subtree):
| Fakt | Im Wahrheitsbaum? | Diesen Lauf geerntet? | Quelle |
|---|---|---|---|
| 1 Büro-Schließung 17.–28. Aug | ✅ vorbestehend (mehrere Knoten) | refiniert | Projektstand |
| 2 AV-Räume ab 14. Aug gesperrt | ✅ vorbestehend (keyFact 06.07., `state:unconfirmed`) | nein | Projektstand |
| 3 **PIS 31. Aug** | ❌ **fehlt komplett** (0 Treffer) | **nein** | — |
| 4 Temp-Workspace formal bestätigt | ✅ vorbestehend („Confirmed 6 Jul 2026") | bestärkt (state→confirmed) | Projektstand |
| 5 **24-Port-Panel-Mitigation** | ❌ **fehlt komplett** (0 Treffer) | **nein** | — |
| 6 ½-Tag-Vorbehalt Nicolas | ❌ war neu | ✅ **frisch geerntet** | Outlook (live) |

→ Genau die beiden **anhang-exklusiven** Fakten (3, 5) blieben unerreicht — konsistent damit, dass der PDF-Anhang nicht geöffnet wurde.

## Testmethodik (produktionsäquivalente Isolation)
1. **Isolierte Kind-Instanz** aus gepatchtem `server.js` (`_audit9-server.mjs`, im Repo-Dir wegen `./brain`-Imports), **Port 3119** (>3100), `AGENT_ZERO_SCAN_ENGINE=agency`, **PID 44400**, cmdline `"…node.exe" _audit9-server.mjs` (eindeutig). Session-Vars `AGENCY_SESSION_ID`/`COPILOT_AGENT_SESSION_ID` aus der Kind-Env entfernt (zusätzlich strippt `buildAgencyEnv` sie für den Agency-Subprozess).
   - `detectExistingInstance()` → `null` per `AZ_AUDIT_NO_DETECT` (sonst hätte der Port-Scan die Nutzer-Instanz :3000 gefunden und die Kind-Instanz beendet).
   - `reapOrphanedSessions()` → früher Return per `AZ_AUDIT_NO_REAPER` (schützt die :3000-Agency-Subprozesse vor dem pfadbasierten Startup-/Shutdown-Reaper).
   - `LOCK_FILE` → eigener `.agent-zero.audit9.lock` (echter Lock unberührt).
   - `TASKS_FILE`/`JOBS_FILE` → **isolierte Kopien** (`…\files\audit9\tasks.json` / `jobs.json`). Die echte `tasks.json` wurde vom Kind **nie geöffnet**: SHA-256 vor **und** nach identisch `4F99EB3E…34CB9F9`.
2. **Exakter Chat-Auftrag** per Chat-API an den Seestrasse-Projekt-Task:
   `POST /api/tasks/proj-seestrasse-356/log` mit `{"text":"Suche in der Inbox nach Updates und aktualisiere die PM-View-Felder."}` → Log-Job `7ef6f365`.
3. **Zwei-Stufen-Verlauf:** Stufe 1 (fast, `mcpMode:'none'`, state-only) → Stufe 2 (deep_verify `3552d835`, entfesselt `mcpMode:'default'`, alle Default-MCPs, 25-min-Fenster) → asynchroner Reality-Gateway-Marker-Apply (xhigh).

## Zeiten (Belege)
| Phase | Start | Ende | Dauer | Schwelle | Verdikt |
|---|---|---|---|---|---|
| POST → Stufe-1-Antwort | 15:27:37.880 | 15:28:09.72 | **31,8 s** (brain `durationMs=31524`) | < 90 s MUSS | ✅ |
| Stufe-2 deep_verify | 15:28:09.72 | 15:38:45.74 | **636,0 s ≈ 10,6 min** (`durationMs=635993`) | ≤ 25 min | ✅ (Fenster) |
| Gateway-Marker-Apply (async) | nach Antwort | ~ +30 s | `markerProcessingStatus: completed` | — | — |

Kein Tool-Budget-Ereignis: weder die 40-Call-Warnung noch der 150-Call-Notstopp feuerten (kein Loop).
Stufe-1-Methode = `agency-task-chat-fast-fallback-v1` (deterministischer State-only-Fallback; liefert korrekte Antwort + queued Stufe 2; **non-blocking**, bekannter Pfad aus AUDIT-TT).

## Stufe-1-Antwort (Beleg, verbatim, gekürzt)
> Current project state: Microsoft Seestrasse 356 … in active execution … (from project state, last verified 2026-07-07T11:16:19.242Z).
> User actions: none recorded … Waiting on: Patch panel … CorpNet patching … SupplierWeb … Risks: Patch panel lead time 6-11 weeks threatens the August cabling schedule …
> Fact Sheet signals: The old Laith Skeik site-walk response action was removed as obsolete … The AV decommission asset-list action was removed as resolved by Patrick Harris on 9 June 2026 …
> **Deep verification against Microsoft 365 started — I will update this conversation.**

## Stufe-2-Antwort (Beleg, verbatim, gekürzt)
> Deep verification complete. … **one genuinely new, evidenced update since the 6 Jul cursor; all other open items are unchanged.**
> **New (verified in Microsoft 365 / Outlook):**
> - **August timeline & PC relocation** — In the thread „Confirmation: Temporary Workspace Setup at Seestrasse," Laith Skeik (06 Jul 2026 18:45) prepared an August office-closure communication **deck** with a timeline; **Nicolas Ottomüller estimates half a day** to prepare room data/power on **17 Aug 2026** and the other half to physically move the PCs (with a buffer …), and Laith is **awaiting Nicolas' confirmation that half a day suffices** — verified in Outlook. Belinda Schott (Sodexo, 07 Jul 2026 14:48 …) is **holding the employee communication until Laith confirms the timeline is validated by all vendors** — verified in Outlook. The request is addressed to Laith, so **no direct action falls to Martin** — verified in Outlook.
> - **Signal only — unverified:** an automated „Action Required: Approve network maintenance activity" (07 Jul 08:45) requests approval for a ZURICH-SEE Aruba POE-AGG code upgrade on 22 Jul 2026; deeper detail was DLP-restricted … flagged for review, not asserted as task state.
> **Unchanged (checked, no newer evidence):** CorpNet patching conflict (unresolvable — newest 17 Jun, later Teams „Expired") · SupplierWeb/invoice 101616080 (no email after 5 Jul) · Patch panel (no email after 5 Jul) · Dust closure (no email after 3 Jul) · Focus-rooms PO/touchpanel (no email after 5 Jul).

→ Der **„deck"** (PDF-Anhang) wird benannt, aber **nicht geöffnet/gelesen**; die anhang-exklusiven Fakten PIS 31. Aug und 24-Port-Panel-Mitigation tauchen nicht auf. Der **AV-Go-Live 1. Jul** wird nicht angesprochen.

## PM-View-Delta (isolierte Kopie, Vorher→Nachher)
7 Marker vom Gateway **approved & angewandt** (applied 7 / held 0 / dropped 0). Knoten-Zählungen unverändert (userActions 0→0, lineItems 10→10, factSheet.openActions 0→0 — alle Änderungen sind Content-Updates bestehender Knoten):

**Geändert (wirklich neue 7-Jul-Fakten):**
- `lineItems[li-see-pc-relocation].currentState` += „On 7 Jul 2026 … Nicolas Ottomueller estimates half a day to prepare room data/power on 17 Aug 2026 …; Laith Skeik is awaiting Nicolas' confirmation that half a day is sufficient." · `state: unconfirmed→confirmed` · `lastConfirmedByMessageDate: null→2026-07-07`
- `lineItems[li-see-aug-works].currentState` += „On 7 Jul 2026 Laith prepared an August office-closure communication deck …; Sodexo (Belinda Schott) is holding the employee communication until Laith confirms the timeline is validated by all vendors." · `state: unconfirmed→confirmed` · `lastConfirmedByMessageDate: null→2026-07-07`
- `pmStatus.current` neu synthetisiert (CorpNet-Konflikt „stays under review", SupplierWeb/Dust weiter offen).
- `pmStatus.planned` += 1 (`confirmed`, „Room data/power preparation and PC relocation planned for 17 Aug 2026 (half-day prep estimate …)").
- `pmStatus.waitingOn` += 1 (`confirmed`).
- `pmStatus.lastSynthesizedAt` 2026-07-06→2026-07-07.
- `sourceRefs` 34→35 · Root-`reviewQueue` 77→78 (DLP-Netzwartungs-Signal, **nicht** als State behauptet) · `history` 6→7.

**Korrekt unverändert gelassen:** li-see-cabling, li-see-av-commissioning, li-see-corpnet, li-see-focusrooms, li-see-supplier-access, li-see-decom-validation, li-see-planning, li-see-contamination.

**Nicht bereinigt (Kriterium d):** `pmStatus.planned` → `"AV Go-Live target 1 Jul 2026 for commissioned rooms"` bleibt `state:"unconfirmed"`, `lastConfirmedByMessageDate:null`; `li-see-av-commissioning.currentState` behält „…toward a 1 Jul 2026 go-live." (3 Treffer „1 Jul 2026 go" nach dem Lauf, unverändert).

## Bewertung je Kriterium
| # | Kriterium | Verdikt | Beleg |
|---|---|---|---|
| a | Findet Jul-6-Paket **inkl. PDF-Anhang** und erntet dessen Fakten | ❌ **FAIL** | Thread + „deck" gefunden, ½-Tag-Vorbehalt frisch geerntet; aber Anhang **nicht geöffnet** → PIS 31. Aug (0 Treffer) und 24-Port-Panel-Mitigation (0 Treffer) fehlen im gesamten State. |
| b | Aktualisiert nur wirklich geänderte Knoten (Gateway zeigt Abklärung) | ✅ **PASS** | Gateway approved 7/7, held 0, dropped 0; nur 2 lineItems + pmStatus (7-Jul) geändert, 6 offene Punkte unberührt; DLP-Signal → reviewQueue statt State. |
| c | Stufe-1-Antwort < 90 s | ✅ **PASS** | 31,8 s (brain 31,524 s). |
| d | Veraltete Einträge (AV-Go-Live 1. Jul) erkannt & bereinigt/überholt | ❌ **FAIL** | AV-Go-Live 1. Jul unverändert in `pmStatus.planned` (`unconfirmed`) + li-see-av-commissioning; in der Stufe-2-Antwort nicht erwähnt. |

## Root-Cause / Empfehlung (non-blocking)
Beide Fehlschläge teilen dieselbe Wurzel: die Entfesselung gibt dem Brain Anhang-Lese- und Voll-MCP-Rechte, aber **dieser Lauf** (1) lud/las den PDF-/Deck-Anhang nicht (nur die Trägermail), und (2) reconciled den verstrichenen AV-Go-Live 1. Jul nicht proaktiv als stale. Der Reality-Gateway — der laut Batch 9 §3 zusätzlich prüfen soll „Wurde verfügbare Evidenz (inkl. Anhängen) genutzt statt ignoriert?" — genehmigte die 7 Marker, **ohne** den ungelesenen Anhang oder den stale Go-Live zu bemängeln. Empfehlung: (i) Deep-Prompt: Anhang-Download/-Read bei erkanntem „deck/PDF/Attachment" **erzwingen** (Pflicht-Evidenz), (ii) Gateway-Check „Anhang genutzt?" schärfen, sodass ein referenzierter, aber ungelesener Anhang zum Hold/Nachfassen führt, (iii) Stale-Reconciliation verstrichener datierter `planned`-Einträge in die Stufe-2-Pflichtliste aufnehmen.

## Parallele Session (Direktvergleich-Kontext, nicht-blockierend)
Während dieses Audits lief eine **separate, eigenständig user-gestartete agency-Executor-Session** mit **exakt diesem Batch-9-Abnahme-Auftrag** (agency `copilot -p "Gremium-Abnahme Batch 9 ENTFESSELUNG…"`, `claude-opus-4.8`/`--effort xhigh`, via bash-Wrapper `git add -A && git commit … && agency copilot …`, PID **29188**, Start 15:17:18, plus bash-Wrapper 52576/57004/3612). Analog zum 8B-Direktvergleich chattet dieser Executor gegen die **Nutzer-Instanz :3000** und die **echte** `tasks.json`, während meine Kind-Instanz auf der **isolierten Kopie** (:3119) arbeitete — dadurch **null Kreuz-Kontamination** meiner Messungen. Ich habe diese fremde Session **nicht** angefasst (Regel „laufende Instanzen/fremde Sessions nicht anfassen"); sie kann diese zwei Docs später aus eigener Sicht überschreiben und/oder committen — das ist ihre Aktion, nicht meine. Mein Deliverable ist der aktuelle On-Disk-Stand dieser Session.

## Audit-Hygiene / Sicherheit
- **Keine** STOP/START-Skripte. **Keine** breiten/namensbasierten Prozess-Kills.
- Nur die **eigene** Kind-PID **44400** per expliziter PID beendet (nach cmdline-Bestätigung `node _audit9-server.mjs`).
- **Nicht angetastet:** Nutzer-Instanz **:3000** (PID **21644**, agency, uptime durchgehend), deren Subprozesse, `.agent-zero.lock`, die **echte `tasks.json`** (nie geöffnet — Kopie genutzt; SHA-256 vor/nach identisch `4F99EB3E…34CB9F9`), `jobs.json`.
- **Rückstandsfrei entfernt:** `_audit9-server.mjs` und der Temp-Harness (`…\files\audit9\`, `.agent-zero.audit9.lock`, Snapshots). `npm test` Baseline vor dem Lauf **142/142** grün. Git-Änderung nur an den zwei Docs (AUDIT-BATCH-9.md, STATE.md).
