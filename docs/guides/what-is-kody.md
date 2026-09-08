---
id: what_is_kody
title: What is Kody?
summary:
  Start here. Kody is the home your agents share — connect the AI agent you
  already use over MCP and it gains durable memory, secrets it never reads,
  saved packages, and jobs that keep running while you are offline. Covers what
  Kody is and is not, what you cannot get elsewhere, the building blocks, real
  uses, and notes for an agent running a discovery interview. Nothing here
  requires an account.
category: platform
---

# What is Kody?

<!--
Agent notes — for AI agents running a discovery conversation from this page:

- Interview conversationally about the tools this person uses, recurring
  chores they do by hand, and automations they have wished for. Ask at most
  two short questions per message, then wait for the answer. Keep each
  message under roughly 120 words until the final recommendations.
- Skim the building blocks below and follow links when you need more detail.
- Finish with three to five specific opportunities ranked by payoff versus
  setup effort. For each one, name the Kody pieces involved (a memory, a
  package, a job or webhook, an integration, the inbox) and the first
  concrete step.
- End with a short "Next steps if you want to connect me to Kody" section
  that points to the /onboarding page on the same origin this doc was
  fetched from (https://kody.codes/onboarding in production). That page asks
  which agent they want to connect, then shows only that host's steps.
- Do not set anything up during discovery. Nothing in this flow requires an
  account or an MCP connection.
- The full docs index is at /llms.txt on the same origin; every doc is plain
  markdown at /docs/<slug>.md.
-->

Kody is the home your agents share. You keep using the AI agent you already have
— Claude, ChatGPT, Cursor, Codex, Copilot, Grok, or any other MCP-capable host —
and connect it to your Kody account. That agent gains durable state that
outlives the conversation and keeps working while your computer is off. Connect
a second agent tomorrow and it finds the same home already furnished.

This page is for people deciding whether Kody is worth setting up, and for AI
agents running a discovery conversation on someone's behalf. Everything here is
readable without an account. It is also plain markdown at
`/docs/what-is-kody.md` for anything that prefers to read it raw, and the full
docs index is at `/llms.txt`.

## What Kody is

You do not chat with Kody. Your agent supplies the intelligence; Kody supplies
the things that should not live in one chat window:

- **Memory** — durable facts and preferences on the account, surfaced to every
  connected agent.
- **Secrets** — API keys and OAuth grants your code can use but your agent can
  never read. There is deliberately no `secret_get`.
- **Packages** — code your agent wrote once and saved, callable from any agent,
  with exports, a hosted app surface, and its own storage.
- **Jobs, workflows, and webhooks** — the triggers that run those packages on a
  schedule, later, or when a provider knocks — with no model in the loop.
- **Integrations and MCP servers** — the logins and tool servers those packages
  reach through, owned by you, scoped by you.
- **An inbox** — every account gets an email address; mail in can start work,
  mail out can tell you it finished.

Kody is Fair Source: the source is available to read, fork, and self-host, and
each version converts to the Apache License 2.0 after two years. Kody runs no
chat-model agent loop and bills no chat tokens. Search and indexing use a small
embedding model; that is not a chat model and is not billed as inference.

## What Kody is not

Kody is not a gateway whose job is to connect APIs for your agent, and it is not
middleware that sits in front of every SaaS login. Integrations and MCP servers
are available when a job needs them; they are supporting cast. The center is
owned memory and owned packages that run in Kody's cloud and are callable from
any MCP host.

Kody is also not another chat app. There is nothing to talk to. If you leave
thinking "I signed up to wire APIs" or "I got another assistant," this page
failed.

## The agent reasons. Kody keeps it honest.

Your agent does the thinking. Kody holds the result so it does not have to think
it again.

- **Ask again tomorrow** — a saved export. No model in the loop.
- **A key in chat or a `.env`** — a secret the agent never sees.
- **Re-run the agent on a timer** — a job that runs while you are offline.
- **Context stuck in one host** — memories that follow the account.

## What you cannot get elsewhere

If you are comparing Kody against something else, these three are the reasons it
exists. Everything in the next section is supporting cast.

1. **One-off agent work becomes permanent.** Your agent explores against your
   real APIs, and the moment something works it saves as code that runs on a
   schedule with no model in the loop. This is not an agent re-run on a timer:
   there are no tokens spent, no prompt to drift, and nothing waiting on a model
   to respond. See [How Kody works](./how-kody-works.md) and
   [Jobs, workflows, and webhooks](./triggers.md).
2. **Your agent uses your keys without ever reading them.** It writes whatever
   code the job needs and still cannot see a credential — no capability returns
   one. Code references secrets by name and Kody substitutes them at the network
   boundary, only for hosts you approved. When a provider token is coarser than
   the job — Gmail has a send scope and no drafts-only scope — a locked package
   is the real grant: published code cannot silently start sending. See
   [Secrets](./secrets.md) and
   [Gmail drafts without send](./locked-gmail-drafts.md).
3. **Every agent you connect shares one home, and every install is a fork you
   own.** Switch from Claude to Cursor to a phone assistant and the memories,
   secrets, packages, and jobs are already there. Installing someone else's
   automation puts code in your account, on your credentials, that you can open,
   change, schedule, and republish. Nothing stays locked in someone else's
   runtime or in one vendor's chat history. See
   [Connect your agent](./connect-your-agent.md) and
   [Shared memory](./memory.md).

## The building blocks

- **Shared memory** — say something once, reuse it from every agent. See
  [Shared memory](./memory.md).
- **Secrets and integrations** — bring your own API keys and OAuth apps for the
  services you already use; verified per-provider walkthroughs live under
  [Connect a provider](https://kody.codes/docs/connect). Credentials stay
  server-side and never enter your agent's context. See [Secrets](./secrets.md)
  and [Integration bootstrap](./integration-bootstrap.md).
- **Ad hoc execution** — your agent runs sandboxed code against those
  integrations immediately, no deploy step. See
  [Execute and workflows](../use/execute.md).
- **Packages** — reusable saved code your agent writes and improves over time.
  Packages expose exports, own scheduled jobs, receive webhooks, and can serve a
  small web app. See [Package lifecycle](./package-lifecycle.md) and
  [Package authoring](./package-authoring.md).
- **Jobs, workflows, and webhooks** — recurring schedules, deferred one-shot
  runs that survive restarts, and HTTPS endpoints for Sentry, GitHub, Stripe, or
  any provider that cannot set Bearer tokens. See
  [Jobs, workflows, and webhooks](./triggers.md).
- **A personal email inbox** — inbound mail can trigger automations, and your
  assistant can send you notifications. See
  [Email primitives](../use/email-primitives.md).
- **Public packages** — browse automations other people published, and fork them
  into your own account with one click. See
  [Public packages](../use/community-packages.md).
- **Extensibility** — connect your own remote MCP servers, OpenAPI providers, or
  a home MCP server so your agent can reach devices on your network through
  Kody. Lock a connected MCP server to a package when execute should not call
  its tools. See [Connect a home MCP server](./local-mcp-tunnels.md) and
  [Lock an MCP server to a package](./locked-mcp-server.md).

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
- An inbound webhook that fingerprints repeated failures and emails one
  investigation instead of a flood.
- Home automation routines through a home MCP server — scenes, thermostats,
  speakers — driven by schedule or by asking your agent.
- Forking a public package (say, a YouTube video manager or an RSS digest) and
  having your agent adapt it to your needs.
- A drafts-only Gmail helper that prepares invoice replies you send yourself,
  locked so a later agent cannot republish a send path. See
  [Gmail drafts without send](./locked-gmail-drafts.md).

## Where to go next

- **Get started** — [Connect your agent](./connect-your-agent.md) walks through
  the in-app flow: connect one host, make something useful, then prove it
  travels to a second agent.
- **See the loop** — [How Kody works](./how-kody-works.md) plays one
  conversation from ad hoc question to owned export to quiet daily email.
- **Learn the primitives** — [The factory map](./kody-factory.md), then
  [Shared memory](./memory.md), [Secrets](./secrets.md),
  [Packages, integrations, and MCP servers](./packages-integrations-mcp.md), and
  [Jobs, workflows, and webhooks](./triggers.md).
- **Build** — [Package lifecycle](./package-lifecycle.md) decides when to save;
  [Package authoring](./package-authoring.md) shows how.

## Try it

Paste this into an agent that can fetch URLs or search the web. If an agent is
already interviewing you about Kody, you do not need to paste it again — it is
the same conversation.

> I'm deciding whether Kody (https://kody.codes) would be useful for me. Read
> https://kody.codes/docs/what-is-kody and then interview me to find out what
> Kody could do for me.
