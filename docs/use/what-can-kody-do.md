# What can Kody do?

This page is a capability tour for people deciding whether Kody is worth setting
up — and for AI agents running a discovery conversation on someone's behalf.
Everything here is readable without a Kody account, and every link resolves on
GitHub, so an agent that can fetch URLs can follow the trail before any MCP
connection exists.

## What Kody is

Kody is a Fair Source personal assistant platform: its source is available to
inspect, and each version converts to the Apache License 2.0 after two years.
You do not chat with Kody directly: you connect the AI agent you already use
(Claude, ChatGPT, Cursor, Codex, or any other MCP-capable host) to your Kody
account, and that agent gains durable capabilities that outlive the conversation
and keep running while your computer is off. Kody makes no inference calls of
its own — your agent supplies the intelligence; Kody supplies memory,
credentials, saved code, schedules, and execution.

## The building blocks

- **Integrations and secrets** — bring your own API keys and OAuth apps for the
  services you already use. Credentials stay server-side and never enter your
  agent's context. See
  [Secrets, values, and host approval](./secrets-and-values.md).
- **Ad hoc execution** — your agent runs sandboxed code against those
  integrations immediately, no deploy step. See
  [Execute and workflows](./execute.md).
- **Scheduled jobs** — recurring or one-off automations that run in the cloud on
  Cloudflare Workers, whether or not any of your devices are on. Jobs are
  covered in [Execute and workflows](./execute.md) and
  [First steps](./first-steps.md).
- **Packages** — reusable saved code your agent writes and improves over time.
  Packages can expose exports, own scheduled jobs, run long-lived services, and
  even serve a small web app UI. See [Packages](./packages.md).
- **Workflows** — durable multi-step runs that survive restarts and can wait on
  external events. See [Workflows](./workflows.md).
- **A personal email inbox** — every user gets an address; inbound mail can
  trigger automations, and your assistant can send you notifications. See
  [Email primitives](./email-primitives.md).
- **Inbound webhook endpoints** — HTTPS URLs for Sentry, GitHub, Stripe, or any
  provider that cannot set Bearer tokens; each endpoint dispatches to a
  saved-package export. See [Inbound webhooks](./webhooks.md).
- **Long-term memory** — durable memories that surface across conversations and
  across every agent connected to the same account. See
  [Memory and conversation context](./memory.md).
- **Community packages** — browse automations other people published, and fork
  them into your own account with one click. See
  [Community packages](./community-packages.md).
- **Extensibility** — connect your own remote MCP servers, OpenAPI providers, or
  a local-network connector so your agent can reach devices at home through
  Kody.

## What people use it for

Concrete examples that combine the blocks:

- A morning digest job that gathers your calendar, weather, and feeds, then
  emails you a summary before you wake up.
- A watcher that polls a website, feed, or price and emails you only when
  something actually changes.
- Chore automation against services you already use — triaging GitHub
  notifications, filing issues, cleaning up cloud resources — using your own API
  keys.
- A personal API: a package export you can hit from shortcuts or webhooks to log
  a habit, save a link, or kick off a run.
- Home automation routines through a local-network connector — scenes,
  thermostats, speakers — driven by schedule or by asking your agent.
- Forking a community package (say, a YouTube video manager or an RSS digest)
  and having your agent adapt it to your needs.

## Running a discovery conversation

If you are an agent helping someone figure out whether Kody fits their life,
work through these steps:

1. Skim the building blocks and follow any links you need more detail on. The
   [usage index](./index.md) lists every page.
2. Interview the person: which services and tools do they use daily, which
   recurring chores do they do by hand, what have they wished happened
   automatically, and what should keep running when their computer is off?
3. Propose three to five specific opportunities, ranked by payoff versus setup
   effort. For each one, name the Kody pieces involved (an integration, a job, a
   package, the inbox) and the first concrete step.
4. Be clear about prerequisites: using Kody requires an account, an MCP-capable
   agent, and for third-party services, the person's own API keys or OAuth apps
   ([connection guide](./connect-your-agent.md)).

Nothing in this discovery flow requires an account or an MCP connection.

## Try it

Paste this into an agent that can fetch URLs or search the web:

> I'm deciding whether Kody (https://heykody.dev) would be useful for me. Read
> https://github.com/kentcdodds/kody/blob/main/docs/use/what-can-kody-do.md and
> follow its links for anything you need more detail on. Then interview me about
> the tools I use, recurring chores I do by hand, and automations I've wished
> for. Finish with 3–5 specific things Kody could do for me, ranked by payoff
> versus setup effort, each with a concrete first step. Don't set anything up
> yet — this works before I have an account.

When some of the proposals sound useful, the Get started page (`/onboarding`) on
the deployment walks through connecting your agent.
