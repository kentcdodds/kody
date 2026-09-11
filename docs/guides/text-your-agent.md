---
id: text_your_agent
title: Text your agent
summary:
  How to let a spouse or friend talk to *your agent* over a familiar chat
  surface (iMessage worked example). Surface vs brain vs tools: the agent
  holds the conversation; Kody is memory, secrets, packages, and jobs - not
  the chat buddy. Covers OpenClaw/Bezalel/Grok Bot patterns and a simpler SMS
  path with Twilio.
category: platform
---

# Text your agent

Someone asks: "Can my spouse text Kody?"

The short answer is no - and that is the useful answer. You do not chat with
Kody. You chat with an **agent**. That agent uses Kody for the durable stuff:
memory, secrets, packages, jobs, and webhooks. Once you keep those three layers
straight, "text my robot" stops being a product feature request and becomes a
wiring problem you can solve with tools that already exist.

This page is the practical guide. The FAQ line in
[What is Kody?](./what-is-kody.md) still holds. What was missing is the worked
example.

## The three layers

Name them once and keep them:

| Layer            | What it is                                    | Examples                                                |
| ---------------- | --------------------------------------------- | ------------------------------------------------------- |
| **Surface**      | Where humans already talk                     | iMessage, SMS, Discord, Slack, email                    |
| **Brain**        | The agent host that holds the conversation    | OpenClaw, Pi, Grok Bot / Cursor, Claude, ChatGPT, Codex |
| **Tools / home** | Shared durable state the agent calls over MCP | Kody (memory, secrets, packages, jobs, webhooks)        |

The surface never has to know about Kody. Kody never has to become a chat app.
The brain sits in the middle: it receives the human message, reasons, calls Kody
when it needs tools or memory, and replies on the same surface.

If you leave thinking "I signed up so I could DM Kody," this page failed the
same way [What is Kody?](./what-is-kody.md) says it fails.

## Worked example: iMessage

Goal: your partner texts a number or Apple ID they already know, and _your_
agent answers with your preferences, calendars, and packages in mind.

### 1. Pick a brain that already speaks a messaging surface

Prefer an agent-native channel. The agent stays the brain; Kody stays the tools.

- **OpenClaw** - the
  [`@openclaw/imessage`](https://www.npmjs.com/package/@openclaw/imessage)
  plugin plus the [`imsg`](https://github.com/openclaw/imsg) CLI. The gateway
  talks to Messages through `imsg rpc` (JSON-RPC over stdio) on a Mac signed
  into Messages, or through an SSH wrapper that runs `imsg` on that Mac. It
  reads `~/Library/Messages/chat.db` (needs Full Disk Access) and can send
  through Messages Automation. Richer features may need the `imsg launch`
  helper. See [OpenClaw iMessage](https://docs.openclaw.ai/channels/imessage).
- **Bezalel** - hosted capability plane over MCP (URL + bearer). iMessage shows
  up as a paired line; inbound events wake agents through an event router.
  Texting goes through Photon Spectrum: managed iMessage lines in the cloud, so
  no personal Mac is required. See [Bezalel docs](https://bezalel.sh/docs.md)
  and [privacy](https://bezalel.sh/privacy.md).
- **Grok Bot / Cursor (and similar hosts)** - same architecture on a different
  surface. In the official Kody Discord, `@Kody` / a grok-bot wake hands the
  message to an agent; the agent replies in-channel. See
  [`@kentcdodds/grok-bot`](https://kody.codes/@kentcdodds/grok-bot).

There is no official personal iMessage API from Apple. Something has to bridge
Messages (or a hosted line) into the agent. That bridge is the hard part. The
Kody side - webhook ingress, normalize, optional wake - is the easy part and
looks like Discord or AgentMail event packages.

### 2. Connect that agent to Kody over MCP

Use [Connect your agent](./connect-your-agent.md). After connect, the same agent
that answers iMessage can `search` and `execute` against your account: memories
travel, secrets stay unread, packages and jobs keep running while the phone
conversation continues.

### 3. Decide who is allowed to talk to it

A spouse texting "what's for dinner" is a different trust boundary than a public
Discord help channel. Scope the surface (contacts, allowlists, a dedicated line)
in the agent host. Use Kody [secrets](./secrets.md) and package locks when the
agent should act with your credentials without ever reading them.

## Realistic iMessage bridges

If your chosen brain does not already own iMessage, you still need a bridge:

| Approach                                                            | Fit                                  | Notes                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **Photon Spectrum** (managed iMessage lines in the cloud)           | Hosted-line model, no personal Mac   | What Bezalel-style setups and adapters use; see [Photon iMessage](https://photon.codes/platform/imessage) |
| **BlueBubbles** (self-hosted on a Mac you control)                  | Historical / self-hosted alternative | REST/webhooks into your own agent or a Kody package if you already run a BlueBubbles Mac.                 |
| **AirMessage / DIY Mac helper** (Shortcuts, AppleScript, `chat.db`) | Fragile                              | Works until an OS update; treat as temporary                                                              |
| **Pure cloud "just works"**                                         | Not available                        | Something always bridges or hosts a line                                                                  |

A later optional Kody package could wrap Photon webhooks the way Discord and
AgentMail packages do. Prefer agent-native channels first unless you
specifically want events landing in Kody packages with no model in the loop
([Jobs, workflows, and webhooks](./triggers.md)).

## Simpler path: SMS without blue bubbles

When blue-bubble iMessage is not required, use a normal phone number.

[`@kody/twilio`](https://kody.codes/@kody/twilio) is the existing SMS lane:
inbound SMS can wake a workflow or package; your agent (or a no-model job)
replies. Same three layers - surface is SMS, brain is still your agent (or a
deterministic package), tools are still Kody.

## Parallel: Discord in the official Kody server

Community chat often wants the same shape:

1. Human posts in Discord (surface).
2. `@Kody` or a grok-bot wake reaches an agent (brain).
3. That agent calls Kody packages and memory (tools), then replies in-thread.

Same split as iMessage. Different surface. See
[`@kentcdodds/grok-bot`](https://kody.codes/@kentcdodds/grok-bot).

## What to build vs what not to wait for

**Do this now**

1. Choose a brain that already speaks the surface you care about.
2. Connect it to Kody ([Connect your agent](./connect-your-agent.md)).
3. Give trusted humans access on that surface only.
4. Teach the agent to reach for Kody for memory and packages instead of stuffing
   state into one chat host.

**Skip waiting for**

- A "chat with Kody" inbox. That would invert the product.
- A pure cloud personal iMessage API. Apple does not offer one for this use.

**Optional later**

- A Kody package that normalizes Photon webhooks (or a self-hosted BlueBubbles
  server) into the same event shape Discord already uses, so jobs can run with
  no model in the loop.

## Where to go next

- [What is Kody?](./what-is-kody.md) - "You do not chat with Kody"
- [Packages, integrations, and MCP servers](./packages-integrations-mcp.md) -
  keep those three from collapsing into each other
- [Connect your agent](./connect-your-agent.md) - wire the brain to the home
- [Jobs, workflows, and webhooks](./triggers.md) - when the surface should knock
  on a package instead of waking a model
