# Disaster-recovery drills

These tools are manual, isolated readiness and restore-drill aids. They do not
create, bind, overwrite, delete, cut over, or use Time Travel on a D1 database.

## D1 restore drill

The manifest must be the exact immutable schema-v2 envelope downloaded from the
backup control plane. Its separately supplied SHA-256 must match the exact
bytes, and its Ed25519 signature must verify against the sole checked-in
`trusted-backup-manifest-public-keys.json` registry. The algorithm, schema, and
key id are strict. An operator hash, unsigned envelope, unknown key, or caller
key can never authorize restore. Signed source provenance contains the source
account id plus the remotely verified D1 UUID and exact database name; it does
not contain an unverified account display name. Backups at or above 5 GiB are
rejected.

The CLI preflights the operator SQL pathname size, then stream-copies it into a
private temporary directory without buffering the dump in memory. It makes the
snapshot read-only, stats and stream-hashes the snapshot against the signed
manifest, and passes only the snapshot path to Wrangler. Replacing the operator
pathname after staging cannot alter the import. The snapshot is removed in
`finally` after dry-run, execution, or failure.

Schema, migration, sequence, and representative two-user expectations live only
in the checked-in exact-schema `trusted-restore-baselines.json` registry. The
CLI selects entries by `--baseline-id` and optional
`--post-forward-baseline-id`; it accepts no baseline file or registry override.
The selected baseline canonical digest and source must match the signed manifest
and checked production identity. The execution order is import, baseline
verification, optional forward migrations, then optional post-forward baseline
verification. Baseline verification always executes D1's documented
`PRAGMA quick_check` plus `PRAGMA foreign_key_check`.

Production source and drill-target identities are trusted only when they exactly
match entries in the checked-in `trusted-d1-restore-identities.json` registry.
The CLI accepts no alternate registry path. The registry has an exact,
schema-versioned shape:

```json
{
	"schemaVersion": 1,
	"productionSources": [
		{
			"accountId": "<production-account-id>",
			"databaseId": "<production-d1-uuid>",
			"databaseName": "<exact-production-database-name>"
		}
	],
	"drillTargets": [
		{
			"accountId": "<isolated-drill-account-id>",
			"databaseName": "<exact-drill-database-name>"
		}
	]
}
```

Its checked-in lists are intentionally empty. Registry account IDs must be
canonical 32-character lowercase hex, preventing mixed-case duplicate trust
entries. A production source and distinct drill target must be approved by code
review before either dry-run or execution can produce a plan. Runtime account
IDs and D1 UUIDs compare case-insensitively to those canonical entries, while
database names remain exact; source and target accounts must differ. Execution
creates a new D1 database through Cloudflare's create API immediately before
import, then validates the returned UUID, name, and `created_at`. Successful
creation is the empty/unbound evidence.

```sh
node tools/disaster-recovery/d1-restore-drill-cli.ts \
  --manifest restore-manifest.json \
  --manifest-sha256 <operator-supplied-sha256> \
  --backup backup.sql \
  --baseline-id approved-production-baseline \
  --target-account-id isolated-drill-account-id \
  --target-name app-db-restore-drill
```

This is a dry run. Inspect its ordered commands. Add `--execute` only for the
isolated target account after setting `CLOUDFLARE_D1_DRILL_EDIT_TOKEN` to a
drill-only D1 Edit token for that account. The token is used for live creation,
import, and checks and is never printed. `--apply-forward-migrations` is
rejected unless `--post-forward-baseline-id approved-post-forward-baseline` is
also supplied. After target creation the tool writes a temporary Wrangler config
binding `D1_RESTORE_TARGET` to the returned UUID/name and pointing
`migrations_dir` at `packages/worker/migrations`; import, checks, and migrations
all use that config. The local config is removed afterward. The tool never
deletes, binds, cuts over, or modifies production.

## Canonical readiness

