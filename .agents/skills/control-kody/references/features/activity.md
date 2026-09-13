# Activity

User-level execution history (jobs, execute, webhooks, apps).

## How to get there

`/account/activity` → `/account/activity/:runId`.

## Drive it

```bash
node tools/control-kody.ts request GET /account/activity.json
```

## APIs

- `GET /account/activity.json`

## Gotchas

- This is not the waiting inbox. Waiting is human-action items; activity is run
  history.
- Workflow runs named `inline-code` show the idempotency key as a subtitle.
