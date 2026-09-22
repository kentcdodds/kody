# Feature flags

Admin-managed toggles for gating features while they are developed. Flags answer
exactly one question — "is this feature shipped for this user yet?" — and
deliberately overlap with nothing else: RBAC answers "who may do what" and
entitlements answer "who is allowed how much".

Modules: `packages/worker/universal/feature-flags/` (registry and transport
types) and `packages/worker/src/feature-flags/` (D1 evaluation and admin
mutations).

- `universal/feature-flags/registry.ts` — the typed flag registry
  (`featureFlagDefinitions`, `FeatureFlagKey`). Flags are created and removed
  only via code review by editing this array; every gate site is compile-checked
  against it. Flags should also declare a `successMetric` (see below). Optional
  `defaultAudience` (`everyone` when omitted) is used when no global row exists
  and as the first-insert default when an operator enables a flag without an
  explicit audience.
- `universal/feature-flags/types.ts` — dependency-free transport types shared
  with the client bundle.
- `service.ts` — evaluation (`isFeatureEnabled`, `getFeatureFlagsForUser`,
  `getFeatureFlagEvaluationsForUser` with assignment sources) and admin
  mutations (global state, per-user overrides, stale cleanup).
- `exposure.ts` — success-metric exposure recording (which value each user saw
  and how it was assigned).
- `success-metric-readout.ts` — the on/off cohort metric readout for the admin
  surfaces.

## The registry-owns-existence invariant

The database stores **state**, never **existence**. The squashed baseline
(`packages/worker/migrations/0001-squashed-init.sql`) defines two tables, later
extended by `0065-experiments-opt-in.sql`:

- `feature_flags` — at most one global row per key: `enabled`, `rollout_percent`
  (nullable), `audience` (`everyone` | `experiments_opt_in`, default
  `everyone`), `note`, `updated_by`, `updated_at`. No row means "use the
  registry default" with audience `everyone`.
- `feature_flag_user_overrides` — per-user forced on/off, keyed by
  `(flag_key, user_id)`, cascade-deleted with the user and covered by account
  export/deletion targets.
- `users.experiments_opt_in` — account preference (0/1) for the
  `experiments_opt_in` flag audience, edited at `/account/experiments`.

Removing a flag from the registry breaks the build at every remaining gate site;
leftover DB rows for removed keys surface as **stale** in the admin UI
(delete-only — `deleteStaleFeatureFlag` refuses keys still in the registry).

## Evaluation precedence

1. Per-user override row (wins over everything, including audience).
2. Global row: off → off; on with `rollout_percent` set → deterministic FNV-1a
   bucket of `key:userId` compared to the percentage (anonymous users are
   excluded from percentage rollouts); on without a percentage → on.
