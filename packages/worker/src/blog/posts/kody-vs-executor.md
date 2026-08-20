---
title: Kody vs Executor?
date: 2026-08-20
description:
  Kody is your assistant's runtime and home. Executor is the integration gateway
  that catalogs the tools it can reach. Add Executor as an MCP server with code
  mode off, and each layer does the job it was built for.
order: 1
placeholder: false
image: /images/kody-vs-executor.webp
imageAlt:
  Kody, a 3D koala in a white jacket, and the cream Executor E logo size each
  other up in a warm living room.
ogImage: /images/kody-vs-executor-og.jpg
---

People keep asking me to pick a side: Kody or Executor. I get why. From a
distance they look like the same product. Both sit between your agent and a pile
of capabilities. Both speak MCP. Both collapse a huge surface into a tiny one.

I already wrote about
[why a gateway and a home are different jobs](https://kody.codes/blog/gateways-connect-homes-accumulate).
This is the other half of that answer: they are different, _and they stack_. I
wanted the Executor half to be as fair as the Kody half, so I asked
[Rhys](https://x.com/RhysSullivan), who builds [Executor](https://executor.sh),
to read this too.

**Kody is the runtime where your assistant's stuff lives and keeps running.
Executor is the integration gateway that catalogs the tools it can reach. Add
Executor to Kody as an MCP server with code mode off, and you get the best of
both worlds.**

I wrote this on August 20, 2026. Both products will keep moving. The comparison
is accurate as of that date.

## What Executor is for

Executor solves tool connection, especially the version of that problem that
shows up the moment you have more than a handful of services, or more than one
agent, or a team.

You add an integration once: an MCP server, an OpenAPI spec, a GraphQL API. You
authenticate once. You set a policy once: this tool always runs, this one needs
approval, this one is blocked. Then every MCP-capable agent you point at
Executor shares that same catalog. Claude Code, Cursor, Codex, whatever ships
next month. One connection, one set of credentials, one set of guardrails.

That's a real product. Teams drown in per-client MCP configs. Solo builders
drown in them too. A gateway that makes every tool look like a name plus two
schemas, and that can re-render that catalog however the client prefers, is
exactly the right shape for that pain.

Rhys's framing is the one I keep coming back to: Executor is a tool catalog, and
code mode is one way of interacting with it. Plain tools for one host.
TypeScript code mode for another. Same tools, different rendering. The catalog
is the product. The calling convention is pluggable.

## What Kody is for

Kody is not a catalog of other people's tools. It's the runtime and home your
assistant keeps, no matter which agent you talk to this year.

When your assistant executes code in Kody, that code runs in a sandboxed
Cloudflare Worker isolate next to the state it needs:

- [Secrets](https://github.com/kentcdodds/kody/blob/main/docs/use/secrets-and-values.md)
  resolve inside Kody's fetch gateway. They never enter prompts.
- [Saved packages](https://github.com/kentcdodds/kody/blob/main/docs/use/packages.md)
  import each other with real version history.
- Scheduled jobs fire on Cloudflare's infrastructure at 2am with no laptop
  attached.
- [Memories](https://github.com/kentcdodds/kody/blob/main/docs/use/memory.md)
  survive the conversation and the agent switch.
- An
  [inbox](https://github.com/kentcdodds/kody/blob/main/docs/use/email-primitives.md)
  lets services reach your assistant while you're asleep.

Kody exposes two MCP tools, `search` and `execute`. Your host agent does all the
reasoning. Kody makes
[zero inference calls](https://kody.codes/blog/zero-inference-calls). There is
no second model bill. There is also no host around to do client-side code mode
when your computer is off. The code has to run where the secrets resolve and
where the schedule lives.

You can't re-render that as a flat list of tools without losing the product. The
code isn't how Kody talks. The code is what Kody keeps.

## Two jobs, not two brands

Here's the taxonomy I want you to walk away with.

|                        | Executor                                          | Kody                                             |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------ |
| Center of gravity      | Catalog of tools                                  | Runtime and home                                 |
| Main problem           | Connect once, share everywhere                    | Accumulate and keep running                      |
| MCP surface            | A calling convention in front of a catalog        | `search` + `execute` as doors into a runtime     |
| Code mode              | One rendering of the catalog; you can turn it off | The product; turning it off would erase the home |
| Auth and policy        | Centralized, per-tool, team-ready                 | Per-user isolation, bring-your-own keys          |
| When the laptop sleeps | The request is done                               | The jobs are still running                       |

If your pain is "every agent has its own copy of GitHub, Linear, and Stripe, and
nobody can tell which tools are allowed," that's a gateway problem. Executor is
built for it.

If your pain is "my assistant starts from zero every morning, its automations
die when my laptop sleeps, and I don't trust credentials sitting in agent
configs," that's a runtime problem. Kody is built for it.

Those are not competing answers to one question. They are answers to two
questions.

## Why you turn code mode off

Here's where people get themselves into a mess, including me if I'm not careful.

Executor's default MCP surface is code mode: one `execute` tool, a sandbox, and
a typed catalog the model writes TypeScript against. That's a great way to talk
to a catalog from a host agent. Kody's `execute` is also a sandbox. If you
connect those two surfaces as-is, your host writes code that calls Kody's
`execute`, which writes code that calls Executor's `execute`. Code calling code
calling tools.

[Dax's complaint](https://x.com/thdxr/status/2079014870511432042) about an extra
useless layer is fair when both layers are calling conventions. It is not fair
when one layer is a runtime. The fix is not to delete Kody's `execute`. The fix
is to stop asking Executor to be a runtime when Kody already is one.

Rhys has been adding the same kind of switch Cloudflare's MCP server already
has: render the catalog as regular tools instead of as code mode. **That is the
switch you want when Executor sits behind Kody.**

With code mode off, Executor is an honest catalog. Kody's `execute` is the one
place code runs. Each layer does one job.

## The stack

Add Executor as a remote MCP server on Kody, with code mode disabled. Kody can
already do this:
[connect a remote MCP server](https://github.com/kentcdodds/kody/blob/main/docs/use/mcp-client-servers.md)
from `/account/mcp-servers`, or ask your agent to call `mcp_server_add`. Hosted
Executor is the easy HTTPS path. After it connects, Executor's tools show up in
`search` under `mcp:executor`, and your assistant calls them from Kody execute
as `kody.mcp["executor"].tool_name(...)`.

What you get from that one connection:

1. **Executor keeps being the gateway.** Integrations, credentials, and per-tool
   policies stay in one place. Destructive actions still pull a human back in.
   New agents you point at Executor still share the catalog. Kody is one more
   client of that catalog, not a replacement for it.
2. **Kody keeps being the runtime.** Packages, jobs, memories, the inbox,
   durable storage. A 2am job can call Executor tools with no host attached,
   because the code lives in Kody and the tools live in Executor.
3. **Your host agent keeps being the brain.** It talks to Kody over `search` and
   `execute`. It does not need a second code-mode sandbox in the middle, and it
   does not pay a second model bill.

A concrete morning: a Kody package runs on a schedule, asks Executor for the
Linear issues assigned to you and the Sentry events from overnight, writes a
short digest using a Kody memory about how you like triage written, and emails
it to you from your assistant's inbox. Executor authenticated the tools and
enforced the policies. Kody remembered the preference, kept the package, and ran
the job while you slept. Neither product had to pretend to be the other.

## Honest trade-offs

If you only need a governed catalog for a team, you do not need Kody in the
middle. Point your agents at Executor and go. Centralized team administration is
Executor's job, not mine.

If you only need a personal runtime, and you have three integrations you already
wired by hand, you do not need a gateway yet. Kody can connect OAuth apps,
secrets, OpenAPI bindings, and remote MCP servers directly. A gateway starts
earning its keep when the catalog gets large, shared, or policy-heavy.

And if you connect Executor to Kody _with_ code mode still on, you will feel the
double layer. That's not a reason to pick one product. It's a reason to use the
toggle.

## Use both, on purpose

The question is not "which one wins." The question is which job you are hiring
for, and whether you are accidentally hiring one product to do both.

If you want the catalog, use Executor. If you want the home, use Kody. If you
want an assistant that can reach everything _and_ keep running when the laptop
lid closes, add Executor's MCP server to Kody with code mode off.

Executor lives at [executor.sh](https://executor.sh), with source at
[github.com/UsefulSoftwareCo/executor](https://github.com/UsefulSoftwareCo/executor).
Kody is invite-gated right now, with a waitlist on
[kody.codes/signup](https://kody.codes/signup), and the source is at
[github.com/kentcdodds/kody](https://github.com/kentcdodds/kody).

Connect the gateway to the runtime. Leave one `execute`. That's the stack.
