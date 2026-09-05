# Packages

Repo-backed saved packages: list, detail, files, approve-publish.

## How to get there

`/@username` lists your packages, including private and unpublished packages
when you view your own profile. Each package lives at `/@username/:kodyId`
(README), `/@username/:kodyId/tree/:ref` (files), `/@username/:kodyId/settings`
(lock, visibility, delete), and `/@username/:kodyId/approve-publish`
(published-vs-HEAD review). Legacy `/account/packages` HTML URLs only redirect
to these canonical pages.

## Drive it

Preview seed has **no** packages until you create one through the JSON API the
UI posts to (`/account/packages.json`).

```bash
node tools/control-kody.ts preview -- \
  --request 'GET /account/packages.json' \
  --check /@me
```

To prove delete, create a package through the JSON API, then delete it and
assert the empty state.

## APIs

- `GET|POST /account/packages.json`
- `GET /profiles/:username/packages/:kodyId.json`
- `GET /profiles/:username/packages/:kodyId/files.json`
- `GET /profiles/:username/packages/:kodyId/approve-publish.json`
- `GET /account/packages/:packageId/files.json` (404 + `redirectTo` the tree)
- `GET|POST /account/packages/:packageId/approve-publish.json`

## Gotchas

- Stay on the preview origin. Do not follow a package-app handoff into
  production.
- Unlocking a locked package is website-only.
- Making a package public or private requires typing the slug. Going public also
  asks the owner to skim source, README, and examples for personal details
  first. Agents review that hygiene before `packageUpdate`
  `changes.visibility: "public"`; they pass `confirm_name` only when going
  private.
- Invocation-token JSON actions on `POST /account/packages.json` are an
  unadvertised operator drain. Settings does not show token forms.
- When default-branch HEAD is newer than the last publish, the Code tab shows
  **HEAD ahead of published**. Owners click that badge to review the diff and
  publish HEAD on `/@username/:kodyId/approve-publish`.
