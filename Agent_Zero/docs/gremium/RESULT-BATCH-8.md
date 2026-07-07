BATCH8: OK

# Batch 8 Result

## Implemented

- Added `brain-learnings.md` seed memory with Signals-vs-Systems-of-Record, WorkIQ-as-lossy-index, verify-or-unverified, and a generic Edge-CDP portal verification pattern.
- Added `brain/learnings.js` for learnings rendering, byte budget trimming oldest entries first, validation, append, and dedupe.
- Added `[LEARNING]` marker parsing, validation, gateway review, and applier append support.
- Injected Brain Learnings into scan state, task-chat bootstrap, and reality-gateway prompt.
- Corrected scan and chat truth hierarchy to: live Systems of Record > full verbatim threads/documents > WorkIQ summaries/search > state/fact sheets > old summaries/inference.
- Embedded task-chat marker grammar and action/evidence gate rules so chat runs do not need to read grammar docs at runtime.
- Fixed task-chat history confidence from `unknown` to a concrete derived value.

## Edge-CDP Import

- Per prompt, attempted an `agency.exe copilot` headless memory query for `edge-cdp-automation.md`; the command exited successfully but returned no text.
- Located the memory file locally at `C:\Users\martih\.github\patterns\edge-cdp-automation.md` and imported only generic steps: dedicated debug Edge/CDP flow, WAM/Entra SSO awareness, portal page reads through CDP, and double-checking Pending plus History/completed views before asserting approval state.

## Safety

- No STOP/START scripts were run.
- No broad process kills were used.
- `tasks.json` was not touched.
- No Agent Zero user/server instance was touched.

## Verification

- `npm test` passed: 127/127 tests.
- Added focused Batch 8 tests for learnings injection/budget, LEARNING marker gate, prompt hierarchy/grammar, gateway LEARNING validation, and task-chat confidence.

BATCH8B: OK
