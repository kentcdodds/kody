---
id: kody_factory
title: The Kody factory map
summary:
  Map Kody's discovery, credentials, integrations, packages, storage, schedules,
  hosted surfaces, and memories—and know where the boundary is.
category: platform
---

# The Kody factory map

Kody is a hosted factory for capabilities your assistant can discover, combine,
and keep running. Your assistant connects to Kody over MCP and starts with two
tools:

- **`search`** finds available capabilities, connected services, saved packages,
  official guides, and relevant memories. Search before building so the
  assistant can reuse what you already have.
- **`execute`** runs a temporary TypeScript module on Kody's servers. It can
  compose discovered capabilities, call connected services, and import exports
  from packages you own.

Those two doors lead to a set of user-isolated primitives.

## What is on the factory floor

### Secrets and integrations

**Secrets** are private credentials stored for your Kody account. Runtime code
refers to them by placeholder or an approved package mount; Kody does not return
the saved secret value to the assistant.

**Integrations** are saved connections to external services. OAuth-backed
integrations keep their token bundles server-side, while remote MCP servers and
curated OpenAPI bindings expose their tools through Kody. Search shows the
capabilities available to the signed-in user.

### Packages and `packageStorage()`

**Packages** turn useful code into a named, versioned capability. Package source
lives in a repository, but published package code runs server-side in Kody's
runtime. A community package is not owned merely because it is visible: fork it
to create a saved package in your account, review it, and publish that owned
copy before adapting or invoking it as yours.

Each package gets isolated durable **`packageStorage()`** for runtime state such
as cursors, preferences, and checkpoints. Source and versioned configuration
belong in the package repository; credentials belong in secrets; changing
runtime state belongs in `packageStorage()`.

### Jobs and schedules

**Jobs** run code later or on a schedule while your laptop is closed. An ad hoc
schedule can invoke a module directly. A reusable package can declare its own
jobs so the schedule travels with the package behavior. Runs and failures remain
inspectable in account activity.

### Apps and webhooks

**Package apps** give a package a hosted HTTP and browser surface. They can
render a small app, receive requests, and use the same package runtime and
storage as its exports.

**Webhooks** give a package a public, credentialed inbound URL. A provider sends
an event to that URL, and Kody dispatches the validated request to the package
export that owns it. Apps are general hosted request surfaces; webhooks are
inbound event doors.

### Memories

**Memories** are durable facts and preferences attached to your Kody account.
Search can retrieve relevant memories as context for a task. Memory is for
information worth carrying between conversations, not package state, source
configuration, or credentials.

## The boundary around the factory

Hosted Kody cannot see your Mac's disk, your local Obsidian vault, local-only
CLI processes, `localhost`, or devices reachable only on your home network.
Installing a desktop MCP server does not make it reachable from Kody's
Cloudflare Workers.

To bring a local capability into the factory, run an MCP server beside the local
resource and expose that server through a protected public HTTPS route. The
[local MCP tunnels guide](./local-mcp-tunnels.md) describes the Cloudflare
Tunnel and Access pattern. Then connect its URL as a
[remote MCP server](../use/mcp-client-servers.md), and its tools appear in
search under `mcp:<name>`.

## A practical route through the map

1. Search for the outcome and inspect the exact capability shape.
2. Connect the needed secret, integration, or remote MCP server.
3. Use `execute` for a one-off composition and authenticated smoke test.
4. Fork a close community package or author an owned package when the behavior
   should be reusable, reviewed, or scheduled.
5. Keep runtime state in `packageStorage()` and expose only the app, webhook,
   export, or job surfaces the package needs.
6. Save a memory only when the user wants Kody to retain a durable fact or
   preference.

For the full ask-once-to-package loop, continue with
[How Kody works](./how-kody-works.md). For package implementation details, load
the [package authoring guide](./package-authoring.md).
