# Account hub

Pages about the person, split from the org workspace:

- `/account` (Profile): name, avatar, email, onboarding banner.
- `/account/security`: password, links to two-factor and passkeys, sign-in
  providers (Connected accounts), former emails.
- `/account/organizations`: every org you belong to (Current marks the one the
  switcher is acting in), pending invites (`#invites`), and Create organization.
- `/account/experiments`: experiments opt-in.
- `/account/data`: export and delete account.

The account rail ("Account sections") lists only those pages. Workspace pages
(Repositories, Jobs, Secrets, Connections, Billing, and the rest) sit on a
separate "Workspace sections" rail under `/@<slug>/-/…`; Repositories is
`/@<slug>/-/packages`, distinct from the public profile at `/@<slug>`. Both
rails come from `account-rail.ts` and render through `AccountPageHeader` in
`packages/worker/client/routes/account-management-components.tsx`. Below 860px a
rail collapses to a `<details>` menu.

The site header has one avatar: the org switcher (`data-testid="org-switcher"`).
Its popover lists orgs, then Manage links for the current team org (Settings,
Members, Teams, Grants, Collaborators, Billing when the role allows), Create
organization, an invites row when you have any, then a "Your account" group
(Your profile, Account settings, Log out). Narrow viewports show the same rows
in the menu panel.

## How to get there

`/account` after login. Create an organization at `/account/organizations/new`
(`POST` the same path with `displayName` and `slug`); it redirects to the org
home at `/@<slug>`. Account deletion is `/account/delete`. Team-org settings,
members, teams, grants, and collaborators are `/@<slug>/-/settings`,
`/@<slug>/-/members`, `/@<slug>/-/teams`, `/@<slug>/-/grants`, and
`/@<slug>/-/collaborators`.

A non-personal org handle (`/@<slug>`) renders the org home for its members and
404s for everyone else. Secrets, jobs, and the other org resource pages read
`request.org.id`. Packages and connected agents 404 on a team org because those
two sections read the person. Team orgs have an Organization rail: Settings,
Members, Teams (owners/members), Grants, Collaborators, and Billing
(`/@<slug>/-/billing`, owners and billing users). The org switcher, org home,
and `/account/organizations` also link into those sections. Personal orgs keep
Billing/Usage on the account rail.

Resource pages (packages, secrets, jobs, and the rest) live under
`/@<slug>/-/…`. `/account/...` resource pages 404, except
`/account/packages/:packageId`, which redirects to `/@username/:kodyId`.

## Drive it

```bash
node tools/control-kody.ts login
node tools/control-kody.ts request GET /account/profile.json
node tools/control-kody.ts request GET /account/organizations.json
node tools/control-kody.ts request GET /@<slug>/-/settings.json
node tools/control-kody.ts request GET /@<slug>/-/members.json
node tools/control-kody.ts request GET /@<slug>/-/teams.json
node tools/control-kody.ts request GET /@<slug>/-/grants.json
node tools/control-kody.ts request GET /@<slug>/-/collaborators.json
node tools/control-kody.ts request GET /account/connections.json
```

## APIs

- `GET|POST /account/profile.json`
- `GET /account/organizations.json` (orgs, last-used org, pending invites)
- `GET|POST /@<slug>/-/settings.json` (team org profile; personal orgs point at
  Account)
- `POST /@<slug>/-/settings/avatar.json`
- `POST /@<slug>/-/settings/delete.json`
- `GET /@<slug>/-/members.json`
- `POST /@<slug>/-/members/role.json`
- `POST /@<slug>/-/members/remove.json`
- `POST /@<slug>/-/members/invite.json`
- `GET /@<slug>/-/teams.json`
- `POST /@<slug>/-/teams/create.json`
- `POST /@<slug>/-/teams/member-add.json`
- `POST /@<slug>/-/teams/member-remove.json`
- `GET /@<slug>/-/grants.json`
- `POST /@<slug>/-/grants/revoke.json`
- `GET /@<slug>/-/collaborators.json`
- `POST /account/profile/avatar.json`
- `POST /account/email-change.json`
- `POST /account/email-claim-release.json`
- `GET /account/export.json`
- `POST /account/delete`
- `GET|POST /account/connections.json` (sign-in providers: GitHub, Google, X,
  Discord)
- `POST /logout` (Log out in the switcher popover)

## Gotchas

- Seed users start empty. Profile fields exist; packages/secrets/jobs do not
  until you create them.
- A successful `POST /account/delete` clears the session and the account page
  navigates to `/?accountDeleted=1`. The homepage status
  `data-testid="account-deleted-notice"` reads "Your Kody account has been
  deleted". Do not delete the shared preview seed to prove this.
- Connected agents (inbound MCP hosts) are a workspace page:
  [connections](./connections.md) at `/@<slug>/-/connections`.
- Linking a sign-in provider returns to `/account/security?oauthLinked=<id>`.
- Former-address release is `POST /account/email-claim-release.json`, then
  confirm at `/verify-email-claim-release`. It drops the claim without reminting
  `users.stable_user_id`.
- Email destinations are managed on the [email inbox](./email.md).
