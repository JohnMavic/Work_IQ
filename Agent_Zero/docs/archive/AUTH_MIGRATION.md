# AUTH_MIGRATION.md — Von workiq Binary zu MSAL Node.js mit NativeBrokerPlugin

> ⚠️ **ARCHIVED — Diese Implementierung wurde verworfen.**  
> Das MSAL-Experiment wurde nicht in Produktion übernommen. Agent Zero verwendet weiterhin die `@microsoft/workiq` Binary als M365-Backend. Diese Datei ist historische Dokumentation eines abgebrochenen Experiments (April 2026).

> **Datum:** 8. April 2026  
> **Autor:** Martin Hämmerli + GitHub Copilot  
> **Kontext:** Agent Zero v3.0 — M365 Authentication Redesign

---

## Zusammenfassung

Die `workiq` Native Binary (`@microsoft/workiq`) wurde als M365-Suchbackend ersetzt durch eine eigene Implementierung mit `@azure/msal-node` + `NativeBrokerPlugin` + Microsoft Graph Search API. Grund: die workiq Binary zeigte bei **jedem** Query den Windows Account-Picker (2× pro Aufruf), was die App unbenutzbar machte.

---

## Das Problem

### Symptom
Bei jeder M365-Suche (Scan, Update-Check, Log Work) erschien **2× der Windows Account-Picker** — ein nativer Windows-Dialog zur Microsoft-Kontowahl. Der User musste pro Query 2× seinen Account auswählen.

### Root Cause: workiq Binary Bug
Die `workiq.exe` (v0.4.0, .NET Self-Contained App) verwendet MSAL.NET mit dem **WAM Broker** (`msalruntime.dll`). Das Problem:

1. **Kein Token-Caching zwischen Tool-Calls**: Jeder `ask_work_iq` MCP-Tool-Call erstellt intern einen neuen MSAL-Auth-Context
2. **Immer `InteractiveAuthProvider`**: Die Binary versucht nie `AcquireTokenSilent` — sie geht direkt zu Interactive Auth
3. **2× Auth pro Query**: Jeder Call triggert 2 separate MSAL-Auth-Flows (vermutlich für 2 verschiedene Token/Scopes)
4. **Kein In-Memory-Cache**: Selbst im interaktiven Modus (`workiq ask`) wird der Token zwischen Fragen nicht gecacht

### Beweis (Debug-Output)
```
info: Microsoft.WorkIQ.Auth.ClientAppFactory[0]
      Configuring authentication for Windows with broker support
dbug: Microsoft.WorkIQ.Auth.InteractiveAuthProvider[0]
      Starting authentication flow
      Scopes requested: https://graph.microsoft.com/.default
      Account identifier provided: True
dbug: Microsoft.WorkIQ.Auth.AccountManager[0]
      Retrieving accounts from cache
```
→ Trotz `Account identifier provided: True` und `Retrieving accounts from cache` fällt die Binary **immer** auf Interactive Auth zurück.

---

## Lösungsansätze — Was NICHT funktioniert hat

### 1. ❌ `accept_eula` Fix
**Versuch:** Die `accept_eula` MCP-Call hatte leere Argumente `{}` statt `{ eulaUrl: '...' }`.  
**Ergebnis:** EULA war bereits akzeptiert (via CLI). Fix korrekt aber nicht die Ursache.

### 2. ❌ Auth Warmup Gate
**Versuch:** `mcpReady` erst setzen wenn ein Warmup-Query durchgeht — verhindert parallele Account-Picker.  
**Ergebnis:** Reduziert Picker von N auf 1 pro Server-Start, aber der Picker kam trotzdem bei **jedem** Folge-Query (2× pro Call).

### 3. ❌ `--tenant-id` Flag
**Versuch:** `workiq --tenant-id 72f988bf-86f1-41af-91ab-2d7cd011db47 mcp`  
**Ergebnis:** Blockiert den MCP-Init komplett. Die Binary macht MSAL-Auth **vor** dem MCP-Protokoll und antwortet nie auf `initialize`.

