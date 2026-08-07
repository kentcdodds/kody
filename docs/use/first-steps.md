# First steps

Kody exposes **search** and **execute** as the main tools. The agent should
**search first** to find the right capability, package, integration, value, or
secret reference, then run work through **execute**.

## Habits that help

- **Reuse returned `conversationId` values.** If a prior tool response included
  one, pass it back unchanged on follow-up calls. Otherwise omit the field and
  use the server-generated value the tool returns. Do not make one up locally.
- **Read `timing` when tool latency matters.** `search` and `execute` return
  timing metadata with `startedAt`, `endedAt`, and `durationMs` in structured
  responses.
- **Pass `memoryContext`** when durable user memory may matter. Kody uses it to
  surface a small set of relevant long-term memories that have not already been
  shown in the same conversation.
- **Think in packages for reusable saved code.** Packages expose exports,
  declare package-owned jobs, and can optionally expose an app/UI surface. For
  scheduled work that should not become a saved package, use the built-in
  `job_schedule` capability. `job_schedule_once` is the one-off convenience
  alias, optional `expires_at` auto-disables after a UTC timestamp,
  `job_run_now` can trigger an existing job immediately for debugging or
  catch-up runs, and `job_update` / `job_delete` let you correct or remove an
  existing scheduled job by id.
- **Prefer a close community package before creating one.** Community listings
  are excluded from general `search`. Use `community_search` (prefer trusted
  matches) and fork or adapt when a listing is close to the goal; create a new
  package only when nothing suitable exists. See
  [Community packages](./community-packages.md).
- **Bootstrap integration-backed work before building.** When a package, package
  app, or workflow depends on OAuth, a saved secret, or a third-party API, use
  `search` and the `coding_guide_get` `integration_bootstrap` guide first.
  Confirm the integration or secret exists, run a cheap authenticated smoke test
  in `execute`, then prefer a trusted community fork before building the
  downstream artifact.
- **Ask for natural-language goals**, for example: “Search Kody for GitHub pull
  request automation” or “Find a saved package for Cloudflare DNS helpers.”
- **Credentials use connect flows.** Use saved secrets, `/connect/oauth`,
  `/account/secrets/new`, or the flows described in
  [Secrets, values, and host approval](./secrets-and-values.md). Per-provider
  connect guides are available: load
  `coding_guide_get({ guide: "provider_<name>" })` (for example
  `provider_github`) or browse
  [https://heykody.app/guides](https://heykody.app/guides) (each page also
  serves raw markdown at `/guides/<slug>.md`).
- **Confirm destructive work** before mutating GitHub, Cloudflare, or Cursor
  Cloud Agents. See [Mutating actions and confirmations](./mutating-actions.md).
- **Verify before changing memory.** If you think something should become
  durable memory, call `meta_memory_verify` first, review related memories, and
  only then choose `meta_memory_upsert` or `meta_memory_delete`.

## Where to go next

- [Search](./search.md) — discovery, ranked results, and `entity` lookups
- [Execute and workflows](./execute.md) — module-based execution with
  `kody:runtime`
- [Repo-backed editing sessions](./repo-sessions.md) — editing and publishing
  saved package source
- [Memory and conversation context](./memory.md) — surfaced memories and the
  verify-first write workflow
- [Troubleshooting](./troubleshooting.md) — empty results, auth, and approvals
