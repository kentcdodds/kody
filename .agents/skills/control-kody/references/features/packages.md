# Packages

Repo-backed saved packages: list, detail, files, approve-publish.

## How to get there

`/@username` lists your packages, including private and unpublished packages
when you view your own profile. Own-profile GET filters:
`visibility=public|private`, `listing=published|unpublished|ahead` (ahead =
local edits not republished), and `hidden=yes|no`. Guests can use
`listing=published|unpublished` only; owner-only params are ignored for them.
Search stays `q=`. Each package lives at `/@username/:kodyId` (the URL slug is
the package name leaf; README), `/@username/:kodyId/tree/:ref` (files),
`/@username/:kodyId/assets/…` (README-relative images from the published or
pinned commit), `/@username/:kodyId/settings` (lock, visibility, share, delete),
`/@username/:kodyId/approve-publish` (published-vs-HEAD review), and
`/@username/:kodyId/approve-changes` (guest pin-ahead published diff). Opening an
allowlisted image or video in the tree renders a preview; the bytes come from
`/@username/:kodyId/raw/:ref/…` (same authz as the tree). Legacy
`/account/packages` HTML URLs only redirect to these canonical pages.

## Drive it

Preview seed has **no** packages until you create one. Package creation is
MCP-only (`packageGetGitRemote({ create: true, kody_id })` with the package name
leaf or `@owner/leaf`). There is no create action on
`POST /account/packages.json`. Use the CLI — logged-in preview testing does not
require agents to hand-roll an MCP OAuth dance — the CLI does it for them:

```bash
npm run control-kody -- package-create --origin <preview> --package-name <leaf-or-@scope/leaf> [--head-ahead]
```

Then assert the pages:

```bash
node tools/control-kody.ts preview -- \
  --request 'GET /account/packages.json' \
  --check /@user-me
```

`--head-ahead` pushes one unpublished commit so the Code tab can show **HEAD
ahead of published**. That flag needs a minted Artifacts write remote. If
`packageGetGitRemote` fails with source-safety `account not found`, the stub
package still exists (check `/@username/:kodyId`) but HEAD-ahead cannot be
pushed on that preview. `--kody-id` is an alias for `--package-name`. To prove
delete, create a package with `package-create`, then delete it and assert the
empty state.

## APIs

- `GET|POST /account/packages.json` (list / token actions; no package-create
  action)
- `GET /profiles/:username/packages/:kodyId.json`
- `GET /profiles/:username/packages/:kodyId/files.json`
- `GET /@:username/:kodyId/raw/:ref(/*relativePath)` (allowlisted media bytes)
- `GET /profiles/:username/packages/:kodyId/approve-publish.json`
- `GET|POST /profiles/:username/packages/:kodyId/share.json`
- `GET|POST /profiles/:username/packages/:kodyId/approve-changes.json`
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
  publish HEAD on `/@username/:kodyId/approve-publish`. Publish checks require
  non-empty root `README.md` and `AGENTS.md`.