Evidence is an array of exact-shape, schema-versioned `ResourceEvidence` index
records from `canonical-readiness.ts`. Each index record binds its resource,
verifier, change, system/build version, performed timestamp, freshness interval,
and artifact metadata. The index `expiresAt` must exactly match every artifact's
metadata and signed content. Every resource requires inventory,
source/destination credential checks, support and contract checks, plus its
resource-specific drill evidence. APP_DB additionally requires a
`d1-size-ceiling-check` whose measured bytes are strictly below a ceiling no
greater than 4,500,000,000 bytes.

Each artifact is JSON with the exact versioned `SignedEvidenceEnvelope` schema.
Its signed content binds the resource and evidence kind, unique URI, source
resource/account identity, destination resource/account identity where
applicable, `passed` outcome, verifier, change, system/build version, performed
timestamp, expiry timestamp, and a strict kind-specific details object.
`performedAt` and `expiresAt` must use millisecond UTC form, and expiry must be
later than performance. The Ed25519 signature is over canonical JSON containing
`schemaVersion` and `content`; the `signature` field is excluded. The index
digest covers the exact envelope file bytes. Index metadata must exactly equal
the signed content, so an index cannot relabel or extend the lifetime of an
otherwise valid artifact.

For `d1-restore-drill`, signed details bind exact manifest bytes, SQL, trusted
baseline, schema, migration-set, and isolation-baseline digests/ids plus the
source bookmark/name, `quick_check`, foreign-key result, and restored UUID.
These values must agree with separately signed source evidence and checked
baseline/source registries. The restored UUID must equal
`destinationIdentity.resourceId`; destination account and resource identities
must both differ from the source.

Every APP_DB signed `sourceIdentity.accountId` and non-null
`destinationIdentity.accountId` must be a canonical Cloudflare account ID:
exactly 32 lowercase ASCII hexadecimal characters. Whitespace, uppercase,
wrong-length, non-hex, and Unicode-lookalike values are rejected without
normalization, even when the envelope is validly signed and its index metadata
matches.

Artifact URIs must be unique `file:` URLs or local filesystem paths (relative
paths are resolved beside the evidence JSON). The CLI never fetches network
URIs. Resolved and real filesystem paths must remain inside the evidence
directory; `..`, absolute/file-URL escape, and symlink escape fail closed. It
reads each referenced file, verifies its exact-byte SHA-256 and Ed25519
signature, and accepts the signing key only from the checked-in
`trusted-readiness-public-keys.json` trust registry. Random bytes, synthetic
metadata, unsigned envelopes, untrusted keys, duplicate URIs, malformed kind
details, and any metadata mismatch fail readiness closed.

The trusted key registry has an exact shape:

```json
{
	"schemaVersion": 1,
	"keys": [
		{
			"algorithm": "Ed25519",
			"keyId": "readiness-2026",
			"publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
		}
	]
}
```

The checked-in registry is intentionally empty until recovery-verifier public
keys are approved in code review. The CLI does not accept an alternate registry
path, so an operator cannot make synthetic evidence trusted by supplying a new
key at runtime. With no approved keys, every readiness level remains
`NOT READY`.

Freshness also has code-owned maximum ages that `expiresAt` cannot extend:
`d1-only` evidence is valid for at most 35 days, `canonical-data` for 100 days,
and `full-service` for 200 days. Evidence exactly on the applicable boundary is
accepted; older evidence fails closed even if its stated expiry is years away.

```sh
node tools/disaster-recovery/canonical-readiness-cli.ts \
  --evidence recovery-evidence.json
```

The command reports `d1-only`, `canonical-data`, and `full-service` separately
and exits nonzero until full-service readiness is proven. Canonical-data
readiness requires external SECRET_STORE_KEY fingerprint, escrow custody, and
recovery-test evidence because restored D1 ciphertext is otherwise unusable; key
material must never enter reports. Full-service readiness additionally requires
Vectorize, bundle KV, derived community icons, alarms, queues/workflows, and
OAuth reauthorization rebuild evidence. OAuth tokens are never copied.
