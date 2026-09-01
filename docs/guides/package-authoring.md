---
id: package_authoring
title: Package authoring guide
summary:
  START HERE when creating or materially changing a Kody package: package
  shape, README.md Intent section, per-export JSDoc (search Purpose),
  secret-using package approval checklist, and scope-update guidance
  without adding new primitives.
category: platform
---

# Package authoring guide

Use this guide when creating a new Kody package or materially changing an
existing one.

A package is not done until README `## Intent` is current, every public export
has JSDoc as specified in [Export JSDoc](#export-jsdoc), and the smoke tests in
[Verify your publish](#verify-your-publish) pass (or the user explicitly skips a
surface).

## Choose an authoring lane

There are two lanes for writing package source. Pick based on whether you have
local filesystem and git access:

- **Git lane (coding agents — preferred).** Call `package_get_git_remote` with
  `create: true` and a new `kody_id` to register a stub saved package and mint a
  short-lived authenticated remote in one call (for existing packages, omit
  `create`). Run the returned `setup_commands` to clone into a temporary
  directory — they set local `git config user.email` / `user.name` from
  `git_author` (the signed-in Kody account). Do not invent or guess a git
  identity. Edit normally — binary assets, multi-file refactors, and local
  build/test loops all work — commit, push, then publish with
  `package_publish_external_push`. If that tool returns `locked`, open the
  returned `approval_url` so the owner can promote the named commit. Do not
  treat HEAD as live until `published_commit` moves. When the OAuth token is
  coarser than the export (Gmail drafts without send), lock after the first
  publish — see [locked-gmail-drafts.md](./locked-gmail-drafts.md).
- **Tool-only lane.** Without local filesystem/git access, create with
  `package_save` (complete UTF-8 text file set; no binary files) and edit
  through repo sessions (`repo_open_session`, `repo_edit_files`, `repo_commit`,
  then `repo_run_checks` before `repo_publish_session`).

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

README Intent is package-level. It does not replace per-export JSDoc. Search
shows Intent and an Exports Purpose column side by side; Purpose comes from each
export's JSDoc, not from this section.

## Minimal shape

```md
# Package Name

## Intent

This package exists to ...
```

Keep the section concise. It should explain why the package exists and what
success means for the user, not duplicate every implementation detail.

## Export JSDoc

Search detail (`entity: "…:package"`) shows an Exports table whose **Purpose**
column comes from each export's JSDoc. When JSDoc is missing, Purpose falls back
to the generic string `Package export.` Agents skim that column first when
choosing among sibling exports.

TypeScript types and the export name give call shape when present. They do not
say **when** or **why** to pick one export over another. README `## Intent` is
package-scoped and often does not name every export. Neither replaces per-export
JSDoc.

Do not add a package manifest field, runtime object, saved value, or other Kody
primitive solely to track export purpose. Put it in JSDoc on the exported
function.

When you create or materially change a public export:

1. Write JSDoc immediately above the exported function (or above
   `export default` for a local binding in the same file).
2. Start with one line that states **what** the export does and **when** to call
   it.
3. Add `@param` for each input.
4. Add `@returns`.
5. Add `@example` that **imports** `kody:@scope/id/export` and **calls** it. Do
   not lead with `packages.invoke`.

If the export's `package.json` `exports` entry has a `types` condition, put the
JSDoc on that types file — search reads the types module when it exists. JSDoc
on an imported re-export (`export default foo` where `foo` is imported) is not
attributed; implement the function in the export file (or a local binding in
that file) so the comment sits on the exported symbol.

```ts
/**
 * Format a Discord moderation report for a channel.
 * Use when a human or job needs a readable summary of recent flags.
 *
 * @param input - Channel id and optional lookback window
 * @returns Markdown report body
 *
 * @example
 * import formatReport from 'kody:@scope/discord/format-report'
 *
 * const report = await formatReport({ channelId: '123' })
 */
export default async function formatReport(input: {
	channelId: string
	lookbackHours?: number
}): Promise<{ markdown: string }> {
	return { markdown: '' }
}
```

Treat missing or generic Purpose (`Package export.`) as unfinished work, the
same as a missing README `## Intent` section.

## Package app routing

Production-hosted package apps live at
`https://{username}.kody.run/packages/<kody-id>/<path>` (the username is in the
hostname; the path mount is `/packages/<kody-id>`). Confirmed non-production
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
(including `## Intent`), `kody.searchText`, and [export JSDoc](#export-jsdoc) —
not in `kody.description`. Community listings and Open Graph share cards reuse
this field, so keep it concise.

## `kody.category` (community browse)

Public community listings browse by a closed category. Set
`package.json#kody.category` to one of `integrations`, `examples`,
`productivity`, `apps`, or `utilities` before making the package public. When
the field is omitted, Kody infers a category from well-known tags such as
`github` or `zero-auth`, or files the listing under Other. Tags stay freeform
search keywords; do not use `kody.tags` as a second category vocabulary.

`package.json#kody.id` is optional. If present it must match the package name
leaf (the URL slug). Prefer omitting it and letting the leaf be the slug.

## Package visibility

New packages are always **private**. Visibility is a repo setting
(`package_update` `changes.visibility` or `repo_update`), not
`package.json#private`. Ignore leftover `"private"` in manifests.

- Public means default-branch HEAD is world-readable and forkable and the
  package appears on `/community`.
- Private is owner-only. Going private 404s public URLs; existing forks keep
  their copies. Type the package slug to confirm (`confirm_name` for agents).
- There are no MIT, logo, or README Intent gates to become public.

## Work that does not fit a Worker isolate

Package checks and publish rebuilds bundle every declared npm dependency inside
a short-lived isolate. A large graph (PDF.js / `unpdf`, native addons, browsers,
big WASM) can fail with an isolate memory or CPU reset even when the same import
works in ad hoc `execute`.

Do not vendor the library, switch to a dynamic import, or skip checks. Keep the
Kody package as a thin orchestrator and run the heavy work in a process the
owner operates. Open `search({ entity: "heavy_work_offload:guide" })`.

## Secret-using packages

When a package will use user-scoped secrets (`{{secret:name}}` placeholders or
`kody.secretMounts`):

1. Ensure each secret exists (see `connect_secret:guide` /
   `secret_backed_integration:guide`).
2. Self-authored packages and community forks adopted with
   `community_fork_adopt` after a real source review get automatic read/use
   access to user secrets (host approval still applies; `secret_set` /
   `secret_delete` still need an `allowed_packages` grant). After save/publish,
   read `pending_secret_package_approvals` from the tool result — it is non-null
   only for unadopted community forks.
3. When pending approvals are present, either review the fork source and call
   `community_fork_adopt` with a `review_summary`, or send the user
   `bulk_approval_url` / each `approval_url`.
4. Wait for approval or adoption (when required), then smoke-test from `execute`
   with a static `kody:@scope/package/export` import. Use a read-only export or
   a package-supported dry-run input that actually reads the approved secret
   (for example an authenticated read-only API call), so the smoke test proves
   secret access without external side effects. Secret mounts bind in the
   package's own surfaces (jobs, apps, subscriptions, HTTP invocation).
5. Only then treat the package as ready to run.

Host approval (from an earlier ad hoc `execute` smoke test) is separate from
package approval. Unadopted community-forked packages may need both;
self-authored and adopted packages still need host approval when outbound calls
require it.

## Verify your publish

After publish succeeds — and after any required secret approvals — confirm every
export's search Purpose is real JSDoc (not `Package export.`; see
[Export JSDoc](#export-jsdoc)), then run synthetic smoke tests for every
declared surface before calling the package complete. Synthetic invocations are
real-surface runs with real side effects; use a deliberately visible
irreversible-side-effect guard when a smoke test should stay safe.

1. Read `test_hints` on the `package_publish_external_push` result when present.
   It lists copy-pasteable calls for declared apps and subscription topics.
2. **Exports and secret mounts** — statically import
   `kody:@scope/package/export` from `execute` against a read-only export or
   package-supported dry-run input that exercises approved secrets (see
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

Only after README `## Intent`, per-export JSDoc, and these checks pass (or the
user explicitly skips a surface) treat the package as ready to run.

## Package icon

Public packages should include one root `icon.svg`, `icon.png`, `icon.webp`,
`icon.jpg`, or `icon.jpeg`. `community-icon.*` is still accepted. Prefer a
square visual with a simple silhouette that remains legible at 56 pixels. Keep
it under 2 MiB and 16 megapixels. Kody stores a 256-pixel WebP derivative of
that source (or a generated package-name fallback when the repository has no
icon).

Publishing the package refreshes the catalog listing icon automatically. The
candidate paths win in the order `icon.*` then `community-icon.*` (svg, png,
webp, jpg, jpeg in each group), so when replacing an icon with a different
format (for example svg → png), delete the superseded file in the same commit or
the earlier path in that list keeps winning.
