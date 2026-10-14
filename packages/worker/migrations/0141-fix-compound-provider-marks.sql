-- providerFromSlug used to take the segment before the first hyphen for every
-- slug (kody-exchange → kody, cal-com → cal). That invents a non-mark family
-- and breaks credential need matching for packages that correctly declare the
-- full provider mark. Collapse into a parent only when the parent is itself a
-- known mark (google-calendar → google); restore full-mark providers for the
-- compound marks whose first segment is not a mark, including suffixed account
-- names (kody-exchange-work) and platform-lane rows.
--
-- Keep this list aligned with multi-segment keys in
-- default-provider-mark-aliases.ts whose first segment is NOT also a key.

UPDATE platform_oauth_apps
SET provider = slug
WHERE (slug = 'kody-exchange' AND provider = 'kody')
	OR (slug = 'cal-com' AND provider = 'cal');

UPDATE user_oauth_apps
SET provider = CASE
	WHEN slug = 'kody-exchange' OR slug LIKE 'kody-exchange-%' THEN 'kody-exchange'
	WHEN slug = 'cal-com' OR slug LIKE 'cal-com-%' THEN 'cal-com'
	ELSE provider
END
WHERE deleted_at IS NULL
	AND (
		((slug = 'kody-exchange' OR slug LIKE 'kody-exchange-%') AND provider = 'kody')
		OR ((slug = 'cal-com' OR slug LIKE 'cal-com-%') AND provider = 'cal')
	);

UPDATE user_integrations
SET provider = CASE
	WHEN name = 'kody-exchange'
		OR name LIKE 'kody-exchange-%'
		OR app_slug = 'kody-exchange'
		OR app_slug LIKE 'kody-exchange-%'
		OR platform_app_slug = 'kody-exchange'
		THEN 'kody-exchange'
	WHEN name = 'cal-com'
		OR name LIKE 'cal-com-%'
		OR app_slug = 'cal-com'
		OR app_slug LIKE 'cal-com-%'
		OR platform_app_slug = 'cal-com'
		THEN 'cal-com'
	ELSE provider
END
WHERE deleted_at IS NULL
	AND (
		(
			provider = 'kody'
			AND (
				name = 'kody-exchange'
				OR name LIKE 'kody-exchange-%'
				OR app_slug = 'kody-exchange'
				OR app_slug LIKE 'kody-exchange-%'
				OR platform_app_slug = 'kody-exchange'
			)
		)
		OR (
			provider = 'cal'
			AND (
				name = 'cal-com'
				OR name LIKE 'cal-com-%'
				OR app_slug = 'cal-com'
				OR app_slug LIKE 'cal-com-%'
				OR platform_app_slug = 'cal-com'
			)
		)
	);

-- Connections that reused a shared app slug still inherit from the app after
-- the app backfill above. Require a live app so a soft-deleted app cannot
-- NULL out provider.
UPDATE user_integrations
SET provider = (
		SELECT a.provider
		FROM user_oauth_apps a
		WHERE a.user_id = user_integrations.user_id
			AND a.slug = user_integrations.app_slug
			AND a.deleted_at IS NULL
	)
WHERE deleted_at IS NULL
	AND app_slug IS NOT NULL
	AND (
		app_slug = 'kody-exchange'
		OR app_slug LIKE 'kody-exchange-%'
		OR app_slug = 'cal-com'
		OR app_slug LIKE 'cal-com-%'
	)
	AND provider IN ('kody', 'cal')
	AND EXISTS (
		SELECT 1
		FROM user_oauth_apps a
		WHERE a.user_id = user_integrations.user_id
			AND a.slug = user_integrations.app_slug
			AND a.deleted_at IS NULL
	);
