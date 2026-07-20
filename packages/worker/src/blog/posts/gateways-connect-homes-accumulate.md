---
title: Gateways connect. Homes accumulate.
date: 2026-07-20
description:
  MCP gateways and Kody get compared a lot, but they solve different problems. A
  gateway is plumbing between agents and tools. A home is where your assistant's
  stuff lives and keeps running. You might want both.
order: 2
---

Since I started talking about Kody, one question keeps coming up: "How is this
different from an MCP gateway like Executor?" It's a fair question, because from
a distance the two look similar. Both sit between your agent and a bunch of
capabilities. Both speak MCP. Both reduce the number of things you have to wire
up by hand.

But they're solving different problems, and I think naming the difference
clearly helps you figure out what you actually need. Spoiler: it might be both.

**A gateway is plumbing between agents and tools. A home is where your
assistant's stuff accumulates and keeps running.**

## The problem gateways solve

Gateways solve tool connection, and that's a real problem, especially for teams.
If your organization has forty MCP servers and two hundred engineers, nobody
wants every engineer maintaining forty config entries. A gateway gives you one
connection point, centralized auth, and an admin who can manage what's exposed
to whom. Requests flow through, responses flow back.

That's genuinely valuable. I'm not going to pretend otherwise, and I'm not going
to spend this post finding clever ways to say plumbing is bad. Plumbing is
great. Buildings need it.

The key property of a gateway, though, is that it's a pass-through. It connects
your agent to tools that exist elsewhere. When the request is done, the
gateway's work is done. Nothing lives there.

## The problem Kody solves

Kody solves a different problem: where does your assistant's durable stuff live,
and where does it run when you're not around?

Work with an AI assistant for a few months and it accumulates state that's worth
keeping. Memories about you and your preferences. API keys and secrets it uses
on your behalf. Code you built together (repo-backed
[saved packages](https://github.com/kentcdodds/kody/blob/main/docs/use/packages.md),
with real version history). Scheduled jobs. An email inbox of its own. OAuth
connections to your services.

That stuff needs a place to live that isn't any one agent's config directory,
because agents change fast and you should be free to change with them. And some
of it needs to do more than live somewhere: it needs to run. My scheduled jobs
execute on Cloudflare's infrastructure, in my own Durable Object with alarms,
while my laptop is closed. As of
[June's video](https://www.youtube.com/watch?v=TnztlHzhYvk) I had 42 of them,
alongside 55 saved packages and 51 secrets.

A pass-through can't give you that, and it isn't trying to. Accumulation and
durable execution were never the gateway's job.

## Same protocol, different center of gravity

Both connect to your agent over MCP (Kody's endpoint is https://heykody.dev/mcp,
and it works with Cursor, Claude Desktop, Claude Code, Codex and ChatGPT,
OpenCode, VS Code, or any MCP-capable agent; see the
[connection docs](https://github.com/kentcdodds/kody/blob/main/docs/use/connect-your-agent.md)).
The difference is what's on the other side of the connection.

Behind a gateway: other people's tools, reached through managed plumbing.

Behind Kody: your stuff. Two MCP tools, search and execute, with your
accumulated capabilities behind them. Your host agent does all the reasoning
(Kody makes zero inference calls, so there's no second model bill). When your
assistant executes code, it runs in a sandboxed Cloudflare Worker isolate
without the parent environment, with capabilities RPC'd back in scoped to your
userId. Your
[secrets](https://github.com/kentcdodds/kody/blob/main/docs/use/secrets-and-values.md)
are encrypted server-side and referenced as placeholders like `{{secret:name}}`;
the real values resolve only inside Kody's own fetch gateway, for hosts you
explicitly approved, and they never appear in prompts or chat.

Ownership runs through the whole design. Installing a
[community package](https://heykody.dev/community) creates a published fork you
own and can edit
([docs](https://github.com/kentcdodds/kody/blob/main/docs/use/community-packages.md)).
OAuth connections use your own OAuth app, created at the provider and connected
at https://heykody.dev/connect/oauth: a few minutes of setup instead of one
click, in exchange for your scopes, your rate limits, and no fixed provider list
([guide](https://github.com/kentcdodds/kody/blob/main/docs/guides/oauth.md)).
And the whole thing is open source at https://github.com/kentcdodds/kody, so
"trust me" never has to be the answer.

## Honest trade-offs, both directions

If your main pain is "my team needs governed access to a pile of internal
tools," a gateway is the right shape for that, and Kody won't replace it.
Centralized team administration is not what Kody is for.

If your main pain is "my assistant keeps starting from zero, its automations die
when my laptop sleeps, and its credentials are scattered across agent configs I
don't trust," that's the home problem, and a gateway won't solve it no matter
how good the plumbing is.

And there's no conflict in using both. Your agent can reach your team's tools
through a gateway and keep its personal memory, keys, packages, and jobs in
Kody. Different layers of the same stack. It's an imperfect analogy, I know,
but: the water main and the house are not competitors.

## Figure out which problem you have

Here's the one question that sorts it out: when you imagine the thing you're
missing, is it a connection or a place?

If it's a connection, go evaluate gateways. Sincerely. Good tooling in that
space makes the whole ecosystem better.

If it's a place, that's what I built. Signup is invite-gated for now, with a
waitlist on the signup page: https://heykody.dev/signup. Poke at the source
first if that's more your style. Either way, you'll know your own pain better
after asking the question than after reading any comparison post, including this
one.