### 4. ❌ `msalruntime.dll` entfernen
**Versuch:** DLL umbenennen um WAM-Broker zu deaktivieren → Fallback auf Browser-Auth.  
**Ergebnis:** Binary crasht mit `Dll was not found`. Kein Fallback implementiert.

### 5. ❌ Direkte Binary-Spawn (ohne shell)
**Versuch:** `workiq.exe` direkt spawnen statt über `cmd.exe` + `workiq.js` Node-Wrapper.  
**Ergebnis:** MCP-Protokoll funktioniert nicht ohne `shell: true`.

### 6. ❌ MSAL Node.js mit Browser-Auth (PKCE)
**Versuch:** `@azure/msal-node` mit Authorization Code Flow + PKCE, öffnet Browser.  
**Ergebnis:** Blockiert durch **Token Protection** Security Policy des Microsoft-Tenants (MSIT). Fehlermeldung: *"A security policy requiring token protection is preventing this application from accessing the resource."*

### 7. ❌ MSAL Node.js mit Device Code Flow
**Versuch:** `@azure/msal-node` mit `acquireTokenByDeviceCode` — Code im Terminal anzeigen.  
**Ergebnis:** Ebenfalls durch **Token Protection** blockiert. Plus: UX-Problem — Code erscheint im Server-Terminal, nicht in der Web-UI.

---

## Lösung: MSAL Node.js mit NativeBrokerPlugin ✅

### Kernidee
`@azure/msal-node-extensions` enthält `NativeBrokerPlugin` — ein Node.js-Wrapper um die native WAM-API. Dies:
- Nutzt den **gleichen WAM-Broker** wie die workiq Binary → erfüllt Token Protection
- Aber: **wir kontrollieren das Caching** — `acquireTokenSilent` wird korrekt implementiert
- Ergebnis: **Windows Integrated Auth (Kerberos)** — Token automatisch über den Windows-Login, **ZERO Popups**

### Warum funktioniert es?
Der `NativeBrokerPlugin` nutzt die WAM-API korrekt:
1. `acquireTokenInteractive` → WAM erkennt den eingeloggten Windows-User → **WindowsIntegratedAuth (Kerberos)** → Token in <100ms, kein Dialog
2. `acquireTokenSilent` → Token aus In-Memory-Cache → instant, kein Dialog
3. Token-Refresh → WAM erneuert Token transparent → kein Dialog

Die workiq Binary nutzt die gleiche WAM-API, aber **falsch** — sie erstellt jedes Mal einen neuen Auth-Context und geht nie über `AcquireTokenSilent`.

### Architektur

```
VORHER:
  Agent Zero → CopilotClient → askWorkIQTool → askWorkIQ()
    → workiq MCP subprocess (JSON-RPC)
      → workiq.exe (MSAL.NET + WAM) → Account-Picker × 2
        → M365 Copilot A2A API → AI-processed answer

NACHHER:
  Agent Zero → CopilotClient → askWorkIQTool → askWorkIQ()
    → searchM365() (msal-auth.mjs)
      → getGraphToken() (MSAL Node.js + NativeBrokerPlugin)
        → WAM → WindowsIntegratedAuth (Kerberos) → Token (0 Popups)
      → Microsoft Graph Search API (/v1.0/search/query)
        → Raw search results → formatted as text
```

### Token-Details
```
App:      Work IQ CLI
Client:   ba081686-5d24-4bc6-a0d6-d034ecffed87
Scopes:   ChannelMessage.Read.All Chat.Read ExternalItem.Read.All
          Mail.Read OnlineMeetingTranscript.Read.All People.Read.All
          Sites.Read.All profile openid email
Audience: https://graph.microsoft.com
Tenant:   72f988bf-86f1-41af-91ab-2d7cd011db47 (MSIT)
Auth:     WindowsIntegratedAuth (Kerberos)
```

---

## Implementierung

### Neue Dateien
- **`msal-auth.mjs`** — MSAL Auth-Modul + Graph Search API
  - `getGraphToken()` — Token via NativeBrokerPlugin (silent/Kerberos)
  - `searchM365(question)` — Graph Search für Emails + Teams, Text-Output

