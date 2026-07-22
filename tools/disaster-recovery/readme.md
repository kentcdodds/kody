# Disaster-recovery drills

These tools are manual, isolated readiness and restore-drill aids. They do not
create, bind, overwrite, delete, cut over, or use Time Travel on a D1 database.

## D1 restore drill

The manifest must be the exact immutable JSON downloaded from the backup control
plane. Its SHA-256 is supplied separately by the operator and checked against
the downloaded bytes before JSON parsing. The local SQL file's exact bytes,
size, and SHA-256 are then checked against that manifest. Backups larger than 5
GiB are rejected.

Schema, migration, sequence, and representative two-user expectations live in a
separate baseline JSON file. The execution order is import, baseline
verification, optional forward migrations, then optional post-forward baseline
verification. Baseline verification always includes SQLite integrity and
foreign-key checks.

Supply a target account/name allowlist whose matching entry has
`"purpose": "drill"`. The target account must differ from the manifest's source
account. Dry-run is non-mutating. Execution does not accept inventory evidence:
it creates a new D1 database through Cloudflare's create API immediately before
import, then validates the returned UUID, name, and `created_at`. Successful
creation is the empty/unbound evidence.

```sh
node tools/disaster-recovery/d1-restore-drill-cli.ts \
  --manifest restore-manifest.json \
  --manifest-sha256 <operator-supplied-sha256> \
  --backup backup.sql \
  --baseline restore-baseline.json \
  --allowlist drill-allowlist.json \
  --target-account-id isolated-drill-account-id \
  --target-name app-db-restore-drill
```

This is a dry run. Inspect its ordered commands. Add `--execute` only for the
isolated target account after setting `CLOUDFLARE_D1_DRILL_EDIT_TOKEN` to a
drill-only D1 Edit token for that account. The token is used for live creation,
import, and checks and is never printed. `--apply-forward-migrations` is
rejected unless `--post-forward-baseline post-forward-baseline.json` is also
supplied. The tool never deletes, binds, cuts over, or modifies production.

## Canonical readiness

Evidence is an array of exact-shape, dated `ResourceEvidence` records from
`canonical-readiness.ts`. Each record identifies its verifier and change,
defines a freshness interval, and supplies typed artifact records with URI and
lowercase SHA-256. Every resource requires inventory, source/destination
credential checks, support and contract checks, plus its resource-specific drill
artifact. Unknown, duplicate, malformed, expired, or future attestations fail
the entire report closed.

Artifact URIs must be `file:` URLs or local filesystem paths (relative paths are
resolved beside the evidence JSON). The CLI never fetches network URIs. It reads
every referenced file locally, computes SHA-256, and requires the digest to
match the attestation; missing, unreadable, non-local, or mismatched artifacts
fail readiness.

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
