# Embedding Copilot CLI as an Autonomous "Brain" in Your Own Processes

Integration guide for software engineers. Distilled from a production implementation (Node.js, Windows), but deliberately written GENERIC: every pattern transfers to any orchestration process. Based on the Copilot CLI with the `-p` headless mode, NDJSON streaming and the session store (2026).

---

## 1. The architecture model in one sentence

The CLI is a tool-capable LLM agent invocable per process spawn; your application remains the sole owner of state and control flow, and treats the agent as a replaceable subprocess with three interfaces: prompt in (argv/file), event stream out (stdout, NDJSON), structured commands out (marker lines inside the response text).

Consequences of this model:

- The LLM NEVER mutates application state directly. It emits declarative markers; the orchestrator validates and applies them (or drops them). This is the single most important design decision of the whole approach.
- Every call is its own OS process with a timeout, an exit code and a kill path. Robustness is managed at the process level, not at an API level.
- Intelligence upgrades are a flag (`--model`), not a code rebuild.

## 2. Process invocation (the exact spawn)

Argument list used in production for a headless run:

```
copilot --model <modelname>
        -p "<prompt or bootstrap instruction>"
        --yolo --no-ask-user
        --output-format json --stream on
        --name <session> | --resume <session>
        --add-dir <working-directory> [--add-dir <more>]
        --allow-all-tools
```

What each flag does and why it is there:

| Flag | Purpose |
|---|---|
| `-p / --prompt` | Non-interactive mode: one turn, the process exits after completion. This is the headless entry point. |
| `--yolo` | No confirmation prompts for tools/paths/URLs. Without it a headless run hangs on the first tool call. |
| `--no-ask-user` | Disables the agent's ask_user tool; it works autonomously instead of waiting for answers. If you WANT clarifying questions, omit it and handle the question events. |
| `--output-format json --stream on` | stdout becomes an NDJSON event stream (one JSON object per line), live during the run. Alternative: `-s` (final text only, blind while running). |
| `--name <s>` / `--resume <s>` | Session memory: the first run names the session, subsequent runs resume it (verbatim conversation memory across process boundaries). |
| `--add-dir <dir>` | Whitelist: the agent may read/write with its file tools inside these directories. |
| `--allow-all-tools` | Required so the agent can use its tools (read/write/shell/...) inside the whitelist without per-call approvals. |
| `cwd` (spawn option) | Working directory of the child process = the job's work folder. Important: the agent's shell and MCP tools resolve relative paths against cwd, NOT against --add-dir. If you leave cwd pointing at your own repo, you invite the agent to work there. |

Two Windows traps, both verified in production:

1. **WinGet shim:** `spawn('copilot', ...)` with `shell:false` fails silently on Windows (exit 1, 0 bytes on both streams) because the WinGet link is not directly invocable. Solution: resolve the absolute path once via `where.exe copilot.exe` and memoize it.
2. **32 KB command-line limit:** CreateProcess caps the whole command line at 32767 characters; a large context blows through that. Solution (file-context pattern): above a threshold (~16 KB), write the full context to a per-run-unique file inside the working directory and pass only a tiny bootstrap as `-p`: "Your full instructions are in the file X. Read it IN FULL with your Read tool before doing anything else, then act on it." Clean the file up after the process ends. Per-run uniqueness (pid+time+random in the name) is mandatory, otherwise parallel runs clobber each other's context.

**Model pinning:** the `--model` flag wins over the env var and the settings file (priority: flag > COPILOT_MODEL > settings.json > default). For deterministic behavior, ALWAYS splice the flag to the front of the argument list, defensively strip any caller-supplied duplicates, and set COPILOT_MODEL to the same value. Background: interactive CLI sessions of the same user share `~/.copilot/settings.json`; a `/model` switch in the user's own terminal would otherwise silently reconfigure your automation.

## 3. Context architecture: two memory layers

The implementation combines two complementary memories, and exactly this combination keeps the agent stable over days:

**Layer 1, CLI session (`--name`/`--resume`):** verbatim conversation memory in the CLI's session store. The orchestrator persists two fields per work context in its own state: `sessionName` (e.g. `<prefix>-<id>-<epochMs>`) and `sessionStarted` (bool). First run: `--name`; success sets the flag; every later run: `--resume`. Important: design the session as DISPOSABLE (see section 6); every hard fact must be reconstructible from layer 2 at any time.

**Layer 2, regenerated state document:** before EVERY run the orchestrator renders a markdown document (e.g. `state-memory.md`) completely fresh from its own source of truth (database/JSON), writes it to disk and injects it into the prompt. It contains everything the agent needs for the turn: the assignment, current state, open items, the history of recent results. Pair it with a standing prompt instruction: "Re-read your persisted state from disk and observe the live world; on divergence NEVER trust your session memory over disk and reality." This neutralizes stale self-narratives in long-lived sessions.

Token economy: on `--resume` turns the model already has the system prompt in session memory from the original `--name` turn; re-injecting it wastes context budget. Only the fresh state document and the turn message are sent.

