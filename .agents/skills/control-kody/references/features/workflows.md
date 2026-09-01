# Workflows

Deferred one-shot runs (`workflows.create({ runAt })`).

## How to get there

`/account/workflows` → `/account/workflows/:workflowId`.

## Drive it

```bash
node tools/control-kody.ts request GET /account/workflows.json
```

## APIs

- `GET|POST /account/workflows.json`

## Gotchas

- Recurring work belongs on `kody.jobs`, not workflows.
