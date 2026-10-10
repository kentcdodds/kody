# Memories

Durable user facts. Verify-first writes (`metaMemoryVerify` before
upsert/delete).

## How to get there

`/@<slug>/-/memories` → `/@<slug>/-/memories/:memoryId`.

## Drive it

```bash
node tools/control-kody.ts request GET /account/memories.json
```

## APIs

- `GET|POST /account/memories.json`
- `GET /@<slug>/-/memories-export.json`

## Gotchas

- MCP instruction overlay is not memory. Do not store package inventory there.