## 4. Output channel: parsing the NDJSON stream

With `--output-format json --stream on`, stdout delivers one event `{ type, data, ... }` per line. The parser is classic line buffering: append chunks to a buffer, split on `\n`, keep the last (incomplete) line in the buffer, `JSON.parse` every complete line (count parse failures, do not throw). Event types that matter in practice:

- Assistant text (final per turn): aggregate the response text from it; this is the input for the marker parser (section 5).
- `tool.execution_start` / `tool.execution_complete`: live visibility into what the agent is doing (telemetry, dashboards, debugging). Without streaming, a run is a black box until it ends.

Production lessons: hard-cap the stdout/stderr accumulators (keep head+tail, count the TRUE total length separately, because classifiers like the silent-failure signature read the byte COUNT); skip lines beyond a sanity length instead of parsing them; log a 60s heartbeat (pid, bytes, events, tool calls) so hung runs are visible. Verify the exact event type names against your installed CLI version.

## 5. Control channel: the marker protocol (the heart of the design)

How does the LLM tell the orchestrator, in a structured way, WHAT it decided? Through a marker grammar defined in the system prompt: single-line commands inside the response text.

```
[STATUS_UPDATE] {"id":"item-7","status":"done"}
[NEW_SCHEDULE] {"id":"job-poll","schedule":{"intervalMinutes":60},"payload":{...}}
[WORK_DONE] {"jobId":"job-poll","results":[{"taskId":"t-1","status":"fulfilled","evidence":"..."}]}
[ASK_USER] {"question":"...","options":["a","b"]}
```

Rules that proved themselves (each one is the answer to a real production incident):

1. **Define the grammar rigidly in the system prompt:** one marker per line, nothing else on that line, the payload as single-line JSON on the SAME line as the tag. Actively check the prompt rules for contradictions (a rule "emit markers inline" plus a rule "the closing marker is the last line" led the model to emit twice; such rules need explicit exceptions to each other).
2. **The server validates, fail closed:** every marker goes through schema validation (plus referential integrity, e.g. "references existing ids"); anything invalid is DROPPED and logged, never half-applied, never semantically "repaired".
3. **Plan for drift, coerce deterministically:** LLMs drift away from the canonical grammar under context pressure (observed: `key=value` shorthands instead of JSON, field-name aliases like `triggerId=` instead of `id`, markers split across lines, bare tags without payload, a JSON object instead of the documented `file=` format). The answer: ONLY on the parse-failure path, run a deterministic, never-throwing coercion layer (regex token extraction, line-continuation reassembly), whose result still has to pass the unchanged validation. Deliberately NO semantic repair: whatever cannot be reconstructed safely is dropped (same behavior as before), and every coercion writes an audit log line.
4. **Batch order is intent:** the markers of one response are ONE atomic intent. Real example: the model emits REMOVE plus NEW for the same id in the same batch as a replace idiom; application logic must treat such same-batch sequences differently from the same sequence spread across two runs.
5. **Stream plus batch, apply exactly once:** apply markers live from the stream (responsiveness) AND re-parse the full final text after the process ends (the stream can tear lines at chunk boundaries). To prevent double application, the orchestrator keeps a per-run outcome ledger ({type, applied} per streamed marker, positional per type) and applies from the batch only entries whose stream slot is absent or failed. Handlers must reliably return success/failure for this, because some applications (append, push) are not idempotent.
6. **Lifecycle loop:** markers like `[NEW_SCHEDULE]`/`[REMOVE_SCHEDULE]`/`[WORK_DONE]` let the agent steer its OWN future execution (adapt cadence, register one-shot follow-ups, acknowledge work as closed), while the orchestrator remains the only scheduler. The `WORK_DONE` receipt doubles as the drift signal (section 6).

## 6. Robustness envelope (every item here was needed in production)

**Timeout + salvage:** a uniform time budget per run (30 min). On timeout: kill the child; if substantial response text already exists (threshold ~200 bytes), treat the run as a success with a partial result (resolve), otherwise reject with `timedOut=true`.

**Wall-clock watchdog + single settle:** `setTimeout` sleeps with the laptop (suspended timers fire only on wake). A heartbeat-based watchdog checks the WALL-CLOCK duration against the budget and settles hung runs; a shared `settled` flag guarantees that timer, watchdog, close and error handlers can never settle a run twice.

**Strict success criterion:** success is exit 0 AND non-empty response text. Everything else is a failure.

**Silent-failure signature:** exit != 0 AND 0 bytes on stdout AND stderr is the documented pattern of a corrupted `--resume` session (session-store trouble). Reaction: drop the session fields, generate a fresh `--name`, PERSIST, then exactly ONE retry within the same cycle. Loud resume failures ("session not found" after a CLI update or store purge) belong in the same once-only recovery, otherwise a resuming process hangs forever.

