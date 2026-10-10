# Integrations concept

## Core idea

Headline: **Connect an account. Put it to work.**

Pitch: **Keep your service connections in Kody, then use packages to turn them
into the tools and workflows you need.**

Primary action: **Connect a service** → `/account/integrations` Secondary
action: **See how setup works** → `/docs/oauth`

The page should feel like plugging a useful appliance into a shared power
source. Its subject is the reusable connection, with a visible distinction
between who you signed in as and what the calling package does. Avoid a logo
wall, connector count, or workflow-builder canvas.

## Distinctive visual and interaction

Build a large, quiet connection selector, styled as a single horizontal service
row that unfolds into account rows. This reflects the actual integrations UI
rather than inventing another product. Green lantern light,
`oklch(0.66 0.19 148)`, follows the selected account through one thin continuous
line to the package using it. Bricolage Grotesque for the title and Wix Madefor
Text for supporting copy.

Example at rest:

Google `google-personal` Personal account `google-work` Work account

Selected account detail: Signed in as `alex@company.example` Used by
`weekly-brief` Action `Read upcoming calendar events`

A small control lets visitors switch **Personal** / **Work**. Changing it
changes the selected connection, example email, and resulting calendar excerpt.
Keep package behavior fixed so the interaction teaches that a connection
supplies identity and authorization, while the package supplies the action. Use
fabricated event data and mark the whole visual **Example connection** once.
Never imply this selector changes a visitor's real account.

The graphic is not a network of glowing logos. It is an unfolded service table
and a single connected output sheet, with one small koala holding the lantern
beside the selected account. The light is green, the surfaces remain warm
neutral. On narrow screens the account selector sits above the result with the
path running vertically.

## Four page beats and copy

### 1. Choose the account you mean

Use the headline and pitch above, with the unfolding account visual as the hero.

Supporting line attached to the account selector: **Personal account or work
account, give each connection a name your agent can find.**

Evidence shown in the visual: saved connection name, selected account, package
name, and a small calendar result. No decorative success counters or generic
capability badges.

### 2. A connection supplies access. A package does the work.

Use a split sentence across the existing connection line, not two feature cards:

**Your Google connection signs in.** **Your calendar package reads the events.**

Body: **Reuse a saved connection across packages. Find a community package to
adapt, or build a small one for the calls you need.**

Action: **Explore packages** → `/features/packages`.

A short inline disclosure: **Connecting a service does not install its tools.**
This earns its space by correcting a common product misunderstanding. Do not
repeat it elsewhere.

### 3. Connect it, then check it

A three-step setup strip, with an expandable detail rather than a sales section:

1. **Choose the service.** Your agent helps find the right authorization setup.
2. **Finish sign-in.** Use a built-in app when one is available, or register
   your own provider app.
3. **Test a small request.** Confirm the connection works before building a
   workflow around it.

Disclosure link: **What does registering an app involve?** Expanded copy:
**Create an OAuth app with the provider, add Kody's redirect URL, and enter the
client details in Kody. The provider and the permissions you need determine the
setup.**

Action: **Read the OAuth setup guide** → `/docs/oauth`.

This is an honest setup explanation, not an interactive fake authorization flow.
Do not put a working-looking Connect Google button inside the demonstration.

### 4. Choose which packages can use it

Show the same account row, now with a compact usage detail. Selected state:
**Specific packages**. Granted package: `gmail-drafts`. A small output reads
**Draft saved for review**.

Copy: **Restrict a connection to specific packages. Lock the published package
too when its behavior needs to stay fixed.**

A precise caption: **For example, a drafts-only package can create Gmail drafts
without exposing a send action. Google's token still has the permissions Google
issued.**

Action: **See the Gmail draft example** → `/docs/locked-gmail-drafts`.

Do not make the restriction a one-click toy that implies a full safety setup.
The illustration shows the resulting state and links to the actual guide. The
guide requires a narrow package, publish lock, integration usage lock, and
verification. Unlocking or removing integration grants happens on the website.

## Audience relevance

