# Secrets

User, session, and package secret rows. Host approval and package grants.

## How to get there

`/account/secrets` → new `/account/secrets/new` → detail under
`/account/secrets/{user|session|package}/…`. Package grant lane:
`/account/secrets/approve`. Host approval: `/connect/secrets`. External
providers: `/account/secret-providers` and `/account/secret-providers/approve`
(hidden unless the `secret-providers` flag is on for the seeded user). Docs
opt-in: `/docs/secret-providers` (POST `/docs/secret-providers/opt-in`).

## Drive it

```bash
node tools/control-kody.ts preview -- \
  --request 'GET /account/secrets.json' \
  --check /account/secrets
```

GET the page body after a claimed fix. A “try
https://kody.codes/account/secrets” note with no body is not proof.

## APIs

- `GET /account/secrets.json`
- `POST /account/secrets.json` with `action`:
  - `save` — create or update a user or package secret. `create` is the same
    write. Omit `currentId` to create; pass `currentId` to update. The account
    editor sends `save`.
  - `delete` — `{ "action": "delete", "currentId" }`
  - `approve` / `reject` — host or package grant on the approval URL
  - `save_oauth_app`, `connect_oauth`, `oauth_exchange` — OAuth connect
- `GET|POST /account/secret-providers.json`

An unknown `action` is HTTP 400
`Invalid action. Expected one of: save, create, delete, approve, reject, save_oauth_app, connect_oauth, oauth_exchange.`

Seed a preview secret with `save` or `create` (same write):

```bash
node tools/control-kody.ts request POST /account/secrets.json '{"action":"save","scope":"user","name":"previewSeed","value":"preview-seed-value","allowedHosts":["api.example.com"]}'
```

## Gotchas

- Never paste secret values into chat, PRs, or execute params.
- Preview seed starts with zero secrets. Create one with the `save` or `create`
  POST above before asserting rows.
- `/connect/secrets` rejects hosts that are not hostname-shaped (truncated
  tokens, paths, empty values). Those must not appear as a successful Allow
  target, and they must not land in `allowedHosts`.
- Package grants on user secrets are website-only (`/account/secrets/approve` or
  the secret editor). `secretLock` returns an approval URL; it does not add
  `allowed_packages`. Provider grants are website-only on
  `/account/secret-providers`; `secretProviderLock` also returns an approval
  URL.
