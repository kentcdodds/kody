DROP INDEX IF EXISTS idx_package_service_states_user_status;
DROP TABLE IF EXISTS package_service_states;
-- Keep leftover kind='service' user_storage_buckets rows. D1 cannot purge
-- StorageRunner Durable Objects, and those inventory rows are the only
-- user→storage_id map for account export, deletion, and DR. The
-- storage_bucket_estimate_backfill lane clears those DOs and then deletes
-- the rows.