**Environmental classification:** OS sleep/wake events produce failure shapes that look like agent/session failures but are not. Three structural signals: (i) win32 exit code >= 0xC0000000 with total silence (the OS kill), (ii) a settled run whose wall-clock duration exceeds the never-fired timeout (sleep in the middle of a run), (iii) a wake window: your own scheduler ticks regularly; a pass gap far above the interval proves suspend/resume, and failures shortly after count as environmental. Consequence: such failures do not drop a session, do not count as agent drift, and are reported to the user as "environment interrupted, retry on the next interval", not as "failed". For this, attach structured fields to the error object (exitCode, durationMs, timeoutMs, stdoutBytes, stderrBytes, timedOut) instead of sniffing message strings.

**Drift detection via closure markers:** the orchestrator counts, per recurring job, consecutive runs WITHOUT a valid `WORK_DONE` receipt. At a cadence-scaled threshold (fast jobs tolerate 2, slow ones 1, with a wall-clock ceiling) the CLI session is dropped, so the next run starts fresh and re-grounds itself on disk truth; a cooldown (e.g. 6 h) prevents reset oscillation, and a bootstrap guard prevents resets on jobs that have never closed yet. This is the self-healing against "poisoned" session narratives, and it only works because layer 2 (section 3) holds all the facts.

**Concurrency:** a global semaphore for the maximum number of parallel CLI processes (production value: 2), plus one serialized queue per work context (never two runs on the same state simultaneously). Think kill paths through with `taskkill /T` on win32 (tool child processes like browsers otherwise survive the parent kill).

**Session-store hygiene:** every `--name` session stays in the CLI's store (`~/.copilot/session-state/` keyed by internal uuids, the mapping in `session-store.db`); there is currently NO CLI subcommand for deleting sessions. With session-per-run designs the store grows fast (observed: thousands of entries). Plan for it: create sessions sparingly (resume instead of re-naming) and watch for a future cleanup subcommand.

## 7. Minimal skeleton (Node.js, generic)

Deliberately reduced to the skeleton; add the production hardening from section 6. Verify event type names against your installed CLI version.

```js
const { spawn } = require('child_process');

function runBrain(prompt, { exePath, model, session, resume, workDir, onMarker, onTool, timeoutMs = 30 * 60_000 }) {
  return new Promise((resolve, reject) => {
    const args = [
      '--model', model,
      '-p', prompt,
      '--yolo', '--no-ask-user',
      '--output-format', 'json', '--stream', 'on',
      resume ? '--resume' : '--name', session,
      '--add-dir', workDir,
      '--allow-all-tools',
    ];
    const child = spawn(exePath, args, { shell: false, cwd: workDir, windowsHide: true });

    let settled = false, text = '', buf = '', errBytes = 0, outBytes = 0;
    const startMs = Date.now();
    const settle = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      if (text.trim().length >= 200) return settle(resolve, { text: text.trim(), salvaged: true });
      settle(reject, Object.assign(new Error('brain timeout'), { timedOut: true }));
    }, timeoutMs);

    child.stdout.on('data', d => {
      outBytes += d.length; buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'tool.execution_start' && onTool) onTool(ev);
        if (ev.type === 'assistant.message') {
          const content = String(ev.data?.content ?? '');
          text += content + '\n';
          for (const tl of content.split('\n')) {
            const m = tl.trim().match(/^\[([A-Z_]+)\]\s*(.*)$/);   // marker grammar
            if (m && onMarker) onMarker(m[1], m[2]);               // validation happens in the caller!
          }
        }
      }
    });
    child.stderr.on('data', d => { errBytes += d.length; });

    child.on('close', (code) => {
      if (code === 0 && text.trim()) return settle(resolve, { text: text.trim() });
      const e = new Error(`brain failed: exit ${code}`);
      e.exitCode = code; e.durationMs = Date.now() - startMs; e.timedOut = false;
      e.silentFailure = code !== 0 && outBytes === 0 && errBytes === 0;  // resume-corruption signature
      e.usedResume = !!resume;
      settle(reject, e);
    });
    child.on('error', e => settle(reject, e));
  });
}
```

Caller-side (orchestrator duties): persist the session fields and, on `silentFailure && usedResume`, retry exactly once with a fresh name; validate markers through schema gates and apply them to YOUR OWN state; serialize runs per context; re-parse the full final text for markers after the process ends and reconcile against the stream ledger.

## 8. The operational lessons in short form

1. The model follows the marker grammar ~95 percent of the time; the remaining 5 percent (drift after context compaction, fresh sessions) need coercion plus fail-closed validation, or you silently lose commands.
2. Session memory is convenience, disk is truth. Every hard fact must be reconstructible from your own state; then a session reset costs nothing.
3. On consumer hardware (laptop, sleep mode) the most frequent "LLM failures" are actually OS events. Without environmental classification, your own recovery destroys healthy sessions.
4. Exit-code discipline: success only on exit 0 plus content; treat the 0-bytes signature separately; structured fields on the error object instead of message parsing.
5. Make everything the agent does observable (tool events, heartbeat, audit lines for every coercion/drop). The AUDIT log channel must stay quiet so real losses stand out.
6. Pin the model (flag beats env beats settings), otherwise the user's interactive CLI session reconfigures your automation.