3. Registry `defaultEnabled`.
4. **Audience gate** (when the global row's `audience` is not `everyone`): if
   the evaluation would be on and the audience is `experiments_opt_in`, the user
   must have `users.experiments_opt_in = 1` (set from `/account/experiments`).
   Otherwise the flag stays off and keeps the same assignment source. No global
   row means audience `everyone`.

Evaluation failures for authenticated users **fail closed** (all flags off) so a
default-on flag can never bypass an operator kill switch when D1 is unavailable.

### Experiments audience

Signed-in users opt in or out at `/account/experiments`
(`GET|POST /account/experiments.json` with `{ "experimentsOptIn": boolean }`).
That writes `users.experiments_opt_in`. Operators then target that audience on a
flag:

- **Admin UI**: `/admin/feature-flags` → Audience → “Experiments opt-in”.
- **MCP**:
  `adminFeatureFlagSet({ key, enabled: true, audience: "experiments_opt_in" })`.

Audience values: `everyone` (default) | `experiments_opt_in`. Distinct from
site-banner audiences.

## Surfaces

- **Admin UI**: `/admin/feature-flags` (+ `/admin/feature-flags.json` API),
  admin-role gated, audited via `logAuditEvent` (`feature_flag_*` actions).
- **MCP capabilities**: `adminFeatureFlagList`, `adminFeatureFlagSet`,
  `adminFeatureFlagOverride` (admin role required, audited).
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
end-to-end (`e2e/admin-feature-flags.spec.ts`). Experiment flags such as
`compact-mcp-server-instructions` live in the same registry and are removed in
the same way: delete the definition and every gate site.

`jev-search-rerank` is a kill switch (default **off**) for improved ranked MCP
`search({ query })`. When the flag is on, **paid** plans (`standard` / `pro` /
`max`) widen hybrid recall and may run Workers AI `typesafe/jev` Score through
AI Gateway when the post-hybrid pool looks ambiguous. Free and anonymous never
call Jev. The plan gate is a **feature gate**, not an entitlement / usage
counter. Pricing-page “improved search” copy is gated by the same flag
(`isFeatureFlagEnabled` on the session) so the claim is not visible while the
experiment is off. Offline/deterministic search skips Jev and uses hybrid order.
See [Search](../../use/search.md) for skip reasons, telemetry, and Gateway
requirements. Enable for dogfood with
`adminFeatureFlagOverride({ key: "jev-search-rerank", username: "kentcdodds", enabled: true })`.
Remove the flag and gate sites when the experiment ends.

`execute-invoke` is an experiment (default **off**, registry
`defaultAudience: experiments_opt_in`) for the MCP `execute` `invoke` shortcut.
When on for a caller, the execute tool advertises `invoke` (a
`kody:@scope/package/export` specifier) and generates the same thin passthrough
source a careful agent would write, then runs the existing execute path. When
off, `invoke` is omitted from the tool schema and rejected if sent. The declared
`successMetric` is `dynamic_worker_day` event count, goal decrease: stable
invoke-generated graphs should reuse one isolate per package export instead of
burning a unique worker-day per rewritten glue module. Exposures are recorded
when the MCP execute tool is registered (invoke offered). Enable for experiment
members with
`adminFeatureFlagSet({ key: "execute-invoke", enabled: true, audience: "experiments_opt_in" })`.
Remove the flag and gate sites when the experiment ends.

`python-execute` is an experiment (default **off**, registry
`defaultAudience: experiments_opt_in`) for a Python `execute` language and
`pythonPackageInvoke`. When on for a caller, MCP `execute` accepts
`language: "python"` (one module with `main(params)` and
`await kody.call(name, args)`, bridged through the `PythonCapabilityBridge`
loopback export) and search lists the in-memory package invoke capability.
TypeScript execute is unchanged when `language` is omitted. The declared
`successMetric` is `execute` average duration, goal decrease. Enable for
experiment members with
`adminFeatureFlagSet({ key: "python-execute", enabled: true, audience: "experiments_opt_in" })`.
Remove the flag and gate sites when the experiment ends. The bakeoff harness
lives at `tools/python-execute-eval/`.

`compute-overage-charging` is a billing gate, not an experiment (no
`successMetric`). Registry default is **on**. When on, the
`compute_overage_billing` lane creates standalone Stripe invoices for
public-ladder unique worker-day and Durable Object rows-read overage when
`resolveComputeOverageDisposition` returns `invoice`. Unpaid Free is a
soft-block. Legacy Standard/Pro stays unbilled. To dry-run without charging, set
the **global** flag off at `/admin/feature-flags` (or `adminFeatureFlagSet`).
Global off is a hard gate: a per-user on override cannot charge. A per-user off
override still dry-runs that account while global is on. A percentage rollout is
still globally on — in-bucket users charge. D1 evaluation failures fail closed
(all flags off, so no charges).

`package-share-grants` is a rollout kill switch for person-to-person package
shares (invite, accept, UI, MCP, and runtime use). Registry default is **off**.
Signed-in users can opt themselves in from `/docs/package-sharing` (a per-user
on override). Operators can also enable it globally at `/admin/feature-flags`
(or `adminFeatureFlagSet`). Evaluation failures fail closed. No `successMetric`:
this is not an experiment. Remove the flag and every gate site after general
availability.

`secret-providers` is a rollout kill switch for pluggable external secret
providers (placeholders, account bindings, sealed resolve, package grants, and
the `/account/secret-providers` UI). Registry default is **off**. Signed-in
users can opt themselves in from `/docs/secret-providers` (a per-user on
override). Operators can also enable it globally at `/admin/feature-flags` (or
`adminFeatureFlagSet`). Evaluation failures fail closed. No `successMetric`:
this is not an experiment. See [secret providers](../secret-providers.md).
Remove the flag and every gate site after general availability.

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
(`packages/worker/universal/usage-event-types.ts`), so a flag can only be judged
against a metric the usage-metering pipeline already collects. It stays optional
for genuinely unmeasurable flags (like the permanent `demo-indicator`), but the
admin UI and the `adminFeatureFlagList` capability render a notice strongly
recommending one everywhere else.

### Exposures

Current flag state cannot reconstruct who was inside a percentage rollout last
week, so measured flags record **exposures** at the two evaluation chokepoints
(the app session flag cache and the MCP caller flag resolver):
`(stable user id, flag key, on/off, assignment source, timestamp)`. The write
path mirrors usage metering — the `FLAG_EXPOSURES` Analytics Engine dataset in
production/preview, the D1 `feature_flag_exposure_rollups` table (migration
`0001-squashed-init.sql`, 90-day retention) in local dev and tests — and never
throws.

The assignment source (`default` / `global` / `rollout` / `override`) is what
keeps the readout honest: `override` users are hand-picked and excluded from
comparisons, while `rollout` users are deterministically bucketed.

### Readout

`success-metric-readout.ts` joins exposures with the usage event stream for the
declared `eventType` over the current UTC month to date, splits users into
on/off cohorts (excluding override and mixed-exposure users, reported
separately), and aggregates event count, error rate, and average duration per
cohort. The admin UI (`/admin/feature-flags`) and `adminFeatureFlagList` attach
this readout to every measured flag. The comparison is decision support for a
human — "keep rolling out or kill it" stays an operator call, not an automated
one.
