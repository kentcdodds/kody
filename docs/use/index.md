# Using Kody

Kody is the personal assistant platform for builders who would rather own their
automations than rent them.

Kody gives your AI assistant secure, reusable access to your services and lets
it run durable Worker-native automations while your computer is offline.

These docs are for people who connect their assistant to Kody over MCP. Setup
and repository development live elsewhere
([contributing docs](../contributing/index.md)). The in-app Get started page
(`/onboarding`) connects a host, gives that agent access, then proves the same
home works from a second agent. People with a Kody account can also
[join the Discord](https://kody.codes/discord).

Read in order for a full tour, or jump to a topic.

## Docs

The user-facing docs site is [kody.codes/docs](https://kody.codes/docs): an
introduction, Get started, Concepts, Packages, Integrations, and per-provider
connection walkthroughs. Every page is also raw markdown (`/docs/<slug>.md`),
indexed at [kody.codes/llms.txt](https://kody.codes/llms.txt), and available to
connected agents as `search({ entity: "{id}:guide" })`. The pages below are the
MCP-level reference detail those docs link into.

- [What is Kody?](../guides/what-is-kody.md) — the introduction: what Kody is
  and is not, what you cannot get elsewhere, the building blocks
- [Search and execute](../guides/search-and-execute.md) — the two MCP tools:
  find the right thing, then run it
- [Connect your agent](../guides/connect-your-agent.md) — the three-step Get
  started flow for people
- [Shared memory](../guides/memory.md), [Secrets](../guides/secrets.md), and
  [Jobs, workflows, and webhooks](../guides/triggers.md) — concept docs for the
  primitives every connected agent shares
- [Connect a provider](https://kody.codes/docs/connect) — verified walkthroughs
  for connecting Discord, GitHub, Google, and other providers to Kody
- [How Kody works](../guides/how-kody-works.md) — ask once, save an export,
  daily email only when something shipped
- [The Kody factory map](../guides/kody-factory.md) — the primitives your
  assistant gets and the boundary around local files and processes
- [Packages, integrations, and MCP servers](../guides/packages-integrations-mcp.md)
  — when those three look interchangeable
- [Gmail drafts without send](../guides/locked-gmail-drafts.md) — lock a
  drafts-only package when Google cannot issue a drafts-only token
- [Lock an MCP server to a package](../guides/locked-mcp-server.md) — keep
  `kody.mcp["name"]` off execute and other packages
- [Connect a home MCP server](../guides/local-mcp-tunnels.md) — run a local MCP
  process (vault, CLI, or home devices), publish it with Tunnel and Access, and
  connect it to Kody. Starter:
  [home-mcp-starter](https://github.com/kody-bot/home-mcp-starter)
- [Connect your agent (host notes)](./connect-your-agent.md) — per-host install
  steps and the setup prompt. Machine-readable twin:
  [`/auth.md`](https://kody.codes/auth.md)
- [Connect remote MCP servers](./mcp-client-servers.md) — add external MCP
  servers so Kody can call their tools (`kody.mcp[...]`)
- [First steps — what to ask Kody to do](./first-steps.md)
- [Search](./search.md)
- [Execute and workflows](./execute.md) — includes per-user MCP instruction
  overlays and package imports
- [Workflows](./workflows.md)
- [Packages](./packages.md)
- [Runtime and efficiency](../guides/platform-efficiency.md) — unique Dynamic
  Worker days by surface, and how a stable module graph reuses one isolate
- [Offload work that does not fit a Worker isolate](../guides/heavy-work-offload.md)
  — large npm graphs (PDF.js-class libraries) stay out of the package isolate;
  the owner operates a container or machine and the package calls it
- [Public packages](./community-packages.md) — share, browse, and fork published
  packages on the same deployment; public catalogs live at `/@username`
- [Repo-backed editing sessions](./repo-sessions.md)
- [Raw MCP content blocks](./raw-content-blocks.md)
- [Secrets and host approval](./secrets-and-values.md)
- [Email primitives](./email-primitives.md) — the per-user inbox, notify-self
  sends, and replies
- [Inbound webhooks](./webhooks.md) — user-owned HTTPS endpoints that dispatch
  provider POSTs to a saved-package export
- [Package apps](../guides/package-apps.md) — session handoff, `packageAppFetch`
  smoke, absolute asset URLs, lean forks
- [Package app fetch](./package-app-fetch.md) — platform-marked real-surface
  `app_fetch` smoke tests after publish
- [Synthetic event dispatch](./synthetic-event-dispatch.md) — platform-marked
  real-surface subscription handler smoke tests
- [Waiting](./waiting.md) — current-state items only you can clear
  (`/account/waiting` and `waitingSummary`)
- [Activity](./activity.md) — failures and recent runs for jobs, apps, webhooks,
  and other runtimes (`/account/activity` and the `runs` MCP capabilities)
- [Plans and pricing](https://kody.codes/pricing) — every plan is the whole
  factory; paid plans raise the caps
- [Mutating actions and confirmations](./mutating-actions.md)
- [Privacy](./privacy.md) — what Kody stores, how connected accounts work, and
  what deployment admins can see (Terms and Acceptable Use are in-app at
  [`/terms`](https://kody.codes/terms))
- [Troubleshooting](./troubleshooting.md) — `/support` and common MCP issues
- [Memory and conversation context](./memory.md)
- [Community Project mark](./community-project-mark.md) — logo for unofficial
  integrations and community-built tools

## Contributing to these docs

Authors and maintainers follow
[Documentation principles](../contributing/documentation.md). Usage pages stay
short; the MCP server favors concise tool descriptions and puts detail where it
belongs after each tool runs.
