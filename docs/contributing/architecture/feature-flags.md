# Feature flags

Admin-managed toggles for gating features while they are developed. Flags answer
exactly one question — "is this feature shipped for this user yet?" — and
deliberately overlap with nothing else: RBAC answers "who may do what" and
entitlements answer "who is allowed how much".

Module: `packages/worker/src/feature-flags/`

- `registry.ts` — the typed flag registry (`featureFlagDefinitions`,
  `FeatureFlagKey`). Flags are created and removed only via code review by
  editing this array; every gate site is compile-checked against it.
- `service.ts` — evaluation (`isFeatureEnabled`, `getFeatureFlagsForUser`) and
  admin mutations (global state, per-user overrides, stale cleanup).
- `types.ts` — dependency-free transport types shared with the client tsconfig.

## The registry-owns-existence invariant

The database stores **state**, never **existence**. Migration
`0064-feature-flags.sql` adds two tables:

- `feature_flags` — at most one global row per key: `enabled`, `rollout_percent`
  (nullable), `note`, `updated_by`, `updated_at`. No row means "use the registry
  default".
- `feature_flag_user_overrides` — per-user forced on/off, keyed by
  `(flag_key, user_id)`, cascade-deleted with the user and covered by account
  export/deletion targets.

Removing a flag from the registry breaks the build at every remaining gate site;
leftover DB rows for removed keys surface as **stale** in the admin UI
(delete-only — `deleteStaleFeatureFlag` refuses keys still in the registry).

## Evaluation precedence

1. Per-user override row (wins over everything).
2. Global row: off → off; on with `rollout_percent` set → deterministic FNV-1a
   bucket of `key:userId` compared to the percentage (anonymous users are
   excluded from percentage rollouts); on without a percentage → on.
3. Registry `defaultEnabled`.

Evaluation failures for authenticated users **fail closed** (all flags off) so a
default-on flag can never bypass an operator kill switch when D1 is unavailable.

## Surfaces

- **Admin UI**: `/admin/feature-flags` (+ `/admin/feature-flags.json` API),
  admin-role gated, audited via `logAuditEvent` (`feature_flag_*` actions).
- **MCP capabilities**: `admin_feature_flag_list`, `admin_feature_flag_set`,
  `admin_feature_flag_override` (admin role required, audited).
- **Client**: evaluated per-request in `loadSessionInfo` (cached per request in
  `request-feature-flags-cache.ts`) and shipped as `session.featureFlags`; gate
  UI with `isFeatureFlagEnabled(session, key)` from
  `packages/worker/client/feature-flags.ts`.
- **Capability gating**: a capability definition may declare
  `featureFlag: <key>`; `access-control.ts` hides it from search and denies
  execution when the flag evaluates off for the caller. Flag-gated capabilities
  require an authenticated caller whose stable id resolves to a `users.id`;
  anonymous callers, unresolvable identities, missing flag maps, and evaluation
  failures all fail closed. The flag map is only resolved when the registry
  actually contains a gated capability.

The registry ships with one permanent flag, `demo-indicator`, which renders a
small badge in the app chrome and exists so the system stays exercised
end-to-end (`e2e/admin-feature-flags.spec.ts`).
