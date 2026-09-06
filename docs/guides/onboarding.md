---
id: onboarding
title: Onboarding — the home your agents share
summary:
  First-run guide for a connected agent. Teach lightly what Kody is and is not,
  then help the person find their use for memory, execute, packages, apps,
  workflows, jobs, and secrets. One small win per idea — not a tour.
category: platform
---

# Onboarding — the home your agents share

<!--
Agent notes — for AI agents driving first-run from a copied onboarding prompt:

- The person pasted a short prompt from /onboarding. Follow that prompt. This
  guide is depth, not a script to dump.
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
- Paths like /onboarding are relative to the origin you fetched this guide
  from.
-->

This page is the first-run briefing for an agent already connected to a Kody
account. People see short copy-paste prompts on `/onboarding`. Agents retrieve
this guide with `search({ entity: "onboarding:guide" })` when they need depth.

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
- **Workflows** — deferred one-shot work, including `runAt`.
- **Jobs** — package-owned recurring work.

Prefer webhooks and events as the trigger. A schedule is fine when they ask for
one. Do not make cron the hero of first-run.

Small win: name the event that should start their thing, or skip if they do not
have one yet.

## Secrets

Packages use secrets. The agent never reads the value. List, set, lock, delete,
and sign — there is no get.

Small win: name a credential they already have and store it as a secret, or skip
if they have none.

## After a second agent

The last onboarding beat is portability: reuse a memory, package, or ask from
the first agent in the new one. One short proof. Do not restart setup.
