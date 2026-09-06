---
id: onboarding
title: Onboarding — the home your agents share
summary:
  First-run guide for a connected agent. Teach lightly what Kody is and is not,
  ask 1–2 questions to find the person's use, help them take advantage of the
  right features, and set up integrations with clear difficulty. One small win,
  then Step 3.
category: platform
---

# Onboarding — the home your agents share

<!--
Agent notes — for AI agents driving first-run from a copied onboarding prompt:

- The person pasted a short prompt from /onboarding/step-2. Follow that prompt.
  This guide is depth, not a script to dump.
- Interview conversationally. Ask at most two short questions, then wait.
  Keep each message under roughly 120 words.
- Do one small concrete win in their Kody account from their answer. Do not
  tour every surface.
- Kody is the home where their agents share memory, secrets, packages, jobs,
  workflows, and apps. They keep or switch agents without rebuilding that
  stack.
- Kody is not a service gateway, Composio-like middleware, or "connect APIs
  for your agent." Integrations exist. The center is owned memory and owned
  packages that run in Kody's cloud and are callable from any MCP host.
- Prefer webhook and event framing for apps, workflows, and jobs. A schedule
  is optional, not the hero.
- Secrets are usable by packages. You never read a secret value. There is no
  secret_get.
- Integration difficulty: MCP is the easy path, a PAT/API key is harder and
  more powerful, OAuth is hardest and most powerful. Say that out loud before
  you start a setup.
- Once they have made something useful, send them to Step 3
  (`/onboarding/step-3`) to connect another agent and reuse that same thing.
- Paths like /onboarding are relative to the origin you fetched this guide
  from.
-->

This page is the first-run briefing for an agent already connected to a Kody
account. People paste one short prompt on `/onboarding/step-2`. Agents retrieve
this guide with `search({ entity: "onboarding:guide" })`.

## What Kody is

Kody is the home your agents share. You connect the agent you already use. That
agent gains durable state that outlives the chat: memory, secrets, saved
packages, jobs, workflows, and apps. Work runs in Kody's cloud. You can keep
that agent or switch to another without rebuilding the stack.

You do not chat with Kody directly. Your agent supplies the intelligence. Kody
holds the result.

## What Kody is not

Kody is not a gateway that exists to connect APIs for your agent. It is not
middleware that sits in front of every SaaS login. Integrations and MCP servers
are available when a job needs them. They are supporting cast.

If the person leaves thinking "I signed up to wire APIs," this briefing failed.

## Start with their use

Ask 1–2 short questions. Wait. Examples: what should follow them into another
agent? What do they want done when they are not in chat? What tool do they
already live in?

Then pick the smallest Kody surface that fits that answer. Do not tour the rest.

## Memory

Say something once. Reuse it across agents. A memory is a durable fact or
preference on the account — not a note stuck in one host's chat.

Small win: save one memory the person will actually want tomorrow, in another
agent.

## Execute

Execute runs one-off work in Kody's cloud. It is not a script on their laptop.
Use it to try something against their real account, see a result, then decide
whether to keep the code.

Small win: one useful execute from their answer. Show the result.

## Packages

A package is owned code they save and invoke from any MCP host. The repo is the
source. Credentials stay in secrets. Runtime knobs live in package storage.

Prefer a close public package (`communitySearch`) before creating a new one.
Create when nothing close exists, or when they want something they will keep
improving.

Small win: persist one small package they own — or fork something close.

## Apps, workflows, and jobs

These are how work continues when nobody is in the chat.

- **Apps** — package-owned realtime surfaces.
- **Workflows** — deferred one-shot work, including `runAt`. Cloud runs belong
  here and in execute, not on their laptop.
- **Jobs** — package-owned recurring work.

Prefer webhooks and events as the trigger. A schedule is fine when they ask for
one. Do not make cron the hero of first-run.

Small win: name the event that should start their thing, or skip if they do not
have one yet.

## Integrations — pick the right difficulty

Only set up a connection when their use needs one. Say the difficulty first.

- **MCP (easy).** Add a remote MCP server they already have, or one they can
  authorize quickly. Start here when a server exists.
- **PAT / API key (harder, more powerful).** Store a token they already have as
  a secret. Packages can use it; you never read the value. Open
  `search({ entity: "connect_secret:guide" })` or a resolved
  `search({ entity: "provider_<slug>:guide" })`.
- **OAuth (hardest, most powerful).** They register their own provider app and
  complete `/connect/oauth`. Use this when a key is not enough. Open
  `search({ entity: "oauth:guide" })` or a resolved
  `search({ entity: "provider_<slug>:guide" })`.

Hosted / platform OAuth is not the onboarding path. New connects are
bring-your-own.

## Secrets

Packages use secrets. The agent never reads the value. List, set, lock, delete,
and sign — there is no get.

Small win: name a credential they already have and store it as a secret, or skip
if they have none.

## After something useful exists

The last onboarding beat is portability. Send them to `/onboarding/step-3` to
connect a second agent from a different ecosystem. That new agent should reuse
the memory, package, or ask you just made — one short proof. Do not restart
setup.
