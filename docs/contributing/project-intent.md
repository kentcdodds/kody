# Project intent

`kody` is an experiment in building a personal assistant that can work from any
AI agent host that supports MCP.

The core idea is to keep the public MCP surface small while making a large
number of capabilities available behind that surface. This repo follows
Cloudflare's Code Mode approach for execution: expose a tiny set of stable
tools such as `search` (capability discovery) and `execute` (sandboxed
capability calls), then implement the broader capability graph in code rather
than as hundreds of individually described MCP tools.

## What this repo is

This repository is:

- A working Cloudflare Workers application.
- A place to experiment with OAuth-protected MCP endpoints.
- A place to experiment with chat-agent behavior, MCP apps, and supporting
  infrastructure.
- The foundation for a personal assistant rather than a general-purpose SaaS
  product.

Some existing docs and code reflect this project's starter/template lineage.
When those conflict with the guidance here, treat this document as the
project's intent.

## Who this is for

This project is intentionally single-user.

- Primary user: `me@kentcdodds.com`
- Product posture: personal assistant for Kent
- Optimization target: useful behavior for one trusted user, not generic
  multi-tenant safety or broad organizational administration

Optimize for:

- Fast iteration
- Personal workflows and preferences
- Interoperability across MCP-capable hosts

It does not need to optimize for:

- Multi-user account models
- Per-organization tenancy
- Fine-grained permission delegation between many distinct humans
- Broad consumer onboarding flows

## Product intent

This project is meant to:

1. Build a personal assistant that can be reached from MCP-capable AI agents.
2. Keep the MCP contract compact enough that it does not bloat host context.
3. Hide most capability complexity behind `search` for discovery and Code Mode
   `execute` for capability calls.
4. Treat ChatGPT as a likely primary integration target, while keeping the
   server usable from other MCP hosts when possible.

The emphasis is on portability of the assistant across hosts, not on shipping a
large host-specific app surface for each client.

## What not to assume

When working in this repo, do not assume:

- The example tools define the full MCP surface.
- This project should evolve into a large catalog of explicitly declared MCP
  tools.
- This project is trying to become a generic starter kit for others.
- The main goal is enterprise-grade least-privilege design for many users.

Also do not document capabilities as if they already exist. Keep design notes
and proposals clearly labeled, and keep present-tense claims limited to
behavior that exists in the repository.

## Documentation guidance

When updating docs or explaining architecture:

- Describe the repo as an experiment and foundation for a personal assistant.
- Mention the single-user assumption when it materially affects product or auth
  decisions.
- Keep present behavior separate from design notes and proposals.
- Prefer focused docs over expanding `AGENTS.md`.

## Agent guidance

If you are an agent working in this repo:

- Read this file before making product-level decisions.
- Avoid pushing the design toward multi-tenant abstractions unless explicitly
  asked.
- Avoid proposing a large static MCP tool catalog as the default direction.
- Keep interoperability with MCP hosts in mind, especially around compact tool
  surfaces and clear server instructions.
