# Memory auto-surface lab

Deterministic window simulator for
[0033](../../docs/contributing/decisions/0033-no-user-as-conversation.md). It
does not claim a model would obey a memory — only that distinctive text was in
the host-visible tool window at the decision.

```bash
node tools/memory-auto-surface-lab/run.mjs
```

Writes `report.md`, `summary.json`, and `invented-scores.json` under
`.tmp/memory-auto-surface-lab/` (gitignored). Set `LAB_OUT_DIR` to override.

Named theories live in `extra-policies.json`. Extra traces live in
`extra-scenarios.json`. Findings from the 2026-08-22 run:
[0033-memory-auto-surface-lab.md](../../docs/contributing/decisions/0033-memory-auto-surface-lab.md).
