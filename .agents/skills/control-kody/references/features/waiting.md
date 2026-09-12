# Waiting inbox

Things waiting on the signed-in human (approvals, reconnects, expired secrets,
publish locks). Fold connection-health here — do not invent another inbox.

## How to get there

`/account/waiting`. Not a notifications product — fold connection-health and
approve-publish here instead of inventing another inbox.

## Drive it

```bash
node tools/control-kody.ts preview -- \
  --request 'GET /account/waiting.json' \
  --check /account/waiting
```

## APIs

- `GET /account/waiting.json`

## Gotchas

- Seed accounts usually still show first-use setup cards (search, memory,
  execute, package, job, integration, secret, Discord) until those gates clear.
  Empty is only after those plus reconnects and locks are gone. Create the
  pending grant or locked package through the same JSON APIs the UI uses before
  asserting copy.
- The error-rate card counts **open** Activity errors in the last 7 days.
  Ignored and resolved runs do not keep it on Waiting.
