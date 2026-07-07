BATCH9: OK

Implemented without running the live acceptance from Brief §5.

- Cage flags removed from normal Agency runs: no `--no-default-mcps`, no named `--disable-mcp-server`, and `workiq-only` no longer disables other MCPs. Stage 1 chat remains the explicit MCP-free latency path via `mcpMode:"none"`.
- Tool budget changed from WorkIQ hard kills to loop guard: warning at 40 tool starts, emergency stop at 150.
- Discovery prompts now require mail/Teams-first update discovery, full message bodies, and PDF/DOCX/XLSX attachment reading as mandatory evidence.
- Truth-tree context verified and extended across scan, chat fast/deep, gateway, reverify sweep, and migration prompts/states: Fact Sheets, pmStatus, lineItems, processing cursor/ledger context, brainState, and Brain Learnings.
- Reality Gateway keeps update discipline and now checks whether available evidence, including attachments, was used instead of ignored.
- External-write guardrail documented: reads/research/browsing are unrestricted; external writes require an explicit same-conversation user instruction.
- `brain-learnings.md` was clean; added a complete general learning for attachment evidence.

Tests: `npm test` -> 142/142 passing.
