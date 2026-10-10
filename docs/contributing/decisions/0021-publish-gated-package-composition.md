# 0021: Publish-gated packages; no in-process composition runtime

- **Status:** accepted
- **Date:** 2026-08-18
- **Amended:** 2026-10-10 (Teams: ambient credential use requires per-resource
  `secret:use` / `integration:use`; delete the pre-Teams ambient skip)

## Context

A preprint on spatiotemporal composability (Cordis / Koishi) describes
in-process plugin load/unload, reactive dependent deactivation, and live
self-modification of an agent harness. Those ideas map onto Kody's packages,
jobs, services, and community listings, so they needed an explicit decision
against project intent (personal software, per-user isolation, compact MCP
surface, Workers isolates). Versioning and auto-republish of dependents are
already declined in [0001](./0001-no-package-versioning.md). Session-trace
self-improvement is declined in [0008](./0008-declined-adlc-primitives.md).

## Decision

Keep Kody publish-gated and snapshot-isolated:

- Agents create and publish packages under existing checks and secret/host
  approval. They do not hot-patch a running harness or skip those gates.
- Do not adopt an in-process fiber/HMR/context-proxy composition runtime. Worker
  Loader isolates plus durable surfaces are the composition model.
- Do not add a package-level disable primitive. Jobs and webhooks already have
  per-surface enable flags; `hidden` is search visibility; full stop is delete.
- Do not deactivate or auto-republish dependents when a provider changes or is
  deleted. Publish already reports stale static snapshots for the agent to
  decide.
- Packages remain the declared-authority unit for _which_ credentials a run may
  touch (`kody.secretMounts`, host approval, integration allowlists, provider
  grants, `kody.dependencies`). Ad hoc `execute` has no package attachment: it
  may still resolve org credentials by name, but only when the acting person
  holds `secret:use` / `integration:use` on that concrete resource
  ([ADR 0062](./0062-one-access-check.md)). There is no ambient skip of org
  RBAC.

**Amended (2026-10-10):** Before Teams, "ad hoc execute stays ambient" was read
as skipping per-resource use checks. With org members and outside collaborators,
that skipped `authorize` on placeholder expansion and let any actor with
`org:execute` use every unlocked org secret and integration. Resolution now
calls `authorize` for ambient (no package secret authority) paths in the fetch
gateway, JWT sign, provider door keys, and connected MCP servers.
Package-authority runs keep package attachment only. Automation acts as Owner
and keeps using the org's attachments.

## Consequences

- Package delete is the inverse of a package existing. Closing leftover
  community listings, minted webhooks, and service DO state is cleanup of that
  inverse, not a new lifecycle.
- Repo checks reject `kody.dependencies` cycles at publish time, including
  reachable cyclic subgraphs the package under check depends on. A saved sibling
  whose published manifest cannot load fails the dependency check instead of
  being treated as a leaf. There is no runtime that leaves cyclic packages
  "permanently inactive."
- A member or outside collaborator who can run ad hoc execute cannot expand
  `{{secret:…}}` / `{{integration-token:…}}` (or ambient provider / MCP use)
  without a Use grant on that resource. Owners and Automation are unchanged.
- Revisit only if a concrete user need requires live in-process composition or a
  package-wide kill switch that is not delete.
