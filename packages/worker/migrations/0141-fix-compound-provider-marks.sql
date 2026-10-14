-- providerFromSlug used to take the segment before the first hyphen for every
-- slug (kody-exchange → kody, cal-com → cal). That invents a non-mark family
-- and breaks credential need matching for packages that correctly declare the
-- full provider mark. Collapse into a parent only when the parent is itself a
-- known mark (google-calendar → google); restore full-slug providers for the
-- compound marks whose first segment is not a mark.
--
-- Keep this list aligned with multi-segment keys in
-- default-provider-mark-aliases.ts whose first segment is NOT also a key.

UPDATE user_oauth_apps
SET provider = slug
WHERE deleted_at IS NULL
	AND (
		(slug = 'kody-exchange' AND provider = 'kody')
		OR (slug = 'cal-com' AND provider = 'cal')
	);

UPDATE user_integrations
SET provider = name
WHERE deleted_at IS NULL
	AND (
		(name = 'kody-exchange' AND provider = 'kody')
		OR (name = 'cal-com' AND provider = 'cal')
	);

-- Connections that reused a shared app slug still inherit from the app after
-- the app backfill above.
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
	AND app_slug IN ('kody-exchange', 'cal-com')
	AND provider IN ('kody', 'cal');
