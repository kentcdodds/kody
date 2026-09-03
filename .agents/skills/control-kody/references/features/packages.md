# Packages

Repo-backed saved packages: list, detail, files, approve-publish.

## How to get there

`/account/packages` lists your packages. Each package lives at
`/@username/:kodyId` (README), `/@username/:kodyId/tree/:ref` (files), and
`/@username/:kodyId/settings` (tokens, lock, visibility, delete). Leftover
`/account/packages/:packageId` and `/account/packages/:packageId/files` redirect
to those URLs.

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
- `GET /profiles/:username/packages/:kodyId.json`
- `GET /profiles/:username/packages/:kodyId/files.json`
- `GET /account/packages/:packageId/files.json` (404 + `redirectTo` the tree)
- `GET|POST /account/packages/:packageId/approve-publish.json`

## Gotchas

- Stay on the preview origin. Do not follow a package-app handoff into
  production.
- Unlocking a locked package is website-only.
- Making a package public or private requires typing the slug.
- When default-branch HEAD is newer than the last publish, the Code tab shows
  **HEAD ahead of published**. Owners click that badge to review the diff and
  publish HEAD on `/account/packages/:packageId/approve-publish`.
