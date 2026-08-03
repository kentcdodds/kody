# 0003: Repos are the base primitive; packages are an explicit extension

- **Status:** accepted
- **Date:** 2026-08-03

## Context

Users keep hand-rolling file storage because the only repo-backed primitive is
the saved package: documents live chunked in values, attachments in self-managed
R2 buckets, and versioned document stores get reimplemented in package storage.
Cloudflare Artifacts is a general git-compatible store, and the schema already
models repos as the base layer: `entity_sources` maps
`(user_id, entity_kind, entity_id)` to a repo, with packages and jobs as the two
entity kinds. Evaluated alternatives: a Durable-Object-filesystem "workspace"
primitive (rejected — duplicates Artifacts worse, 10 GB DO cap, ~13x storage
cost) and a "data repo" primitive alongside packages (rejected — two lifecycles
for what the storage layer treats as one thing).

## Decision

Repos become the user-facing base primitive: identity, git-remote lane, editing
sessions, history, deletion, export, and entitlements live on the repo. A
package is a repo with an explicitly activated extension that adds publish
semantics (staged `published_commit`, publish checks, bundles) and runtime
surfaces (exports, apps, services, jobs, webhooks). Activation is never inferred
from repo contents; a root `package.json` alone does not make a package. Plain
repos are live-at-HEAD with no publish step.

Two supporting policies:

1. **Large files are gated explicitly, never rewritten.** Repo write and publish
   paths reject files over a per-file limit — 10 MiB, meaning 10,485,760 stored
   bytes (UTF-8 for text, raw bytes for binary) — with guidance to host large
   files externally and commit a link. Kody does not transparently spill files
   to blob storage; Artifacts itself rejects pushes above ~32 MiB of
   decompressed pack content with a raw HTTP 413 (measured 2026-08-03), and git
   LFS is not supported by Artifacts today.
2. **Inference drives nudges, not activation.** Surfaces that can cheaply detect
   a package-shaped plain repo (push/commit results, invocation errors, repo
   detail reads) say so and point at the promote capability, without blocking.

## Consequences

- The simulated-git command surface (`repo_run_commands`) will be replaced by a
  file-level session API (read/write/move/delete, commit, log, diff, revert) in
  a follow-up slice; breaking pre-launch, no compatibility shim.
- "Saved packages are the only top-level persisted primitive" stops being true
  once plain repos ship; docs and MCP guidance then change to "repos are the
  durable home, packages add runtime."
- Entitlements will gain a base `repos` count when plain repos ship;
  `saved_packages` remains the cap on the extension.
- Reconcile and retention lanes must stay kind-aware so publish-pointer logic
  never runs for plain repos.
- Revisit if Artifacts ships LFS or per-file limits change (the 10 MiB gate is a
  policy constant, not a platform ceiling), or if a checkout-plus-execution
  runtime (e.g. `@cloudflare/computer`) is adopted for repo sessions.
