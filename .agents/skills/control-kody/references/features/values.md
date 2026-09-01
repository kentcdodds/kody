# Values

Leftover drain for retired named values. Not in account nav. Do not write new
rows; map leftovers to memories, package storage, repos, secrets, or
integrations. See `docs/guides/values.md`.

## How to get there

`/account/values` → `/account/values/:valueId`.

## Drive it

```bash
node tools/control-kody.ts request GET /account/values.json
```

## APIs

- `GET /account/values.json`
- `POST /account/values.json` — `delete` only
