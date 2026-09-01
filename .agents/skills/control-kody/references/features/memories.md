# Memories

Durable user facts. Verify-first writes (`meta_memory_verify` before
upsert/delete).

## How to get there

`/account/memories` → `/account/memories/:memoryId`.

## Drive it

```bash
node tools/control-kody.ts request GET /account/memories.json
```

## APIs

- `GET|POST /account/memories.json`
- `GET /account/memories-export.json`

## Gotchas

- MCP instruction overlay is not memory. Do not store package inventory there.
