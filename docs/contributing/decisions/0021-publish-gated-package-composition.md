# 0021: Publish-gated packages; no in-process composition runtime

- **Status:** accepted
- **Date:** 2026-08-18
- **Amended:** 2026-10-10 (Teams: ambient credential use requires per-resource
  `secret:use` / `integration:use`; delete the pre-Teams ambient skip)
- **Superseded in part by:**
  [0068](./0068-credentials-own-placement-scoped-clients.md) (credential
  authority for scoped clients only; Key placeholders keep this record; see the
  note at the end)

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
  grants, `kody.dependencies`). A package's slot binding / allowlist is itself
  the grant for package runs: the binder needs Use at bind time; the runner
  needs `package:execute`, not per-credential Use. Ad hoc `execute` has no
  package attachment: it may still resolve org credentials by name, but only
  when the acting person holds `secret:use` / `integration:use` on that concrete
  credential, by its stable credential id
  ([ADR 0062](./0062-one-access-check.md)). There is no ambient skip of org
  RBAC.

**Amended (2026-10-10):** Before Teams, "ad hoc execute stays ambient" was read
as skipping per-resource use checks. With org members and outside collaborators,
that skipped `authorize` on placeholder expansion and let any actor with
`org:execute` use every unlocked org secret and integration. Resolution now
calls `authorize` for ad-hoc (no package secret authority) paths in the fetch
gateway, JWT sign, provider door keys, and connected MCP servers.
Package-authority runs keep package attachment / mounts / usageMode only — do
not require the runner to hold Use on each bound credential. Automation acts as
Owner and keeps using the org's attachments. Credential storage lookups use
`ownerIdFromCaller` (org), not the acting person id.

**Amended (2026-10-10, local execute):** CLI `execute --local` CapabilityProxy
hops may stamp a client-supplied package id. That stamp is **not** bundler
provenance: origin verifies `package:execute` when present, but never skips
`secret:use` / `integration:use` from it. Only cloud / hosted package runs,
where the bundler proves package identity, keep package-attachment credential
semantics.

**Amended (2026-10-10, credential door):** Every resolution goes through
`resolveCredential(orgId, actor, packageStamp)`
(`packages/worker/src/credentials/resolve-credential.ts`). The package stamp is
`attested` (the server knows the package) or `claimed` (a client named it); only
`attested` skips the actor's Use. The door also re-checks that the actor still
has access to the org at resolve time and writes one org audit row per
resolution. Credential storage is read nowhere else.

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
  without a Use grant on that resource. Hosted package runs with
  `package:execute` still use that package's attachments only. CLI `--local`
  package stamps never skip Use. Owners and Automation are unchanged.
- Revisit only if a concrete user need requires live in-process composition or a
  package-wide kill switch that is not delete.

**Superseded in part (2026-10-11):**
[0068](./0068-credentials-own-placement-scoped-clients.md) replaces the
credential authority this record describes: the package as the unit of declared
authority (`kody.secretMounts`, integration allowlists, provider grants), the
slot binding or allowlist as the grant for package runs, package-attachment
semantics for runners, and the `attested` stamp skipping the actor's Use. Under
0068 the only authority is the actor's Use plus `package:execute`, and package
stamps select needs and storage only. The publish-gated, snapshot-isolated
composition decision is unchanged.

**Narrowed (2026-10-12):** 0068's authority change applies only to the opt-in
credential types used through scoped clients. Key credentials (today's secrets
and their placeholders) keep the authority this record describes, permanently:
package attachments, `kody.secretMounts`, allowlists, provider grants, and the
`attested` stamp.
