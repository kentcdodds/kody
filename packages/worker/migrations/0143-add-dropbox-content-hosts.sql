-- Dropbox serves its API from three hosts: api.dropboxapi.com (RPC calls),
-- content.dropboxapi.com (uploads and downloads), and notify.dropboxapi.com
-- (longpoll). Hand-built Dropbox connections usually allowed only the first,
-- so every upload and download failed the host check, and reconnecting kept
-- the stored host list. Add the two missing hosts to every live connection
-- whose OAuth app takes its token from Dropbox's token endpoint. A token
-- minted there is only good at Dropbox, so the added hosts reach no one new.
-- Additive and idempotent: no host is removed and no other column changes.
UPDATE user_integrations
SET required_hosts_json = (
	SELECT json_group_array(host)
	FROM (
		SELECT value AS host
		FROM json_each(user_integrations.required_hosts_json)
		UNION
		SELECT value AS host
		FROM json_each(
			'["api.dropboxapi.com","content.dropboxapi.com","notify.dropboxapi.com"]'
		)
		ORDER BY host
	)
)
WHERE deleted_at IS NULL
	AND json_valid(required_hosts_json)
	AND (
		EXISTS (
			SELECT 1
			FROM user_oauth_apps a
			WHERE a.user_id = user_integrations.user_id
				AND a.slug = user_integrations.app_slug
				AND a.deleted_at IS NULL
				AND (
					lower(a.token_url) LIKE 'https://api.dropboxapi.com/%'
					OR lower(a.token_url) LIKE 'https://api.dropbox.com/%'
				)
		)
		OR EXISTS (
			SELECT 1
			FROM platform_oauth_apps p
			WHERE p.slug = user_integrations.platform_app_slug
				AND (
					lower(p.token_url) LIKE 'https://api.dropboxapi.com/%'
					OR lower(p.token_url) LIKE 'https://api.dropbox.com/%'
				)
		)
	)
	AND (
		SELECT count(DISTINCT value)
		FROM json_each(user_integrations.required_hosts_json)
		WHERE value IN (
			'api.dropboxapi.com',
			'content.dropboxapi.com',
			'notify.dropboxapi.com'
		)
	) < 3;
