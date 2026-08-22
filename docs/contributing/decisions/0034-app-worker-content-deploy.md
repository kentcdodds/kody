# 0034: Extract the Remix/content lane; do not reset Durable Objects for content deploys

- **Status:** accepted
- **Date:** 2026-08-22

## Context

[0016](./0016-mono-worker-extraction.md) extracted the package-runtime and jobs
lanes and left Remix, blog, official guides, MCP, OAuth, and the remaining
Durable Object classes on the main `kody` script. Cloudflare assigns Durable
Object instances a Worker version: any `wrangler deploy` of the script that
**owns** those classes resets them
(`Durable Object reset because its code was updated`), including uploads that
only change static assets or markdown imported into the bundle.

Blog posts, official guides (`docs/guides/`), and Remix UI change more often
than MCP or Durable Object code. Shipping those from the DO-owning script resets
live MCP sessions, mailboxes, repo sessions, and other main-script objects for a
content edit.

Moving the remaining Durable Object classes off main would be a script migration
(the risky 0016 step). Assets-on-the-same-worker does not help: a new version of
that script still resets its objects.

## Decision

Extract a Remix/content Worker (`kody-app`, `packages/app-worker/`) that owns
**no Durable Object classes**. The main `kody` script keeps MCP, OAuth, email,
queues, and the remaining Durable Objects. After those platform routes, main
forwards remaining requests over the `APP_SURFACE` service binding. Official
guide **schemas** stay in the main catalog (an added guide id still deploys
main); `coding_guide_get` loads **bodies** from `kody-app` when the binding is
present.

Do **not** move Durable Object classes for this split. Do **not** keep blog,
guide bodies, or Remix UI on the DO-owning script. Tests and single-worker
local/bootstrap omit `APP_SURFACE` and serve the app surface in-process.

## Consequences

Content/UI-only production deploys upload only `kody-app`; main, runtime, and
jobs versions stay put, so those Durable Objects are not reset. Cost: another
wrangler config, preview bootstrap ordering (`kody-app` must exist before main
binds `APP_SURFACE`), and a path filter that still deploys main when package-app
handlers or the guide catalog change.

Revisit-if Cloudflare can version a DO-owning script without resetting its
objects, or if a later split needs MCP off the Remix-adjacent host for a
different failure-domain reason than deploy blast radius.
