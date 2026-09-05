# Secrets

User, session, and package secret rows. Host approval and package grants.

## How to get there

`/account/secrets` → new `/account/secrets/new` → detail under
`/account/secrets/{user|session|package}/…`. Package grant lane:
`/account/secrets/approve`. Host approval: `/connect/secrets`.

## Drive it

```bash
node tools/control-kody.ts preview -- \
  --request 'GET /account/secrets.json' \
  --check /account/secrets
```

GET the page body after a claimed fix. A “try
https://kody.codes/account/secrets” note with no body is not proof.

## APIs

- `GET|POST /account/secrets.json`

## Gotchas

- Never paste secret values into chat, PRs, or execute params.
- Preview seed starts with zero secrets.
