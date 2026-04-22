# Agent Zero — Tests

This directory holds **all** test artefacts for Agent Zero. Nothing test-related should live outside `tests/` in the project root.

## Structure

- `unit/` — pure unit tests, no network, no LLM, no M365/WorkIQ required. Run via `node --test tests/unit/*.mjs`.
- `runs/` *(gitignored)* — scratch output from ad-hoc experiments: screenshots, PID files, stdout/stderr dumps. Safe to delete at any time.

## Convention

**Every ad-hoc test script, screenshot, or diagnostic dump goes here.** If you produce a file while investigating a bug and the file is not meant to be committed, put it under `tests/runs/`. When the investigation is over, `rm -rf tests/runs/` is the one-line cleanup.

## Running tests

```powershell
# From repo root:
cd Agent_Zero
npm test
```

## Adding a unit test

Drop a new file into `tests/unit/` named `<topic>.mjs`. Use `node:test` and `node:assert/strict`. Keep tests hermetic: no HTTP, no filesystem outside `tests/unit/.tmp-*`, no spawn.
