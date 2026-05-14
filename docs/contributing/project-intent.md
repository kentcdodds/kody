# Project intent

`kody` is an experiment in building a personal assistant that can work from any
AI agent host that supports MCP.

The core idea is to keep the public MCP surface small while making a large
number of capabilities available behind that surface. This repo follows
Cloudflare's Code Mode approach for execution: expose a tiny set of stable tools
such as `search` (capability discovery) and `execute` (sandboxed capability
calls), then implement the broader capability graph in code rather than as
hundreds of individually described MCP tools.

## What this repo is

This repository is:

- A working Cloudflare Workers application.
- A place to experiment with OAuth-protected MCP endpoints.
- A place to experiment with MCP apps, packages, and supporting infrastructure.
- The foundation for a personal assistant rather than a general-purpose SaaS
  product.

When docs or code reflect starter-oriented conventions and conflict with the
guidance here, treat this document as the project's intent.

## Who this is for

Kody is a multi-user personal assistant. Each authenticated user gets a strictly
isolated assistant: their own packages, jobs, secrets, values, memories, chat
threads, remote connectors, email inboxes, and durable storage. There is no
shared state between users.

- Optimization target: a high-quality personal assistant for each individual
  signed-in user, with hard isolation between users
- Onboarding: signup is open. There is no email allowlist, no invite flow, and
  no privileged account at runtime — any user who can reach the signup endpoint
  can create an account. Operators who want to restrict who can sign up should
  put the worker behind their own network-layer access control rather than
  expecting the application to gate it.
- Primary first-party user: `me@kentcdodds.com` (the maintainer's own account);
  tests, fixtures, and historical examples often reference this address but it
  is not a privileged account at runtime

Optimize for:

- Per-user isolation as a first-class invariant, enforced at the storage,
  durable-object, vectorize, and runtime layers
- Fast iteration on the personal-assistant experience
- Interoperability across MCP-capable hosts

It does not need to optimize for:

- Per-organization tenancy or shared-team workspaces
- Fine-grained permission delegation between many distinct humans inside a
  single account
- Enterprise SSO / directory provisioning

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
- This is a single-user system. Per-user isolation is an invariant, not a future
  direction; treat any code path that reads or writes data without a `userId`
  (or that shares a Durable Object id across users) as a bug.
- The main goal is enterprise-grade least-privilege design for many users.

Also do not document capabilities as if they already exist. Keep design notes
and proposals clearly labeled, and keep present-tense claims limited to behavior
that exists in the repository.

## Documentation guidance

When updating docs or explaining architecture:

- Describe the repo as a multi-user personal-assistant platform with strict
  per-user isolation, not a shared workspace product.
- Mention the per-user isolation invariant when it materially affects product,
  auth, or storage decisions.
- Keep present behavior separate from design notes and proposals.
- Prefer focused docs over expanding `AGENTS.md`.

## Agent guidance

If you are an agent working in this repo:

- Read this file before making product-level decisions.
- Per-user isolation is a hard invariant. Any new feature that touches data must
  be scoped by `userId` at the data layer, by user-namespaced Durable Object ids
  at the runtime layer, and by user-aware filters at the search/vector layer.
- Avoid proposing a large static MCP tool catalog as the default direction.
- Keep interoperability with MCP hosts in mind, especially around compact tool
  surfaces and clear server instructions.
