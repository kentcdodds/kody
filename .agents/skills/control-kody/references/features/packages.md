# Packages

Repo-backed saved packages: list, detail, files, approve-publish.

## How to get there

`/account/packages` → `/account/packages/:packageId` →
`/account/packages/:packageId/approve-publish`.

## Drive it

Preview seed has **no** packages until you create one through the JSON API the
UI posts to (`/account/packages.json`).

```bash
node tools/control-kody.ts preview -- \
  --request 'GET /account/packages.json' \
  --check /account/packages
```

To prove delete, create a package through the JSON API, then delete it and
assert the empty state.

## APIs

- `GET|POST /account/packages.json`
- `GET /account/packages/:packageId/files.json`
- `GET|POST /account/packages/:packageId/approve-publish.json`

## Gotchas

- Stay on the preview origin. Do not follow a package-app handoff into
  production.
- Unlocking a locked package is website-only.
