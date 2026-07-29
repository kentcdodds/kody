-- Delete app-scoped value buckets that the old getStorageBindingKey fallback
-- keyed by ad hoc job:/exec: storage ids. App-scoped values are package config
-- keyed by saved package id (appId); those prefixes are never real package ids,
-- and the saved_packages guard makes the delete unreachable for package config.

DELETE FROM value_buckets
WHERE scope = 'app'
	AND (binding_key LIKE 'job:%' OR binding_key LIKE 'exec:%')
	AND binding_key NOT IN (SELECT id FROM saved_packages);
