-- User-lane OAuth connects persisted tokens without stamping connected_at
-- (platform-lane upsert already stamped). Credential list status and
-- candidate resolution treat connected_at IS NOT NULL as connected, so those
-- working grants showed "Not connected yet." Stamp every live row that already
-- holds an access token and still has a null connected_at. Prefer the last
-- successful refresh, else updated_at / created_at, so the stamp is historical
-- rather than deploy-time.
UPDATE user_integrations
SET connected_at = COALESCE(token_refreshed_at, updated_at, created_at)
WHERE connected_at IS NULL
	AND deleted_at IS NULL
	AND access_token_encrypted IS NOT NULL
	AND TRIM(access_token_encrypted) != '';
