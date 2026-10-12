# Proposal: navigation

- **Status:** proposal (research only, no code)
- **Date:** 2026-10-12
- **Baseline:** `main` at `14d7e66ff` (includes #3503, the Workspace door in the
  account rail and menu)
- **Inputs:** platform feedback `bcf87731` and `c5c78802` from @cameronpak (the
  same report, submitted twice), #3287, #3213, #3216, #3217, #3229, #3503, #3382
  (open), #3168, and
  [ADR 0068](../contributing/decisions/0068-credentials-own-placement-scoped-clients.md)

## TL;DR

Kody's web navigation should rest on three places, and the URL prefix tells you
which one you are in:

1. **You** (`/account/…`): who you are, how you sign in, what you pay in
   credits, and which organizations you belong to.
2. **Workspace** (`/@slug/-/…`, with its home at `/@slug`): everything an
   organization owns. A personal org and a team org have **the same sidebar**,
   and the only differences come from your role (permissions), never from the
   kind of organization.
3. **Public** (`/@slug`, `/@owner/<kody-id>`, `/community`, `/docs`): what
   anyone can see.

The header carries one control per concept: a **workspace switcher** beside the
logo ("where am I") and an **avatar menu** ("who am I"). The switcher has one
rule: keep the same section if you can open it in the target org, otherwise open
that org's home. Secrets, Integrations, MCP servers, and Secret providers merge
into one **Credentials** section. The page now called Connections becomes
**Agents**. Every renamed URL gets a permanent redirect.

## Why now

@cameronpak's feedback (`bcf87731`, duplicate `c5c78802`, both triaged):

> Since the organizations change, I cannot find my MCP servers. I opened the
> account menu, clicked Account settings, and checked Profile, Data and
> deletion, Organizations, and Security. Nothing. I opened the menu a second
> time, clicked my cameronpak org, and landed on the org Billing page. Only then
> did a new sidebar appear with MCP servers under Access.

#3503 fixed that exact trail by adding a Workspace group to the account rail and
an Overview page. It works, but it is the sixth fix of the same kind in a few
weeks: #3216 and #3229 (team Connections and Repositories), #3217 (team rail
missing Secrets and Jobs), #3287 (switcher dropped the section), #3503
(Workspace door), and #3382 (another Workspace door, still open). Each fix added
a door in one more place. The cause is structural: the set of sections you see
depends on _which page you are on_ and _what kind of org it is_, and six
different places each keep their own list.

## Audit: what exists today

All paths come from `packages/worker/universal/routes.ts`. Nav lists come from
`packages/worker/client/routes/account-rail.ts`,
`packages/worker/client/site-header.tsx`,
`packages/worker/client/routes/org-home.tsx`, and
`packages/worker/client/routes/org-overview.tsx`.

### Page routes

**Person pages (`/account`)**

