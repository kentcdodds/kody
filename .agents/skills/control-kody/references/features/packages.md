# Packages

Repo-backed saved packages: list, detail, files, share, approve-publish.

## How to get there

`/@username` lists your repositories (saved packages), including private and
unpublished ones when you view your own profile. The page heading and account
rail label are **Repositories**; routes stay `/@username` and
`/account/packages`. Chip filters (`visibility`, `listing`, `hidden`, `package`,
`app`) and sort (`sort=updated|created|name`, `dir=asc|desc`) run client-side
from the already-loaded list (behind a `<details>` Filters disclosure; no
loader, no view transition). Default sort is updated descending
(`updated_at DESC`); name defaults to ascending. `package=yes|no` is whether the
row has the saved-package extension — distinct from `app=yes|no` (Has app / No
app). Own-profile GET params: `visibility=public|private`,
`listing=published|unpublished|ahead` (ahead = **Needs republish**: the listing
pin is behind `published_commit`, not HEAD-ahead-of-published), `hidden=yes|no`,
`package=yes|no`, `app=yes|no`, `sort=created|name`, and `dir=asc|desc` (omit
`dir` when it matches the sort field's default). Guests can use
`listing=published|unpublished`, `package=yes|no`, `app=yes|no`, `sort`, and
`dir`. Owner-only params are ignored for them. Search is `q=` and filters the
already-loaded list as you type (URL `replaceState`, no loader). Each row shows
Iconic signifiers (native tooltip only) for package, private, hidden,
published-to-community or no community listing, webhook count, job count, and
whether it has an app. Private repositories do not also get a “no community
listing” signifier — the private icon is enough. List marks come from
`/@username/:kodyId/icon/:iconCommit` (packages) and
`/account/repos/:repoId/icon/:iconCommit` (owner-only plain repos). Each package
lives at `/@username/:kodyId` (the URL slug is the package name leaf; **Repo**
tab: description, tags, license, badges), `/@username/:kodyId/tree/:ref`
(**Files** tab), `/@username/:kodyId/assets/…` (README-relative images from the
published or pinned commit), `/@username/:kodyId/settings` (**Settings** tab:
lock, visibility, share, webhooks, delete), `/@username/:kodyId/approve-publish`
(published-vs-HEAD review), and `/@username/:kodyId/approve-changes` (guest
pin-ahead published diff). Opening an allowlisted image or video in the tree
renders a preview; the bytes come from `/@username/:kodyId/raw/:ref/…` (same
authz as the tree). Legacy `/account/packages` HTML URLs only redirect to these
canonical pages.

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

`--head-ahead` pushes one unpublished commit so the Repo tab can show **HEAD
ahead of published**. That flag needs a minted Artifacts write remote.
`--kody-id` is an alias for `--package-name`. To prove delete, create a package
with `package-create`, then delete it and assert the empty state. Arbitrary MCP
fixtures use `control-kody execute` / `search` against the same origin.

## APIs

- `GET|POST /account/packages.json` (list / token actions; no package-create
  action)
- `GET /profiles/:username/packages/:kodyId.json`
- `GET /profiles/:username/packages/:kodyId/files.json`
- `GET /@:username/:kodyId/icon/:iconCommit` (package list mark)
- `GET /account/repos/:repoId/icon/:iconCommit` (owner-only repo list mark)
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
- When default-branch HEAD is newer than the last publish, the Repo tab shows
  **HEAD ahead of published**. Owners click that badge to review the diff and
  publish HEAD on `/@username/:kodyId/approve-publish`. Publish checks require
  non-empty root `README.md` and `AGENTS.md`.
- Owners and accepted shares see **Open Package App** on the package page when
  the package declares an app. Guests do not.
- Own-profile **Needs republish** (`listing=ahead`) is listing pin behind
  `published_commit`. It is not HEAD-ahead-of-published and not `updated_at`
  after `published_at` (community publish bumps that timestamp even when the pin
  already matches).
