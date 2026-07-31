# Using Kody

Kody is the personal assistant platform for builders who would rather own their
automations than rent them.

Kody gives your AI assistant secure, reusable access to your services and lets
it run durable Worker-native automations while your computer is offline.

These docs are for people who connect their assistant to Kody over MCP. Setup
and repository development live elsewhere
([contributing docs](../contributing/index.md)). The in-app Get started page
(`/onboarding`) walks through connecting a host for the first time.

Read in order for a full tour, or jump to a topic.

## Guides

- [What can Kody do?](./what-can-kody-do.md) — capability tour and discovery
  prompt for people (and agents) deciding whether Kody fits, before any setup
- [Connect your agent](./connect-your-agent.md) — add `{origin}/mcp`, complete
  OAuth, and use the setup prompt
- [First steps — what to ask Kody to do](./first-steps.md)
- [Search](./search.md)
- [Execute and workflows](./execute.md) — includes per-user MCP instruction
  overlays and package imports
- [Workflows](./workflows.md)
- [Packages](./packages.md)
- [Community packages](./community-packages.md) — share, browse, and fork
  published packages on the same deployment
- [Community profiles](./community-profiles.md) — public profiles, follows,
  timelines, and listing stars
- [Repo-backed editing sessions](./repo-sessions.md)
- [Raw MCP content blocks](./raw-content-blocks.md)
- [Secrets, values, and host approval](./secrets-and-values.md)
- [Email primitives](./email-primitives.md) — the per-user inbox, notify-self
  sends, and replies
- [Inbound webhooks](./webhooks.md) — user-owned HTTPS endpoints that dispatch
  provider POSTs to a saved-package export
- [Activity](./activity.md) — failures and recent runs for jobs, apps, webhooks,
  and other runtimes (`/account/activity` and the `runs` MCP capabilities)
- [Plans and pricing](https://heykody.dev/pricing) — Free and Pro prices and the
  finite limits enforced for each plan
- [Mutating actions and confirmations](./mutating-actions.md)
- [Privacy](./privacy.md) — what Kody stores and what deployment admins can see
  (Terms and Acceptable Use are in-app at [`/terms`](https://heykody.dev/terms))
- [Troubleshooting](./troubleshooting.md)
- [Memory and conversation context](./memory.md)
- [Community Project mark](./community-project-mark.md) — logo for unofficial
  integrations and community-built tools

## Contributing to these docs

Authors and maintainers follow
[Documentation principles](../contributing/documentation.md). Usage pages stay
short; the MCP server favors concise tool descriptions and puts detail where it
belongs after each tool runs.
