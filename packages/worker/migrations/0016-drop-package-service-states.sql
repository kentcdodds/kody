DROP INDEX IF EXISTS idx_package_service_states_user_status;
DROP TABLE IF EXISTS package_service_states;
DELETE FROM user_storage_buckets WHERE kind = 'service';
