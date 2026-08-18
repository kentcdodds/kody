# 0021: Publish-gated packages; no in-process composition runtime

- **Status:** accepted
- **Date:** 2026-08-18

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
- Ad hoc `execute` stays ambient. Packages remain the declared-authority unit
  (`kody.secretMounts`, host approval, integration allowlists,
  `kody.dependencies`).

## Consequences

- Package delete is the inverse of a package existing. Closing leftover
  community listings, minted webhooks, and service DO state is cleanup of that
  inverse, not a new lifecycle.
- Repo checks reject `kody.dependencies` cycles at publish time, including
  reachable cyclic subgraphs the package under check depends on. A saved sibling
  whose published manifest cannot load fails the dependency check instead of
  being treated as a leaf. There is no runtime that leaves cyclic packages
  "permanently inactive."
- Revisit only if a concrete user need requires live in-process composition or a
  package-wide kill switch that is not delete.
