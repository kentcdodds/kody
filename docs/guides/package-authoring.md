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
  through repo sessions (`repo_open_session`, `repo_run_commands`,
  `repo_write_file`, `repo_publish_session`).

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

## Package visibility (`private`)

Default new saved packages to `"private": true` in `package.json` unless the
user explicitly wants public **community** publishing.

Like npm, `"private": true` blocks community listings on this deployment.
Account publishing still works so the owner can run the package privately.

- Set `"private": true` when creating or forking a package unless the user asks
  to share it publicly.
- Require explicit user approval before changing `"private"` or creating a
  package without `"private": true`.
- Pass `confirm_private_visibility_change: true` on `package_save` or repo
  publish only after that approval.
- Community publish additionally requires `"private": false` or omitting
  `private`, plus MIT license and README `## Intent`.

## Community icon

Public community packages may include one root `community-icon.svg`,
`community-icon.png`, `community-icon.webp`, `community-icon.jpg`, or
`community-icon.jpeg`. Prefer a square visual with a simple silhouette that
remains legible at 56 pixels. Keep it under 2 MiB and 16 megapixels. Kody
generates a package-name fallback when the repository has no icon.

Publishing the package refreshes the community listing icon automatically. The
candidate paths win in the order listed above, so when replacing an icon with a
different format (for example svg → png), delete the old file in the same commit
or the old format keeps being served.
