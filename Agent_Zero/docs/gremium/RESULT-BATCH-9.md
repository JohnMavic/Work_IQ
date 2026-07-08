BATCH9F: OK

Implemented Loop-Fix 9F for AUDIT9 FAIL a,c,d.

Changes:

- The processing-ledger quality gate is now granular. It holds only mutation markers whose own source items lack a valid disposition or attachment handling. Complete independent markers still apply.
- New-project batch atomicity is documented and enforced only inside related `PROJECT_NEW` plus its own `LINEITEM_NEW` group, not across unrelated markers in the same run.
- Scan and Chat Deep Verify evaluate the temporal pass after the granular quality filter, even when quality issues exist. A complete stale-date supersession marker can now pass and apply while an unrelated ledgerless marker is held.
- Ledgerless enumerated items now create reviewQueue entries with the quality-gate reason instead of holding the whole batch.
- Deep verification and scan skill prompts now require attachment filename enumeration first: `list all attachments of this thread with filenames`, then targeted per-file WorkIQ attachment queries and per-file ledger disposition.
- Prompt self-check now forbids marker emission until every enumerated item and attachment filename has a matching disposition.

Tests:

- Granular quality hold fixture: 3 complete mutations applied, 1 ledgerless mutation held, reviewQueue reason written.
- Temporal independence fixture: stale AV 1 Jul cleanup applied while an unrelated quality-held marker stayed unapplied.
- Attachment enumeration prompt string asserts cover the scan skill and Chat Deep Verify prompt.
- `npm test` -> 150/150 passing.

Safety:

- No STOP/START scripts.
- No broad process kills.
- No running Agent Zero process touched.
