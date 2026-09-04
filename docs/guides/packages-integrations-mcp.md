---
id: packages_integrations_mcp
title: Packages, integrations, and MCP servers
summary:
  Packages are saved behavior. Integrations are account-owned logins. MCP
  servers are how agents connect. Use this when those three look
  interchangeable.
category: platform
---

# Packages, integrations, and MCP servers

These three sit next to each other in the account UI and get used in the same
sentences. They are not the same thing.

## The short version

- **Packages** are behavior: saved code with exports, `kody.jobs`, webhooks,
  subscriptions (for example `email.message.received`), package apps, and
  helpers your agent calls through `execute`.
- **Integrations** are account-owned OAuth and credential wiring — reusable
  logins (Slack, GitHub, Google, …) that packages _use_. A package may say it
  needs an integration. It does not own the connection: you connect, refresh,
  lock, and revoke that login on the account.
- **MCP servers** are how agents connect: client and session wiring to talk to
  Kody, or for Kody to talk to another MCP server. They are not package runtime.
  Prefer packages as the capability surface agents reach _through_ Kody MCP.

A pasted API key is a **secret**, not an integration. Secrets stay yours;
packages and execute refer to them by name.

## Use this one when

| You want to…                                                                       | Use                |
| ---------------------------------------------------------------------------------- | ------------------ |
| Keep working code, a schedule, a webhook, or a helper export                       | A **package**      |
| Sign in to Slack / GitHub / Google so that code can act as you                     | An **integration** |
| Point Claude, Cursor, or ChatGPT at Kody — or add another MCP server Kody can call | An **MCP server**  |

Jobs and schedules live on the package (`kody.jobs`). Do not hang a cron off an
integration or an MCP connection.

## One example that uses all three

You want Slack messages to become a daily digest.

1. **Integration** — connect Slack on `/account/integrations`. That login is
   yours. Any approved package can use it; Slack itself is not a package.
2. **Package** — a helpers package calls Slack through that integration
   (`createAuthenticatedFetch`), exposes an export, and maybe a `kody.jobs` cron
   that posts the digest. Subscriptions can listen for events the same way.
3. **MCP** — your agent is connected to Kody as an MCP client. It finds the
   package with `search` and calls the export with `execute`. It does not talk
   to Slack's MCP, and the Slack integration is not a package.

Adding Slack as a remote MCP server on `/account/mcp-servers` is a different
job: that exposes Slack's tools as `kody.mcp["slack"]`. Prefer the integration
plus a package when you want owned helpers, jobs, or a stable export.

## Next

- [Package lifecycle](./package-lifecycle.md) — when to save vs execute vs fork
- [Integration bootstrap](./integration-bootstrap.md) — connect and smoke-test
  first
- [Connect your agent](../use/connect-your-agent.md) — Kody as the MCP server
- [Connect remote MCP servers](../use/mcp-client-servers.md) — Kody as the MCP
  client
