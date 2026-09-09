---
id: connect_your_agent
title: Connect your agent
summary:
  The three-step Get started flow for people: connect the agent you already use
  over MCP, paste one prompt so that agent makes something useful in your
  account, then connect a second agent from another ecosystem and watch it
  reuse the same memory and package. Includes what approving access means,
  verified-email requirements, and which agents suit building versus using.
category: platform
---

# Connect your agent

Kody is an MCP server. You use it from Cursor, ChatGPT, Codex, Claude Desktop,
Claude Code, Copilot, Grok, Gemini, OpenCode, OpenClaw, Devin, or any other
agent that supports MCP — not from a separate Kody chat app. Getting started is
three steps, and the in-app page at `/onboarding` walks you through each one.

## Before you start

- **A Kody account with a verified email.** Authorize cannot finish, and MCP
  cannot run, until the address on your account is verified. If authorize asks
  you to verify, keep that tab open, finish from the email link (or
  `/pending-verification`), then continue — you do not need to restart the host
  connection.
- **One agent you already use.** You do not need every host on day one. A second
  agent is Step 3, and it is worth it precisely because the first one has
  already furnished the home.

## Step 1 — Connect one agent

1. Open Get started (`/onboarding`) and pick the agent you want to connect
   first. The page then shows only that host's steps — a plugin, a vendor CLI
   command, or the raw MCP URL. Use **Not listed** when your host is not in the
   chooser or you only need the URL.
2. Follow those steps. On [kody.codes](https://kody.codes) the MCP URL is
   `https://kody.codes/mcp`; a preview or self-hosted deployment uses that
   origin's `/mcp`.
3. Complete the OAuth flow when the host opens it. Sign in to Kody if needed,
   then approve access.

**Approving gives that agent full access to this Kody account** — not a limited
permission set. Kody does not control or supervise what your agent does with the
access you grant. Connect agents you trust, and revoke one from the Connected
agents panel on `/account` when you stop using it.

Some hosts bind MCP tools when a conversation starts. If Kody's tools do not
appear right after authorizing (Claude Desktop is the usual case), start a new
chat before the first task.

Agents discovering a Kody deployment on their own can read `/auth.md` for the
OAuth registration block and MCP URL, and `/.well-known/mcp/server-card.json`
for the server card.

### Which agent should go first?

Using packages that already exist works well from non-coding agents: Claude
Desktop, ChatGPT, Grok, Gemini, the Copilot app. Creating or editing packages is
smoother from a coding agent — Cursor, Claude Code, Codex, Copilot CLI,
OpenCode, Devin, OpenClaw — because those hosts edit files and iterate on code
easily. Either kind can be first; the home is the same.

## Step 2 — Make something useful

Once the connection works, Step 2 is one short prompt you paste into the agent
you just connected. The agent loads the first-run briefing
(`search({ entity: "onboarding:guide" })`), asks one or two questions about what
you want done when you are not in chat, and helps you make one small useful
thing in your Kody account: a memory it will want tomorrow, a package you own,
or an ad hoc run worth keeping.

This is the moment Kody stops being a login and becomes yours. The agent should
not tour every surface or wire up integrations you did not ask for. If it starts
talking about connecting APIs before it has made anything, point it back at the
briefing.

Two optional playbooks sit next to that step: [First build](./quick-example.md)
turns one ad hoc execute into a package you own, and
[Email and memories](./first-win.md) uses your inbox to save durable memories
about you.

## Step 3 — Connect a second agent

Step 3 is where Kody earns the name. Pick an agent from a different ecosystem
than the first (same-vendor hosts stay unavailable for this step), connect it
the same way, then paste the portability prompt. The new agent loads
`search({ entity: "portability:guide" })`, searches your account, and reuses the
memory or package you just made — in a different product, with no setup
repeated.

Connecting that second agent unlocks the Standard plan free for two weeks, once
per account.

## Where to go next

- [First run (agent playbook)](./onboarding.md) — what the agent does with the
  Step 2 prompt.
- [Shared memory](./memory.md) — what travels between your agents and how to
  keep it honest.
- [The factory map](./kody-factory.md) — every primitive your agents now share.
- [Troubleshooting](../use/troubleshooting.md) — auth loops, empty results, and
  approvals.
