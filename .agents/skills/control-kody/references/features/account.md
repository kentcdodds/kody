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
Its popover lists orgs, Create organization, an invites row when you have any,
then a "Your account" group (Your profile, Account settings, Log out). Narrow
viewports show the same rows in the menu panel.

## How to get there

`/account` after login. Create an organization at `/account/organizations/new`
(`POST` the same path with `displayName` and `slug`); it redirects to the org
home at `/@<slug>`. Account deletion is `/account/delete`. Team-org settings and
members are `/@<slug>/-/settings` and `/@<slug>/-/members`.

A non-personal org handle (`/@<slug>`) renders the org home for its members and
404s for everyone else. Its resource pages stay 404 until storage follows
`request.org.id` (#3073). Team orgs still get an Organization rail: Settings
(`/@<slug>/-/settings`), Members (`/@<slug>/-/members`), and Billing
(`/@<slug>/billing`, owners; the page lands with #3135). Personal orgs keep
Billing/Usage on the account rail.

Resource pages (packages, secrets, jobs, and the rest) live under
`/@<slug>/-/…`. The old `/account/...` resource URLs redirect there for a short
time.

## Drive it

```bash
node tools/control-kody.ts login
node tools/control-kody.ts request GET /account/profile.json
node tools/control-kody.ts request GET /account/organizations.json
node tools/control-kody.ts request GET /@<slug>/-/settings.json
node tools/control-kody.ts request GET /@<slug>/-/members.json
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
