-- Platform OAuth app connections snapshot required hosts when they are created.
-- Bring existing Google connections forward to the operator-owned app's current
-- defaults without removing any connection-specific hosts. User-owned OAuth
-- app connections have a NULL platform_app_slug and are intentionally excluded.
UPDATE user_integrations
SET required_hosts_json = (
	SELECT json_group_array(host)
	FROM (
		SELECT value AS host
		FROM json_each(user_integrations.required_hosts_json)
		UNION
		SELECT value AS host
		FROM json_each(
			(
				SELECT required_hosts_json
				FROM platform_oauth_apps
				WHERE slug = user_integrations.platform_app_slug
			)
		)
		ORDER BY host
	)
)
WHERE platform_app_slug IN (
	SELECT slug
	FROM platform_oauth_apps
	WHERE provider = 'google' OR slug = 'google-platform'
);
