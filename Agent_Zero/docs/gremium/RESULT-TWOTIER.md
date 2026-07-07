TWOTIER: OK

Implemented two-stage task chat:

- Stage 1 uses `runTaskChatFastOnce`: 120s hard timeout, WorkIQ hard limit 0, interactive/chat effort, MCP-free mode, no marker application, and no Reality Gateway spawn.
- Stage 1 prompt enforces state-only answers with inline verification labels: `from project state, last verified <date>` and `signal only — unverified`.
- Stage 1 parses the structured non-marker `DEEP_VERIFY` machine flag, server-forces deep verification for scan/lookup/current-state questions, and persists running deep-verification state in the same conversation history entry.
- If Stage 1 times out or returns no usable answer, the server writes a deterministic fallback from `pmStatus` and the Fact Sheet, then queues deep verification.
- Stage 2 uses `runTaskChatDeepVerifyOnce`: background lane, 25 minute timeout, portal/CDP patterns allowed, marker plus Reality Gateway path enabled, and the result is appended as an `agentFollowups` contribution on the same conversation.
- Server auto-queues `deep_verify` jobs with `blocksTask:false`, so the composer is released after Stage 1 and stays usable while deep verification runs.
- UI renders `Deep verification running… (mm:ss)` below the Stage 1 answer until the Stage 2 follow-up arrives.

Verification:

- `npm test` passed: 137/137.

TWOTIER-FIX: OK — Stage 1 is state-only and MCP-free, scan/lookup/status questions defer to Stage 2, and the deterministic timeout fallback prevents no-answer failures.

S2-SPEED: OK
