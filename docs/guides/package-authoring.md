---
id: package_authoring
title: Package authoring guide
summary:
  START HERE when creating or materially changing a Kody package: package
  shape, README.md Intent section, secret-using package approval checklist,
  and scope-update guidance without adding new primitives.
category: platform
---

# Package authoring guide

Use this guide when creating a new Kody package or materially changing an
existing one.

## Choose an authoring lane

There are two lanes for writing package source. Pick based on whether you have
local filesystem and git access:

- **Git lane (coding agents — preferred).** Call `package_get_git_remote` with
  `create: true` and a new `kody_id` to register a stub saved package and mint a
  short-lived authenticated remote in one call (for existing packages, omit
  `create`). Run the returned `setup_commands` to clone into a temporary
  directory, edit normally — binary assets, multi-file refactors, and local
  build/test loops all work — commit, push, then publish with
  `package_publish_external_push`.
- **Tool-only lane.** Without local filesystem/git access, create with
  `package_save` (complete UTF-8 text file set; no binary files) and edit
  through repo sessions (`repo_open_session`, `repo_edit_files`,
  `repo_write_file`, `repo_commit`, then `repo_run_checks` before
  `repo_publish_session`).

If a request needs binary assets, many-file changes, or local build/test loops
and you are tool-only, tell the user the task fits a coding-capable agent better
and confirm before proceeding.

## README Intent section

Package intent is human-authored guidance, not a Kody primitive. Keep it in the
root `README.md` so agents see it during package creation, updates, and search
detail review.

When you create or materially change a package:

1. Include or maintain a `## Intent` section in `README.md`.
2. Capture the user's goal in a few concrete sentences.
3. Ask the user when the intent is unclear or underspecified.
4. Update the intent only when you are confident the goal changed.
5. If the user expands the package scope, update the section with the new scope.

Do not add a package manifest field, runtime object, saved value, or other Kody
primitive solely to track intent.

## Minimal shape

```md
# Package Name

## Intent

This package exists to ...
```

Keep the section concise. It should explain why the package exists and what
success means for the user, not duplicate every implementation detail.

## Package app routing

Production-hosted package apps live at
`https://{username}.kodyapps.dev/packages/<kody-id>/<path>` (the username is in
the hostname; the path mount is `/packages/<kody-id>`). Confirmed non-production
runtimes may serve inline on the app origin at
`/@username/packages/<kody-id>/<path>` instead. The app receives only `/<path>`
in its fetch request in both cases. Root-relative links such as `/audio/123`
therefore escape the mount and are not routed back to the package app.

Import `packageContext` from `kody:runtime` and build every in-app link,
redirect, share/email URL, and OAuth callback against its public base:

```ts
import { packageContext } from 'kody:runtime'

if (!packageContext?.hostedUrl) {
	throw new Error('This module must run as a package app.')
}

const audioUrl = new URL(
	`${packageContext.appBasePath}/audio/123`,
	packageContext.hostedUrl,
)
```

- `packageContext.hostedUrl` is the full public URL of the app mount.
- `packageContext.appBasePath` is the origin-relative mount path
  (`/packages/<kody-id>` on a subdomain, `/@username/packages/<kody-id>` when
  inline).

Kody derives both fields from the package's current serving username and
`kody.id`, including after a rename or fork. Do not hard-code either path
segment.

## `kody.description` (short public tagline)

`package.json#kody.description` is a **short public tagline**, not a feature
dump. Aim for about **80–120 characters** (hard max **200**). Prefer outcome
phrasing such as “Send transactional email via Resend” over inventory lists of
exports, auth, or APIs.

Put feature lists, API surface, auth notes, and longer guidance in `README.md`
(including `## Intent`), `kody.searchText`, and export/JSDoc docs — not in
`kody.description`. Community listings and Open Graph share cards reuse this
field, so keep it concise.

## Package visibility (`private`)

Default new saved packages to `"private": true` in `package.json` unless the
user explicitly wants public **community** publishing.

