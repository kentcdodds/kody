# Memories

Durable **personal** facts (ADR 0072). Always stored on the person's personal
org, regardless of which org the connection uses. Verify-first writes
(`metaMemoryVerify` before upsert/delete). Ask before copying a personal memory
into an org package. Team `/@<slug>/-/memories` is read-only.

## How to get there

`/@<slug>/-/memories` → `/@<slug>/-/memories/:memoryId`.

Personal org: writable. Team org: read-only.

## Drive it

```bash
node tools/control-kody.ts request GET /account/memories.json
```

## APIs

- `GET|POST /account/memories.json`
- `GET /@<slug>/-/memories-export.json`

## Gotchas

- MCP instruction overlay is not memory. Do not store package inventory there.
- Shared org knowledge belongs in documented packages and org instructions, not
  memory.