Personal: name multiple service accounts and reuse each connection in personal
helpers. Example: read the upcoming calendar through a selected Google account.

Business: share a live package with a person or team using resource grants. Use
grants let people read and run the package without sharing a login. Package
access and connection usage restrictions are separate controls. Explain this
through the package link, rather than adding a second sharing UI to this page.

Enterprise: the useful current story is organization-owned resources, explicit
resource grants, named packages, and restricted connection use. Do not advertise
SSO, SCIM, compliance certifications, audit retention, organization-wide
connection catalogs, or centralized enterprise provisioning without further
evidence. Current grants provide a grounded team access story, not a claim of a
complete enterprise integration suite.

## Search-intent hypotheses

These are editorial hypotheses, with no keyword volume claims:

- “connect AI agent to Google account” seeks a concrete setup path, met by the
  service/account example and OAuth guide.
- “reuse OAuth connections across AI workflows” seeks less repeated setup, met
  by the connection/package distinction.
- “AI agent multiple Google accounts” seeks identity selection, met by named
  personal/work connections.
- “restrict AI access to Gmail drafts” seeks narrower behavior than provider
  scopes allow, met by the linked lock example.
- “OpenAPI tools for AI agents” seeks a package construction path, met by a
  low-page documentation link rather than a broad compatibility promise.

Suggested title: **Integrations for your AI workflows | Kody** Suggested
description: **Save service connections in Kody, reuse them through packages,
and choose which packages can use them. Connect with OAuth and verify access
before you build.**

## Evidence and claim boundaries

- `docs/guides/packages-integrations-mcp.md`: integrations are reusable auth,
  packages own behavior, remote MCP servers are separate. API keys are secrets.
  Do not merge all of these into a connector marketplace.
- `docs/guides/oauth.md`: multiple named connections, service rows unfold into
  account connections, saved reconnect metadata, host-side token refresh,
  built-in apps for enabled and published providers, otherwise bring your own
  app. A blanket “no app setup” promise is false, and so is a blanket “every
  provider needs your own app.” Availability must be checked before naming any
  provider as built-in.
- `docs/guides/integration-bootstrap.md`: research, complete auth, perform a
  real authenticated smoke test, then find or create a helper package. Do not
  treat the connected state as proof a finished workflow exists.
- `docs/guides/openapi-integrations.md`: prefer existing helpers, otherwise fork
  `@kody/openapi` and select operations; custom narrow clients remain possible
  where the binder does not fit. Do not imply any arbitrary API automatically
  becomes a complete integration, or that imported specs grant hosts.
- `docs/guides/locked-gmail-drafts.md`: usage lock restricts a connection to
  specified package IDs, ad hoc execute and other packages are denied, grants
  accumulate, website-only removal/unlock. Publish lock holds behavior; OAuth
  permissions do not shrink.
- `docs/guides/package-sharing.md`: resources live in one org; user/team
  resource grants; package Use includes source read and execute; no preset
  grants secret reveal; outside collaborators can run granted packages;
  cross-org imports are not supported. Avoid language implying package Use hides
  source or hands over raw credentials.

## Related links

Feature routes: `/features/packages`, `/features/secrets`, `/features/triggers`.
Docs: `/docs/packages-integrations-mcp`, `/docs/oauth`,
`/docs/integration-bootstrap`, `/docs/openapi-integrations`,
`/docs/locked-gmail-drafts`, `/docs/package-sharing`. Public package examples
documented in the repo: `https://kody.codes/@kody/openapi`,
`https://kody.codes/@kody/integrations-sh`,
`https://kody.codes/@kody/api-research`.

## Accessibility and motion

Account selection uses native radio controls with visible labels and keyboard
operation. The expanded connection details follow their controlling row in DOM
order. Announce only the changed account/result, not an entire animated diagram.
The path and lantern are decorative and hidden from assistive technology. Green
is supported by selected labels and a check mark, with verified text contrast.
No scroll hijacking, drag dependency, hover-only explanations, or looping
movement. Reduced motion removes path travel and transitions, keeping the fully
connected static state. The example remains understandable without JavaScript.