Like npm, `"private": true` blocks community listings on this deployment.
Account publishing is unaffected, so the owner can run the package privately.

- Set `"private": true` when creating or forking a package unless the user asks
  to share it publicly.
- Require explicit user approval before changing `"private"` or creating a
  package without `"private": true`.
- Pass `confirm_private_visibility_change: true` on `package_save` or repo
  publish only after that approval.
- Community publish additionally requires `"private": false` or omitting
  `private`, plus MIT license and README `## Intent`.

## Secret-using packages

When a package will use user-scoped secrets (`{{secret:name}}` placeholders or
`kody.secretMounts`):

1. Ensure each secret exists (see `guide: "connect_secret"` /
   `guide: "secret_backed_integration"`).
2. Self-authored packages (and community forks adopted with
   `community_fork_adopt` after a real source review) get automatic read/use
   access to user secrets (host approval still applies; `secret_set` /
   `secret_delete` still need an `allowed_packages` grant). After save/publish,
   read `pending_secret_package_approvals` from the tool result — it is non-null
   only for unadopted community forks.
3. When pending approvals are present, either review the fork source and call
   `community_fork_adopt` with a `review_summary`, or send the user
   `bulk_approval_url` / each `approval_url`.
4. Wait for approval or adoption (when required), then smoke-test with a keyless
   `packages.invoke(...)` call. The smoke test must go through `packages.invoke`
   — it runs the export in the package's own runtime, so `kody.secretMounts`
   mounts are exercised; a static import cannot verify those. Use a read-only
   export or a package-supported dry-run input that actually reads the approved
   secret (for example an authenticated read-only API call), so the smoke test
   proves secret access without external side effects.
5. Only then treat the package as ready to run.

Host approval (from an earlier ad hoc `execute` smoke test) is separate from
package approval. Unadopted community-forked packages may need both;
self-authored and adopted packages still need host approval when outbound calls
require it.

## Verify your publish

After publish succeeds — and after any required secret approvals — run synthetic
smoke tests for every declared surface before calling the package complete.
Synthetic invocations are real-surface runs with real side effects; use a
deliberately visible irreversible-side-effect guard when a smoke test should
stay safe.

1. Read `test_hints` on the `package_publish_external_push` result when present.
   It lists copy-pasteable calls for declared apps and subscription topics.
2. **Exports and secret mounts** — keyless
   `packages.invoke({ kodyId, exportName, params })` against a read-only export
   or package-supported dry-run input that exercises approved secrets (see
   [Secret-using packages](#secret-using-packages) above).
3. **Package apps** — `package_app_fetch({ kody_id })` with the path, method,
   and body your handler needs. Confirm `{ status, headers, body, truncated }`
   and any `packageStorage()` side effects. See
   [Package app fetch](../use/package-app-fetch.md).
4. **Subscriptions** — `package_subscription_dispatch({ kody_id, topic, … })`
   with exactly one of `params` (fixture) or `email_message_id` (stored-mail
   replay) for each declared topic. See
   [Synthetic event dispatch](../use/synthetic-event-dispatch.md) and the
   [package subscriptions guide](./package-subscriptions.md#synthetic-dispatch).
5. Optional UI checks — open `hosted_app_url` when the publish response includes
   one; synthetic app fetches do not replace browser verification for layout,
   OAuth redirects, or websocket facets.

Only after these checks pass (or the user explicitly skips a surface) treat the
package as ready to run.

## Community icon

Public community packages should include one root `community-icon.svg`,
`community-icon.png`, `community-icon.webp`, `community-icon.jpg`, or
`community-icon.jpeg`. Prefer a square visual with a simple silhouette that
remains legible at 56 pixels. Keep it under 2 MiB and 16 megapixels. Kody
generates a package-name fallback when the repository has no icon.

Publishing the package refreshes the community listing icon automatically. The
candidate paths win in the order listed above, so when replacing an icon with a
different format (for example svg → png), delete the old file in the same commit
or the old format keeps being served.