### Geänderte Dateien
- **`server.js`** — `askWorkIQ()` ruft `searchM365()` statt workiq MCP
- **`package.json`** — Dependencies: `@azure/msal-node`, `@azure/msal-node-extensions`
- **`.gitignore`** — `.msal-token-cache.json` ausgeschlossen

### Dependencies
```json
{
  "@azure/msal-node": "^5.1.2",
  "@azure/msal-node-extensions": "^5.1.2"
}
```

---

## Unterschiede: workiq vs. Graph Search API

| Aspekt | workiq (vorher) | Graph Search (nachher) |
|--------|----------------|----------------------|
| Auth | WAM mit Account-Picker (2×/Query) | WAM mit Kerberos (0 Popups) |
| API | M365 Copilot A2A REST | Microsoft Graph Search v1.0 |
| Output | AI-processed Natural Language | Raw Search Results als Text |
| Latenz | 30-50s pro Query | 0.5-4s pro Query |
| Entity Types | Emails, Teams, Calendar, Files | Emails (`message`), Teams (`chatMessage`) |
| Suchlogik | AI/Semantic Search | Keyword Search |

### Wichtig: Qualitätsunterschied
Die workiq Binary nutzte **M365 Copilot** für AI-verarbeitete Antworten (semantisches Verständnis, Zusammenfassungen). Die Graph Search API macht nur **Keyword-Suche**. Die AI-Verarbeitung wird jetzt vom **GitHub Copilot SDK** übernommen, das die Suchresultate interpretiert.

---

## Token Protection Policy

### Was ist Token Protection?
Eine Conditional Access Policy im Microsoft-Tenant (MSIT), die erfordert:
- Tokens müssen kryptographisch ans Gerät gebunden sein (via Windows TPM)
- Nur der **WAM Broker** kann solche Proof-of-Possession (PoP) Tokens erstellen
- Browser-Auth, Device Code Flow, und standard MSAL Node.js werden **blockiert**

### Fehlermeldung bei Nicht-WAM-Auth
```
Sorry, a security policy is preventing access.
An organization security policy requiring token protection is preventing
this application from accessing the resource.
```

### Warum NativeBrokerPlugin funktioniert
`NativeBrokerPlugin` nutzt `msalruntime.dll` (die gleiche DLL wie `workiq.exe`) um mit dem nativen Windows WAM-Broker zu kommunizieren. Der Broker erstellt PoP-Tokens die an das TPM gebunden sind → Token Protection erfüllt.

---

## Troubleshooting

### Auth-Fehler bei Server-Start
```
[AUTH] Initial auth failed: ... — will retry on first query.
```
→ Normal beim allerersten Start. Wird beim ersten Query automatisch erneut versucht.

### "No results found for this search query"
→ Die Keyword-Extraktion aus natürlichsprachigen Fragen ist nicht perfekt. Bei sehr spezifischen Queries können Ergebnisse leer sein. Breitere Suchbegriffe funktionieren besser.

### Graph API 403 Forbidden
→ Der Token hat nicht alle nötigen Permissions. Die aktuelle App-Registration (`ba081686-...`) hat: `Mail.Read`, `Chat.Read`, `ChannelMessage.Read.All`, etc. Wenn ein neuer Scope benötigt wird, muss die App-Registration in Azure AD aktualisiert werden.

### MSAL Warning: "No account found in cache"
```
[MSAL] WARNING TryReadAccountUniversalStorage:803 No account found in cache
```
→ Normal. Der NativeBrokerPlugin speichert Accounts nicht im Node.js In-Memory-Cache, sondern im nativen WAM-Cache. Der Token wird trotzdem korrekt via Kerberos geholt.

---

## Referenzen

- [MSAL Node.js NativeBrokerPlugin Docs](https://github.com/AzureAD/microsoft-authentication-library-for-js/tree/dev/extensions/msal-node-extensions)
- [Microsoft Graph Search API](https://learn.microsoft.com/en-us/graph/api/search-query)
- [Token Protection / Proof-of-Possession](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-token-protection)
- [workiq MCP Server (GitHub)](https://github.com/microsoft/work-iq-mcp)
