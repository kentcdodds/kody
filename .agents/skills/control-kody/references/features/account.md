# Account hub

Pages about the person, split from the org workspace:

- `/account` (Profile): name, avatar, email, onboarding banner.
- `/account/security`: password, links to two-factor and passkeys, sign-in
  providers (Connected accounts), former emails.
- `/account/organizations`: every org you belong to (Current marks the one the
  switcher is acting in), pending invites (`#invites`), and Create organization.
- `/account/experiments`: experiments opt-in.
- `/account/data`: export and delete account.

Usage and credits live on the org workspace at `/@:orgSlug/-/usage` (credits are
`#credits`). Legacy `/account/usage` and `/account/credits` redirect to the
personal org's usage page.

The account rail ("Account sections") lists those pages, then a Workspaces group
with one row per org (`@<slug>`, signup org first). A row opens that org's home:
the signup org's `/@<slug>/-/overview`, or a team org's `/@<slug>`. Every
workspace section is on a separate "Workspace sections" rail under
`/@<slug>/-/…`, so any section is two clicks from `/account`. That rail groups
Build (Repositories, Jobs, Webhooks), Credentials (Secrets, Integrations, MCP
servers, Secret providers), Agents & data (Agents, Memories, Email), Activity,
and Organization (Usage & credits and Billing for owners/billing admins).
Activity has Activity, Workflows, and Waiting as tabs under the page title
(`data-testid="account-section-tabs"`, labelled "Activity pages"); the rail item
stays current on all three. Repositories is `/@<slug>/-/repositories`, distinct
from the public profile at `/@<slug>`. Former `/@<slug>/-/packages` URLs 301 to
`/repositories` (query preserved). The signup org's Overview
(`/@<slug>/-/overview`) is a card for every workspace section; a team org's
overview URL redirects to its home at `/@<slug>`. Both rails come from
`account-rail.ts` and render through `AccountPageHeader` in
`packages/worker/client/routes/account-management-components.tsx`. Below 860px a
rail collapses to a `<details>` menu.

The org switcher is the Workspace rail's heading: under the "Workspace" label,
the org name is a button (`data-testid="org-switcher"`, "@slug: switch
organization", panel `org-switcher-panel`) that lists orgs (avatar, `@slug`,
role, check on the rail's org), then Create organization and an invites row when
you have any. Each org row keeps the current section when that org can open it,
otherwise it opens that org's workspace home (`workspaceSwitchHref`). Below
860px the same switcher is the first item in the rail's `<details>` drawer
(`org-switcher-drawer`, panel `org-switcher-drawer-panel`). The account rail has
no switcher; its Workspaces group lists every org. Source:
`packages/worker/client/workspace-switcher.tsx`.

The site header has one session control, the account menu
(`data-testid="account-menu"`, panel `account-menu-panel`): the person's avatar,
name and `@username`, then a **Manage** group (`account-menu-manage-group`) with
one `@<slug>` row per org (person icon for the signup org, people icon for
teams), the current org first. Each row opens that org's workspace home (team
`/@<slug>`, signup org `/@<slug>/-/overview`). Then Your profile, Account
settings, Usage & credits (current org from the URL only, else the personal
org), and Log out. So pages without a workspace rail (packages, org homes,
account pages) still reach every org. Narrow viewports fold the account menu
into the one menu panel (`site-menu-account`: Manage, then a "Your account"
group). Own profile (`/@<username>`) also links **Workspace** (lands on
`/@<slug>/-/repositories`) beside Edit profile. A team org home lists
**Workspace** above its management links.

## How to get there

`/account` after login. Create an organization at `/account/organizations/new`
(`POST` the same path with `displayName` and `slug`); it redirects to the org
home at `/@<slug>`. Account deletion is `/account/delete`. Team-org settings,
members, teams, grants, and collaborators are `/@<slug>/-/settings`,
`/@<slug>/-/members`, `/@<slug>/-/teams`, `/@<slug>/-/grants`, and
`/@<slug>/-/collaborators`.

A non-personal org handle (`/@<slug>`) renders the org home for its members and
404s for everyone else. Secrets, jobs, and the other org resource pages read
`request.org.id`. Agents (`/@<slug>/-/agents`; old `/-/connections` URLs 301
there) lists the viewer's own agents approved for that org (members and
grant-only collaborators). Repositories (`/@<slug>/-/repositories`) lists the
packages a team org owns that the member can see (Owners see all, other roles
see what their grants and teams give them); rows do not link to a package page
yet. A team org's Organization group lists Members (with Members, Teams for
owners/members, Collaborators, and Grants as tabs), Settings, and Billing
(`/@<slug>/-/billing`, owners and billing users). A personal org's Organization
group lists Grants and Billing. The org home and `/account/organizations` also
link into those sections. The switcher keeps the current page in the destination
org when that role can open it there (for example Secrets to Secrets);
otherwise, and from a page with no org section (such as `/account`), it opens
that org's home.

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
- `POST /logout` (Log out in the account menu)

## Gotchas

- Seed users start empty. Profile fields exist; packages/secrets/jobs do not
  until you create them.
- A successful `POST /account/delete` clears the session and the account page
  navigates to `/?accountDeleted=1`. The homepage status
  `data-testid="account-deleted-notice"` reads "Your Kody account has been
  deleted". Do not delete the shared preview seed to prove this.
- Connected agents (inbound MCP hosts) are a workspace page:
  [connections](./connections.md) at `/@<slug>/-/agents`.
- Linking a sign-in provider returns to `/account/security?oauthLinked=<id>`.
- Former-address release is `POST /account/email-claim-release.json`, then
  confirm at `/verify-email-claim-release`. It drops the claim without reminting
  `users.stable_user_id`.
- Email destinations are managed on the [email inbox](./email.md).
