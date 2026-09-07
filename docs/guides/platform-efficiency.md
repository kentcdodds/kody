---
id: platform_efficiency
title: Platform efficiency
summary:
  How unique Dynamic Worker days work across execute, jobs, package exports, and
  other surfaces, and how a stable module graph reuses one isolate for the UTC
  day.
category: platform
---

# Platform efficiency

Kody meters unique Dynamic Worker days so Cloudflare isolate cost is visible by
surface. This page states that cost model once. Package README and AGENTS.md
files do not repeat it.

## Unique worker days

Cloudflare bills **unique Dynamic Worker isolates** (a worker id) **per UTC
day**. Kody records that unit as the `unique_worker_days` / `dynamic_worker_day`
meter.

- The first use of a given worker id on a UTC day counts once for that user.
- Repeating the same worker id on the same UTC day does not add another day.
- Worker identity follows the **module graph** for that run: the same published
  graph reuses one isolate; a different graph is a different isolate.

Each plan includes a monthly unique-worker-day allotment. Public-ladder overage
uses the published unique-worker-day rate on
[Pricing](https://kody.codes/pricing). Account usage (`/account/usage` and
`usageGet`) reports the meter with what counts.

## Surfaces

The same meter is tagged with the surface that minted the isolate:

| Surface                      | Typical mint                                |
| ---------------------------- | ------------------------------------------- |
| `execute`                    | Ad hoc MCP / capability `execute`           |
| `job`                        | Package-owned scheduled or `jobRunNow` work |
| `package_export`             | A saved-package export invocation           |
| `workflow`                   | A Cloudflare Workflow run                   |
| `subscription`               | A package subscription handler              |
| `app_fetch` / `app_realtime` | A package app HTTP or websocket isolate     |
| `retriever` / `webhook`      | Search retrievers and inbound webhooks      |

Saved packages, jobs, and other durable surfaces reuse a stable isolate when the
published module graph stays the same. Ad hoc `execute` identity follows the
module graph of that execute run.

## Choosing a surface

Search first, then pick the smallest durable home that matches the work:

- A built-in capability or an existing saved-package export, called from
  `execute` or another package.
- A saved package when the behavior will be reused, scheduled, tested, or
  evolved — see [Package lifecycle](./package-lifecycle.md) and
  [Package authoring](./package-authoring.md).
- A [workflow](../use/workflows.md) for durable multi-step or deferred work.

`execute` is the exploration and composition surface. Durable named behavior
lives in a package so later runs share that package's module graph.

## Related

- [Execute and workflows](../use/execute.md)
- [Plans and pricing](https://kody.codes/pricing)
- Contributor metering schema:
  [Usage metering](../contributing/architecture/usage-metering.md)
