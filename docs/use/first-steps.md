# First steps

Kody exposes **search** and **execute** as the main tools. The agent should
**search first** to find the right capability, official guide, package,
integration, or secret reference, then run work through **execute**. Official
guides load with `search({ entity: "{id}:guide" })` — not execute.

## Habits that help

- **Reuse returned `conversationId` values.** If a prior tool response included
  one, pass it back unchanged on follow-up calls. Otherwise omit the field and
  use the server-generated value the tool returns. Do not make one up locally.
- **Read `timing` when tool latency matters.** `search` and `execute` return
  timing metadata with `startedAt`, `endedAt`, and `durationMs` in structured
  responses.
- **Pass `memoryContext`** when durable user memory may matter. Kody uses it to
  surface a small set of relevant long-term memories as compact subject and
  summary one-liners. `search` also retrieves from the query string.
- **Think in packages for reusable saved code.** Packages expose exports,
  declare package-owned jobs, and can optionally expose an app/UI surface.
  Recurring schedules belong on a package under `kody.jobs`. Deferred one-shot
  work uses `workflows.create({ runAt })` from `execute` or package runtime.
  Optional `expires_at` on package jobs auto-disables after a UTC timestamp,
  `jobRunNow` can trigger an existing package job immediately for debugging or
  catch-up runs, and `jobUpdate` adjusts metadata (enable, kill switch,
  schedule, `expires_at`) without rewriting package source.
- **Prefer a close public package before creating one.** Community listings are
  excluded from general `search`. Use `communitySearch` and fork or adapt when a
  listing is close to the goal; create a new package only when nothing suitable
  exists. See [Public packages](./community-packages.md).
- **Bootstrap integration-backed work before building.** When a package, package
  app, or workflow depends on OAuth, a saved secret, or a third-party API, use
  `search({ entity: "integration_bootstrap:guide" })` first. Confirm the
  integration or secret exists, run a cheap authenticated smoke test in
  `execute`, then prefer a community fork before building the downstream
  artifact.
- **Ask for natural-language goals**, for example: “Search Kody for GitHub pull
  request automation” or “Find a saved package for Cloudflare DNS helpers.”
- **Credentials use connect flows.** Use saved secrets, `/connect/oauth`,
  `/account/secrets/new`, or the flows described in
  [Secrets and host approval](./secrets-and-values.md). Per-provider connect
  guides are available: `search({ entity: "provider_<name>:guide" })` (for
  example `provider_github`) or browse
  [https://kody.codes/guides](https://kody.codes/guides) (each page also serves
  raw markdown at `/guides/<slug>.md`).
- **Confirm destructive work** before mutating GitHub, Cloudflare, or Cursor
  Cloud Agents. See [Mutating actions and confirmations](./mutating-actions.md).
- **Verify before changing memory.** If you think something should become
  durable memory, call `metaMemoryVerify` first, review related memories, and
  only then choose `metaMemoryUpsert` or `metaMemoryDelete`.

## Where to go next

- [Search](./search.md) — discovery, ranked results, and `entity` lookups
- [Execute and workflows](./execute.md) — module-based execution with
  `kody:runtime`
- [Repo-backed editing sessions](./repo-sessions.md) — editing and publishing
  saved package source
- [Memory and conversation context](./memory.md) — surfaced memories and the
  verify-first write workflow
- [Troubleshooting](./troubleshooting.md) — empty results, auth, and approvals
