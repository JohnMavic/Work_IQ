TWOTIER: OK

Implemented two-stage task chat:

- Stage 1 uses `runTaskChatFastOnce`: 3 minute hard timeout with runner salvage, WorkIQ hard limit 2, interactive/chat effort, WorkIQ-only MCP mode, no marker application, and no Reality Gateway spawn.
- Stage 1 prompt enforces inline verification labels: `from project state (last verified <date>)` and `signal only — unverified`.
- Stage 1 parses the structured non-marker `DEEP_VERIFY` machine flag and persists running deep-verification state in the same conversation history entry.
- Stage 2 uses `runTaskChatDeepVerifyOnce`: background lane, 25 minute timeout, portal/CDP patterns allowed, marker plus Reality Gateway path enabled, and the result is appended as an `agentFollowups` contribution on the same conversation.
- Server auto-queues `deep_verify` jobs with `blocksTask:false`, so the composer is released after Stage 1 and stays usable while deep verification runs.
- UI renders `Deep verification running… (mm:ss)` below the Stage 1 answer until the Stage 2 follow-up arrives.

Verification:

- `npm test` passed: 134/134.