| Page              | Path                                                               |
| ----------------- | ------------------------------------------------------------------ |
| Profile           | `/account`                                                         |
| Security          | `/account/security`, `/account/two-factor`, `/account/passkeys`    |
| Organizations     | `/account/organizations`, `/account/organizations/new`, `#invites` |
| Experiments       | `/account/experiments`                                             |
| Data & deletion   | `/account/data`                                                    |
| Usage and credits | `/account/usage` (`/account/credits` redirects to `#credits`)      |
| MCP OAuth clients | `/account/mcp-oauth-clients`                                       |
| Package detail    | `/account/packages/:packageId` (redirects to `/@owner/:kodyId`)    |
| Package approval  | `/account/packages/:packageId/approve-publish`                     |
| MCP server OAuth  | `/account/mcp-servers/oauth/callback` (not a page; #3213)          |

**Workspace pages (`/@:orgSlug/-/…`)**, from `orgOwnedAccountSections` in
`universal/org-pages.ts`, plus billing, overview, and management:

| Section          | Path                                      | Notes                                         |
| ---------------- | ----------------------------------------- | --------------------------------------------- |
| Overview         | `/@slug/-/overview`                       | Team orgs redirect to `/@slug` (#3503)        |
| Repositories     | `/@slug/-/packages`                       | Index only; label says Repositories           |
| Jobs             | `/@slug/-/jobs(/*rest)`                   |                                               |
| Workflows        | `/@slug/-/workflows(/*rest)`              |                                               |
| Webhooks         | `/@slug/-/webhooks`                       | Index only                                    |
| Connections      | `/@slug/-/connections(/*rest)`            | Connected agents (inbound MCP hosts)          |
| Integrations     | `/@slug/-/integrations(/*rest)`           | OAuth connections                             |
| MCP servers      | `/@slug/-/mcp-servers(/*rest)`            | Plus `/:serverId/authorize` (agent `authUrl`) |
| Secrets          | `/@slug/-/secrets(/*rest)`                |                                               |
| Secret providers | `/@slug/-/secret-providers(/*rest)`       | Vaults such as 1Password                      |
| Values           | `/@slug/-/values(/*rest)`                 | Retired drain, not in nav                     |
| Memories         | `/@slug/-/memories(/*rest)`               |                                               |
| Email            | `/@slug/-/email(/*rest)`                  |                                               |
| Activity         | `/@slug/-/activity(/*rest)`               |                                               |
| Waiting          | `/@slug/-/waiting(/*rest)`                |                                               |
| Billing          | `/@slug/-/billing`, `/success`, `/portal` |                                               |
| Settings         | `/@slug/-/settings`                       | Personal orgs point at `/account`             |
| Members          | `/@slug/-/members`                        |                                               |
| Teams            | `/@slug/-/teams`                          |                                               |
| Grants           | `/@slug/-/grants`                         |                                               |
| Collaborators    | `/@slug/-/collaborators`                  |                                               |

**Public and package pages**

| Page                 | Path                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Profile or org home  | `/@slug` (personal: public profile; team: members-only home, 404 for others)                                                              |
| Package              | `/@owner/:kodyId`, `/files(/*path)`, `/tree/:ref/*`, `/raw/:ref/*`, `/settings`, `/approve-publish`                                       |
| Community listing    | `/community`, `/community/:listingId` (redirects to the canonical package URL)                                                            |
| Invite               | `/join/:token`                                                                                                                            |
| Agent-facing connect | `/connect/oauth`, `/connect/secrets`, `/connect/secret-set`, `/connect/webhook-apply`                                                     |
| Docs                 | `/docs`, `/docs/:slug`, `/docs/connect` (`/guides/*` redirects)                                                                           |
| Marketing            | `/`, `/features/*`, `/pricing`, `/blog`, `/faq`, `/use-cases/*`, `/compare/*`, `/integrations/*`, `/for/business`, `/support`, `/discord` |
| Admin                | `/admin/*`                                                                                                                                |

Package-app mounts (`/@owner/packages/…`) and webhook ingress
(`/@owner/webhooks/…`) share the `/@` namespace but are not navigation.

### Navigation entry points

There are six places that list workspace sections, each with its own subset:

1. **Account rail** (`accountRailGroups`, on the five person pages): Profile,
   Security, Organizations, Experiments, Data & deletion, then a Workspace group
   for the **signup org only**: Overview, Repositories, Connections, MCP
   servers, Secrets, Jobs, Memories (7 of 16).
2. **Workspace rail, personal org** (`workspaceRailGroups`, `personal: true`):
   Overview; Build: Repositories, Jobs, Workflows, Webhooks; Access:
   Connections, Integrations, MCP servers; Data: Secrets, Secret providers,
   Memories, Email; Activity: Activity, Waiting; Organization: Billing, Usage
   (16 items).
3. **Workspace rail, team org** (`personal: false`): Build: Repositories, Jobs;
   Access: Connections; Data: Secrets; Organization: Settings, Members, Teams,
   Grants, Collaborators, Billing (4 sections plus up to 6 management links).
   Grant-only collaborators: Connections only.
4. **Workspace overview** (`/@slug/-/overview`): cards for the personal rail's
   groups. Team orgs redirect to `/@slug`.
5. **Team org home** (`/@slug`, `renderOrgHomeMain`): management links plus a
   "Get started" card with Repositories, Jobs, Connections, Secrets.
6. **Header menu** (`OrgSwitcher` in `site-header.tsx`): org rows, then "Manage
   @x" (Overview plus team management links, or Overview and Billing for
   personal-only users), Create organization, Invites, then Your profile,
   Account settings, Log out.

The header itself shows the marketing links (Community, Docs, Pricing, Blog)
whether or not you are signed in; the avatar menu is the only way into the app.
`/account/organizations` rows open an org's overview.

## Confusions, with evidence

1. **The same URL shape shows a different sidebar depending on the org kind.**
   `/@me/-/secrets` shows 16 items; `/@acme/-/secrets` shows 4 sections plus
   management. Nothing on screen explains why.
2. **The team rail hides pages the server opens.** `orgSectionDenial` in
   `src/app/org-request-binding.ts` closes sections only to grant-only
   collaborators. Members can load `/@acme/-/mcp-servers`, `/-/memories`,
   `/-/integrations`, `/-/workflows`, `/-/webhooks`, `/-/email`, `/-/activity`,
   and `/-/waiting`, but no team nav links them. #3213 shows team MCP servers
   are real (`/@acme/-/mcp-servers/<id>`). This is cameronpak's problem again,
   for team orgs: the page exists and nothing points at it.
3. **The org home is in two places.** For a personal org, `/@slug` is the public
   profile and the workspace home is `/@slug/-/overview`. For a team org,
   `/@slug` is the home and `/-/overview` redirects to it. The switcher needs
   four branches in `teamOrgSwitchHref` (personal goes to overview, collaborator
   goes home, billing page without billing role goes to Settings, billing role
   on Teams goes to Settings) to hide this.
4. **One menu mixes "where am I" with "who am I."** The avatar is both the org
   switcher and the account menu. Its Manage group picks an org with
   `manageOrganization`: the current team org, else the last-used team, else the
   first team. So on `/account` a person with a team sees "Manage @acme" even
   when they were last working in their personal org. Before #3503, clicking
   your own org landed on Billing, which is exactly where cameronpak found MCP
   servers by accident.
5. **"Connections" means three things.** `/@slug/-/connections` lists connected
   agents (inbound MCP hosts). `/account/connections.json` is the sign-in
   providers list ("Connected accounts" on Security). ADR 0068 and
   `/connect/oauth` call OAuth integrations "connections." The comment on
   `accountConnectionsApi` in `routes.ts` has to explain the split.
6. **Credentials are spread over five pages.** Secrets, Integrations, MCP
   servers, Secret providers, and Values (hidden) are separate sections, and
   Grants is a sixth place that touches them. ADR 0068 makes these one primitive
   (a credential of kind `secret`, `oauth`, or `mcp`, with
   `source: 'stored' | { vault, ref }`), and #3479 adds personal credentials
   granted to orgs. The nav has no home for "my personal credential, granted to
   @acme."
7. **Packages are called three names.** The rail says Repositories, the URL is
   `/-/packages`, and docs, marketing (`/features/packages`), MCP
   (`packageGet`), and Community say packages. The personal public profile also
   has a "Repositories" heading, so there are two lists with the same name. Team
   Repositories rows do not link to the package page yet (feature map,
   `account.md`).
8. **Scope leaks between rails.** Usage (`/account/usage`, a person's credit
   wallet) sits in the workspace rail's Organization group. Connections stays
   active on `/account/mcp-oauth-clients`. The account rail repeats 7 workspace
   items for the signup org only, so a team member has no door to their team's
   sections from `/account` except the Organizations page.
9. **Old URLs 404.** #3168 removed the `/account/<section>` redirects on Kent's
   call, so bookmarks from before orgs (for example `/account/mcp-servers`)
   now 404. Every further rename without a redirect would repeat that.
10. **Two settings pages for one identity.** A personal org's name and avatar
    are the person's profile, so `/@me/-/settings` points at `/account`.

## Principles for the proposal

- **The URL prefix is the scope, and the sidebar matches the URL.** `/account`
  shows the account sidebar. `/@slug/-/…` and a member's `/@slug` show the
  workspace sidebar. A page never borrows the other sidebar.
- **One section table drives everything.** The server's section gate, the
  sidebar, the org home cards, and the switcher read one list of sections, each
  with the permission that opens it. A page that opens is a page that is linked.
- **Org kind is not a nav input.** Personal and team orgs show the same
  sections. Items that make no sense without other people (Members, Settings)
  are absent from a personal org because the permission or data is absent, not
  because of a `personal` branch.
- **One name per concept.** Packages, Credentials, Agents.
- **Every renamed URL redirects, permanently.**

## Proposed information architecture

### Sitemap

```
/                                   marketing home
/community · /docs · /pricing · /blog · …   public

/account                            YOU (account sidebar)
  /account                          Profile
  /account/security                 Security: password, two-factor, passkeys, sign-in methods
  /account/usage                    Usage & credits
  /account/organizations            Organizations (+ /new, #invites)
  /account/experiments              Experiments
  /account/data                     Data & deletion

/@slug                              ORG HOME
                                    members: workspace home (sidebar, what needs you, sections, public preview)
                                    everyone else: public profile (personal) or 404 (team, as today)
/@slug/-/packages                   Packages
/@slug/-/jobs                       Jobs
/@slug/-/webhooks                   Webhooks
/@slug/-/credentials                Credentials: secrets, OAuth, MCP servers; tabs for Vaults
/@slug/-/credentials/:id            one credential (hosts, inject, Use grants, org grants)
/@slug/-/agents                     Agents (connected MCP hosts and their OAuth clients)
/@slug/-/memories                   Memories
/@slug/-/email                      Email
/@slug/-/activity                   Activity, tabs: Runs · Workflows (/-/workflows) · Waiting (/-/waiting)
/@slug/-/members                    Members, tabs: Members · Teams (/-/teams) · Collaborators (/-/collaborators) · Grants (/-/grants)
/@slug/-/billing                    Billing
/@slug/-/settings                   Settings (team orgs)

/@owner/<kody-id>                   PACKAGE (tabs: Overview · Files · Settings)
/admin/*                            admin
```

Tabs link to existing URLs, so grouping Workflows and Waiting under Activity,
and Teams, Collaborators, and Grants under Members, changes no URL.

### Header

| Signed out                                        | Signed in                                            |
| ------------------------------------------------- | ---------------------------------------------------- |
| Logo · Community · Docs · Pricing · Blog · Log in | Logo / **@slug ▾** · Community · Docs · **avatar ▾** |

- **Workspace switcher (`@slug ▾`, beside the logo).** Lists your orgs (personal
  first, role labels when there is more than one), then Create organization and
  Invites. On `/account` pages it shows the last-used org, so the current
  context is always visible. Clicking an org follows one rule: the same section
  if you can open it there, otherwise that org's home.
- **Avatar menu.** Your profile (`/@me`), Account settings, Usage & credits, Log
  out (and Admin for admins). No org rows and no Manage group: the sidebar does
  that job.

### Workspace sidebar

One list, filtered by permission:

| Group        | Items                    | Personal org            | Team member / owner | Grant-only collaborator |
| ------------ | ------------------------ | ----------------------- | ------------------- | ----------------------- |
| (none)       | Home                     | yes                     | yes                 | yes                     |
| Build        | Packages, Jobs, Webhooks | yes                     | yes                 | no                      |
| Access       | Credentials, Agents      | yes                     | yes                 | Agents only             |
| Data         | Memories, Email          | yes                     | yes                 | no                      |
| Activity     | Activity                 | yes                     | yes                 | no                      |
| Organization | Members                  | no members              | yes                 | no                      |
|              | Billing                  | yes                     | owner / billing     | no                      |
|              | Settings                 | no (it is your Profile) | yes                 | no                      |

That is 10 items for a personal org and 12 for a team org, down from 16 and 10.
The header names the org (`@slug`) above the groups, as today. Below 860px the
sidebar keeps collapsing to a `<details>` menu.

### Account sidebar

Profile, Security, Usage & credits, Organizations, Experiments, Data & deletion,
then a **Workspaces** group with one row per org (avatar and handle), each
linking to that org's home. This replaces the 7-item Workspace group from #3503:
it is a door to every org instead of a copy of one org's sections, and any
section is still two clicks from `/account` (Workspaces row, then sidebar item).
MCP servers become a credential kind, so cameronpak's path is `/account` →
`@cameronpak` → Credentials.

### Org home (`/@slug`)

Members of any org, personal included, see the workspace home: the sidebar, a
"Needs you" strip from Waiting, the section cards that the overview page shows
today, and the public profile content (bio, public packages) with a "View as
public" link (`/@slug?view=public`). Everyone else sees what they see today.
`/@slug/-/overview` redirects to `/@slug`. This keeps the constraint that the
org home stays `/@slug` and removes the second home.

### Credentials

`/@slug/-/credentials` is one list with a kind filter (Secret, OAuth, MCP
server) and one "Add credential" button that opens the existing connect flows. A
Vaults tab holds what Secret providers holds today, because a vault is a
credential `source`, not a separate thing. Rows show `hosts` and who can Use
them. In a team org, your personal credentials granted to that org appear badged
"Personal, granted here". In your personal org, each personal credential lists
the orgs it is granted to. Values stays out of the nav; if leftovers exist, a
banner on Credentials links to `/-/values`. Agent-facing pages
(`/connect/oauth`, `/connect/secrets`, `/connect/secret-set`) keep their URLs.

### Package pages

`/@owner/<kody-id>` stays public-shaped, with no workspace sidebar, so a shared
link looks the same for everyone. When you are a member of the owner org, the
breadcrumb reads `@owner › Packages › <kody-id>` and links back to the workspace
list; otherwise it reads `@owner › <kody-id>`. Package rows on `/-/packages`
link to the package page in every org.

## What moves or merges

| Today                                                | Proposed                                | URL change                     |
| ---------------------------------------------------- | --------------------------------------- | ------------------------------ |
| Secrets, Integrations, MCP servers, Secret providers | Credentials (Vaults tab)                | yes, redirects                 |
| Connections (connected agents) + MCP OAuth clients   | Agents                                  | `/-/connections` → `/-/agents` |
| "Connected accounts" on Security                     | "Sign-in methods"                       | no                             |
| Repositories (label)                                 | Packages                                | no                             |
| Overview (`/-/overview`)                             | Org home at `/@slug`                    | redirect                       |
| Workflows, Waiting (sidebar items)                   | Tabs on Activity                        | no                             |
| Teams, Collaborators, Grants (sidebar items)         | Tabs on Members                         | no                             |
| Usage in workspace rail                              | Account sidebar and avatar menu         | no                             |
| Manage group in avatar menu                          | Removed (sidebar)                       | no                             |
| Account rail Workspace group (7 items, signup org)   | Workspaces group (one row per org)      | no                             |
| Personal `/@me/-/settings`                           | Not in sidebar; redirects to `/account` | redirect                       |

## Migration plan

Each step is one PR, ships on its own, and keeps every old link working. All
org-path redirects are pure path rewrites that keep the slug, so they are 308s.
They live in one table, `legacy-org-section-redirects.ts`, with a unit test per
row, and they stay permanently: emails, agent transcripts, and MCP tool output
already hold these URLs, and a redirect row costs nothing.

1. **One section table and one sidebar (no URL changes).** Add a
   `workspaceSections` table (section, label, group, permission) that
   `orgSectionDenial`, the sidebar, org home cards, and the switcher all read.
   Delete the personal/team split in `workspaceRailGroups`. Add the Activity and
   Members tabs. Move Usage to the account sidebar. Before listing a section for
   team orgs, confirm with an e2e that its data reads the URL org (memories and
   email especially). Tests: a unit test that the sidebar equals the set the
   server opens for each role, and an e2e that every section is reachable within
   two clicks from `/account` for a personal and a team user. Door: two-way.
2. **One org home.** Members see the workspace home at `/@slug` for every org;
   add `?view=public`. Redirect `/@slug/-/overview` to `/@slug`. Replace the
   account rail's Workspace group with the Workspaces list. Close #3382 as
   superseded. Door: two-way.
3. **Split the header.** Workspace switcher beside the logo, avatar menu for the
   person, no Manage group. Replace `teamOrgSwitchHref` with the single rule
   (same section if open to you, else the org home). Update the `org-switcher`
   and `account-navigation` e2e specs. Door: two-way.
4. **Connections becomes Agents.** Add `/@slug/-/agents(/*rest)`, 308 from
   `/@slug/-/connections(/*rest)`, and update link producers (org home, docs,
   emails). Move the MCP OAuth clients page under it as a tab, keeping
   `/account/mcp-oauth-clients` as a redirect. Rename "Connected accounts" to
   "Sign-in methods." JSON routes do not change. Door: two-way, thanks to the
   redirects.
5. **Repositories becomes Packages.** Rename the label, link team package rows
   to `/@owner/<kody-id>`, and add the package breadcrumb. Door: two-way.
6. **Credentials (lands with the credentials UI in ADR 0068).** Add
   `/@slug/-/credentials(/*rest)`. Redirect `/-/secrets`, `/-/integrations`,
   `/-/mcp-servers`, and `/-/secret-providers` (index and `/*rest`). If
   credential ids reuse the legacy row ids (check the credentials schema),
   detail paths map one to one (`/-/secrets/:id` → `/-/credentials/:id`);
   otherwise they redirect to the list filtered by kind and name. Keep
   `/-/mcp-servers/:serverId/authorize` as a working route aliased to the
   credential's authorize page, not a redirect, because agents hand this
   `authUrl` to people and the consent page posts back to it. Land the #3213
   callback fix (resolve the org from the `serverId` in `state`) first, since
   team MCP servers become as visible as personal ones. Door: one-way for the
   public URLs, made safe by permanent redirects.
7. **Decision for Kent: restore `/account/<section>` redirects.** #3168 removed
   them on purpose. They could be one more block in the same table (302 to the
   signed-in person's personal org section, since the target depends on the
   session). This would fix old bookmarks like cameronpak's
   `/account/mcp-servers`. Ship only if Kent wants it.

## Alternatives considered

**A. Move the workspace back under `/account`, with an org picker.** For example
`/account/secrets?org=acme`, or an account hub that lists every org's resources.
Rejected: it breaks the `/@slug/-/<section>` constraint and makes team URLs
unshareable. It also turns the org into a hidden query or cookie state, which is
the "invisible context switch" cameronpak complained about. Org binding would go
back to guessing from the Referer and cookies instead of the path.

**B. Keep today's model and keep adding doors.** That means a Workspace group
here, a Manage link there, an overview card elsewhere. This is the current
trajectory (#3216, #3217, #3229, #3287, #3382, #3503) and it works one complaint
at a time. Rejected: every new section needs edits in six lists that already
disagree, and the visible sections depend on org kind rather than permission.
That is the "edge case to remember" Kent wants gone, and Credentials would make
it worse by adding personal-credential grants as a new dimension.

## Open questions for Kent

1. Is it OK that your own `/@slug` shows the workspace home to you, with "View
   as public" for the public profile?
2. Should Email and Memories be team sections (a shared inbox and shared
   memories), or person-only? The section table can say either. What matters is
   that the server and the sidebar agree.
3. Usage and credits: they are per person today (`/account/usage`). Should they
   stay with the person once team seats are common, or move to `/@slug/-/usage`
   beside Billing?
4. Restore `/account/<section>` redirects (migration step 7)?
