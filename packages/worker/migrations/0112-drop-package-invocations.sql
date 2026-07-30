-- Retire the legacy keyed package-invocation idempotency ledger. The ledger
-- moved into the per-user RunLog Durable Object (see
-- docs/contributing/architecture/run-records.md); writes stopped with that
-- migration and the dual-read fallback was removed together with this drop.
-- Pre-migration keys stop replaying and simply execute fresh on redelivery
-- (explicitly accepted when the dual-read window was waived).
-- package_invocation_tokens is unrelated auth state and stays.
DROP TABLE IF EXISTS package_invocations;
