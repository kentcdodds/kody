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

Supply inventory evidence for an already-created, fresh, unbound target and a
separate allowlist whose matching UUID/name entry has `"purpose": "drill"`. Both
target UUID and target name are mandatory. The target must differ from
production in both fields.

```sh
node tools/disaster-recovery/d1-restore-drill-cli.ts \
  --manifest restore-manifest.json \
  --manifest-sha256 <operator-supplied-sha256> \
  --backup backup.sql \
  --baseline restore-baseline.json \
  --inventory d1-inventory.json \
  --allowlist drill-allowlist.json \
  --target-uuid 00000000-0000-4000-8000-000000000000 \
  --target-name app-db-restore-drill
```

This is a dry run. Inspect its ordered commands. Add `--execute` only for the
isolated target. Add `--apply-forward-migrations` to migrate only after baseline
verification. To verify the migrated state, also pass
`--post-forward-baseline post-forward-baseline.json`.

## Canonical readiness

Evidence is an array of `ResourceEvidence` records from
`canonical-readiness.ts`. Every required resource must be supported, completely
inventoried, have source and destination credentials, represent its exact
contract, and include verification evidence. Missing or unknown evidence fails
closed.

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
