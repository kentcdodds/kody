# Waiting inbox

Things waiting on the signed-in human (approvals, reconnects, publish locks).

## How to get there

`/account/waiting`. Not a notifications product — fold connection-health and
approve-publish here instead of inventing another inbox.

## Drive it

```bash
node tools/control-kody.ts preview -- \
  --request 'GET /account/waiting.json' \
  --check /account/waiting
```

`#1928` seeded a waiting probe, then recorded a preview video of the live page.

## APIs

- `GET /account/waiting.json`

## Gotchas

- Empty is the common seed state. Create the pending grant or locked package
  through the same JSON APIs the UI uses before asserting copy.
