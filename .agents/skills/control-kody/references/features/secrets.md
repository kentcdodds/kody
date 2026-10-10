# Secrets

User, session, and package secret rows. Host approval and package grants.

## How to get there

Canonical pages are `/@<slug>/-/secrets` (and `/@<slug>/-/secret-providers`).
`/account/secrets` redirects there. Detail stays under
`/@<slug>/-/secrets/{user|session|package}/…`, and `/account/secrets/new` still
redirects. Prefill agent links: `/connect/secret-set?name=…` (same family as
`/connect/secrets`). Package grant lane: `/account/secrets/approve`. Host
approval: `/connect/secrets`. External providers: `/account/secret-providers`
and `/account/secret-providers/approve`. Docs: `/docs/secret-providers`.

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
- `GET|POST /account/secret-providers.json`

`POST /account/secrets.json` writes with `action: "save"`. `name`, `value`, and
`scope` are required. Omit `currentId` to create a secret; pass `currentId` to
update one. An unknown action is HTTP 400 `Invalid action.`

Seed a preview secret with `save`:

```bash
node tools/control-kody.ts request POST /account/secrets.json '{"action":"save","scope":"user","name":"previewSeed","value":"preview-seed-value","allowedHosts":["api.example.com"]}'
```

## Gotchas

- Never paste secret values into chat, PRs, or execute params.
- Preview seed starts with zero secrets. Create one with the `save` POST above
  before asserting rows.
- `/connect/secrets` rejects hosts that are not hostname-shaped (truncated
  tokens, paths, empty values). Those must not appear as a successful Allow
  target, and they must not land in `allowedHosts`.
- Package grants on user secrets are website-only (`/account/secrets/approve` or
  the secret editor). `secretLock` returns an approval URL; it does not add
  `allowed_packages`. Provider grants are website-only on
  `/account/secret-providers`; `secretProviderLock` also returns an approval
  URL.
