# Project intent

`kody` is an experiment in building a personal assistant that can work from any
AI agent host that supports MCP.

The core idea is to keep the public MCP surface small while still making a
large number of capabilities available behind that surface. The current
direction is to follow Cloudflare's Code Mode approach: expose a tiny set of
stable tools such as search and execute, then implement the broader capability
graph in code rather than as hundreds of individually described MCP tools.

## What this repo is

Today, this repository is:

- A working Cloudflare Workers application.
- A place to experiment with OAuth-protected MCP endpoints.
- A place to experiment with chat-agent behavior, MCP apps, and supporting
  infrastructure.
- The foundation for a personal assistant rather than a general-purpose SaaS
  product.

Some existing docs and code still reflect this project's starter/template
lineage. When those conflict with the direction described here, treat this
document as the intent for the current project.

## Who this is for

This project is intentionally single-user right now.

- Primary user: `me@kentcdodds.com`
- Product posture: personal assistant for Kent
- Optimization target: useful behavior for one trusted user, not generic
  multi-tenant safety or broad organizational administration

That means future decisions should usually optimize for:

- Fast iteration
- Personal workflows and preferences
- Interoperability across MCP-capable hosts

It does not currently need to optimize for:

- Multi-user account models
- Per-organization tenancy
- Fine-grained permission delegation between many distinct humans
- Broad consumer onboarding flows

## Product direction

The intended product direction is:

1. Build a personal assistant that can be reached from MCP-capable AI agents.
2. Keep the MCP contract compact enough that it does not bloat host context.
3. Hide most capability complexity behind Code Mode style search and execute
   tools.
4. Treat ChatGPT as a likely primary integration target, while keeping the
   server usable from other MCP hosts when possible.

The emphasis is on portability of the assistant across hosts, not on shipping a
large host-specific app surface for each client.

## What not to assume

When working in this repo, do not assume:

- The current example tools define the intended long-term MCP surface.
- This project should evolve into a large catalog of explicitly declared MCP
  tools.
- This project is trying to become a generic starter kit for others.
- The main goal is enterprise-grade least-privilege design for many users.

Also do not document future capabilities as if they already exist. It is fine
to describe intent, experiments, and likely direction, but keep present-tense
claims limited to behavior that exists in the repository today.

## Documentation guidance

When updating docs or explaining architecture:

- Describe the repo as an experiment and foundation for a personal assistant.
- Mention the single-user assumption when it materially affects product or auth
  decisions.
- Separate current behavior from intended direction.
- Prefer focused docs over expanding `AGENTS.md`.

## Agent guidance

If you are an agent working in this repo:

- Read this file before making product-level decisions.
- Avoid pushing the design toward multi-tenant abstractions unless explicitly
  asked.
- Avoid proposing a large static MCP tool catalog as the default direction.
- Keep interoperability with MCP hosts in mind, especially around compact tool
  surfaces and clear server instructions.
