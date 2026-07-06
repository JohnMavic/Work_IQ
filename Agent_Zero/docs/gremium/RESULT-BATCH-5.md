BATCH5: OK code/tests/data-repair/bootstrap complete; npm test 85/85; 6a wrote true with 4 unreconstructable links nulled, 6b moved Circle contamination to reviewQueue, 6c Agency-gated bootstrap approved/applied all remaining FactSheet patches with 0 WorkIQ calls

# Batch 5 Result

- Implemented FactSheet data model, `[FACTSHEET_UPDATE]`, full project FactSheet state spills, and Reality-Check Gateway before apply.
- Hardened link handling with deny-first `turn*search*` rejection, freetext token scrubbing, and lossless keep+audit for unusual real links.
- Added UI Fact Sheet panel, `GET /api/tasks/:id/factsheet.html`, and defensive `dd.mm.yyyy` source-link labels.
- Added/updated repair scripts for 6a, 6b, and 6c. `tasks.json` was changed only through scripts with backup rotation.
- Executed 6a/6b/6c on the live ignored data. Final checks show no `turn*search*` links/text, Circle contamination removed from pmStatus/lineItems, retained sourceRefs preserved, and Circle FactSheet bootstrapped after the Gateway-approved filtered rerun.
- Tests: `npm test` passed, 85/85.
