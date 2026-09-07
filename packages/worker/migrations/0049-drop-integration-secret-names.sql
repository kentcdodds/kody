-- Finish #1773: OAuth tokens and user-lane client secrets live only as
-- ciphertext on the integration/app rows. Delete leftover dual-written
-- secret_entries that existed solely for those names, then drop the soak
-- *_secret_name columns.
DELETE FROM secret_entries
WHERE EXISTS (
	SELECT 1
	FROM secret_buckets b
	JOIN user_integrations i ON i.user_id = b.user_id
	WHERE b.id = secret_entries.bucket_id
		AND b.scope = 'user'
		AND (
			secret_entries.name = i.access_token_secret_name
			OR secret_entries.name = i.refresh_token_secret_name
		)
);

DELETE FROM secret_entries
WHERE EXISTS (
	SELECT 1
	FROM secret_buckets b
	JOIN user_oauth_apps a ON a.user_id = b.user_id
	WHERE b.id = secret_entries.bucket_id
		AND b.scope = 'user'
		AND secret_entries.name = a.client_secret_secret_name
);

ALTER TABLE user_integrations DROP COLUMN access_token_secret_name;

ALTER TABLE user_integrations DROP COLUMN refresh_token_secret_name;

ALTER TABLE user_oauth_apps DROP COLUMN client_secret_secret_name;
