# Feature flags

Admin-managed toggles for gating features while they are developed. Flags answer
exactly one question — "is this feature shipped for this user yet?" — and
deliberately overlap with nothing else: RBAC answers "who may do what" and
entitlements answer "who is allowed how much".

Module: `packages/worker/src/feature-flags/`

- `registry.ts` — the typed flag registry (`featureFlagDefinitions`,
  `FeatureFlagKey`). Flags are created and removed only via code review by
  editing this array; every gate site is compile-checked against it. Flags
  should also declare a `successMetric` (see below).
- `service.ts` — evaluation (`isFeatureEnabled`, `getFeatureFlagsForUser`,
  `getFeatureFlagEvaluationsForUser` with assignment sources) and admin
  mutations (global state, per-user overrides, stale cleanup).
- `exposure.ts` — success-metric exposure recording (which value each user saw
  and how it was assigned).
- `success-metric-readout.ts` — the on/off cohort metric readout for the admin
  surfaces.
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

### Mailbox read cutover (`mailbox-read-cutover`)

Default-off migration flag for phase 3 of the Mailbox expand/contract track (see
[Data storage — Mailbox](./data-storage.md#durable-objects-mailbox)). It gates
whether owner-facing user-mail **reads** (app `/account/email` inbox + detail,
and MCP `email_message_list` / `get` / `search`, `email_attachment_get`,
`email_delivery_event_list`) may come from the per-user Mailbox Durable Object
instead of D1. Writes, inbound, package-subscription, and provider reverse
lookup stay on D1.

Evaluation alone is not enough. A live read path must also pass the per-user
parity soak on `users` (migration `0125-mailbox-parity-state.sql`):

- `mailbox_parity_matching_since` at least **2 hours** old (continuous exact
  D1↔Mailbox count parity). Pre-launch rationale: ~38-user fleet evidence with
  every-5m parity plus fail-closed freshness/mismatch/deleting/identity checks
  (Kent-approved). **TODO(launch-hardening):** revisit lengthening soak when the
  fleet grows.
- `mailbox_parity_checked_at` fresh within **6 hours** (every-5m lane with
  bounded batch scaling; not a strict 5m SLA),
- `mailbox_parity_mismatch_count === 0`,
- exact `stable_user_id` match between the gate caller and the loaded row,
- `deleting_at IS NULL` (accounts marked for deletion fail closed to D1).

D1 errors, missing/incomplete parity state, stale `checked_at`, non-zero
mismatch depth, deleting accounts, and an off flag all **fail closed** to
D1-authoritative reads. When the gate is on, Mailbox DO read errors propagate
with no D1 fallback.

Adapters live in `packages/worker/src/email/mailbox-read-cutover.ts`. The gate
records `mailbox-read-cutover` exposure once per memoized evaluation unless the
app caller already recorded flags via the session cache
(`skipExposureRecording`). Deploy with the flag default-off; operators enable
per user after backup verification (see data-storage).

Success metric: `email_received` error rate should decrease after verified
parity soak and cutover (`successMetric` on the registry definition).

## Success metrics

Every flag exists to move something; the `successMetric` field on a registry
definition states what, in code review, alongside the flag itself:

```ts
successMetric: {
	eventType: 'execute', // a UsageEventType from usage metering
	measure: 'error_rate', // 'event_count' | 'error_rate' | 'avg_duration_ms'
	goal: 'decrease',
	hypothesis: 'One human sentence stating why this flag should move it.',
}
```

The field is compile-checked against the closed `UsageEventType` union
(`packages/worker/src/usage/event-types.ts`), so a flag can only be judged
against a metric the usage-metering pipeline already collects. It stays optional
for genuinely unmeasurable flags (like the permanent `demo-indicator`), but the
admin UI and the `admin_feature_flag_list` capability render a notice strongly
recommending one everywhere else.

### Exposures

Current flag state cannot reconstruct who was inside a percentage rollout last
week, so measured flags record **exposures** at the two evaluation chokepoints
(the app session flag cache and the MCP caller flag resolver):
`(stable user id, flag key, on/off, assignment source, timestamp)`. The write
path mirrors usage metering — the `FLAG_EXPOSURES` Analytics Engine dataset in
production/preview, the D1 `feature_flag_exposure_rollups` table (migration
`0117`, 90-day retention) in local dev and tests — and never throws.

The assignment source (`default` / `global` / `rollout` / `override`) is what
keeps the readout honest: `override` users are hand-picked and excluded from
comparisons, while `rollout` users are deterministically bucketed.

### Readout

`success-metric-readout.ts` joins exposures with the usage event stream for the
declared `eventType` over the current UTC month to date, splits users into
on/off cohorts (excluding override and mixed-exposure users, reported
separately), and aggregates event count, error rate, and average duration per
cohort. The admin UI (`/admin/feature-flags`) and `admin_feature_flag_list`
attach this readout to every measured flag. The comparison is decision support
for a human — "keep rolling out or kill it" stays an operator call, not an
automated one.
