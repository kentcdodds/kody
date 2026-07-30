-- Persist per-bucket StorageRunner byte estimates on the ownership inventory
-- so storage-byte entitlement checks no longer fan out getEstimatedBytes RPCs
-- across every inventoried Durable Object on mutating writes. NULL means "not
-- yet measured"; the next mutating entitlement check probes that bucket once
-- and records the result. Estimate writes are UPDATE-only so they can never
-- recreate rows for a deleted user or deleted bucket.

ALTER TABLE user_storage_buckets ADD COLUMN estimated_bytes INTEGER;
ALTER TABLE user_storage_buckets ADD COLUMN estimated_bytes_updated_at TEXT;
