-- Whether a connection's sign-in expects refresh-token renewal. Written from
-- the provider token response on every /connect/oauth persist; NULL means
-- unknown (no token persisted yet) and refresh treats it like 'required'.
ALTER TABLE user_integrations ADD COLUMN refresh_policy TEXT
	CHECK (refresh_policy IN ('required', 'not_applicable'));

-- Backfill from stored token metadata. A stored refresh token, or any past
-- successful refresh, means renewal is expected. A stored access token with
-- neither is a non-expiring grant (for example a GitHub OAuth App with token
-- expiration off). Rows without an access token stay unknown.
UPDATE user_integrations
SET refresh_policy = CASE
	WHEN (
		refresh_token_encrypted IS NOT NULL
		AND TRIM(refresh_token_encrypted) != ''
	) OR token_refreshed_at IS NOT NULL
	THEN 'required'
	ELSE 'not_applicable'
END
WHERE refresh_policy IS NULL
	AND access_token_encrypted IS NOT NULL
	AND TRIM(access_token_encrypted) != '';

-- Non-expiring grants were never broken for lacking a refresh token. Clear
-- only that snapshot; provider_rejected and other reasons stay.
UPDATE user_integrations
SET auth_failed_at = NULL,
	auth_failed_reason = NULL,
	auth_failed_provider_error = NULL,
	auth_failed_provider_description = NULL,
	auth_failed_http_status = NULL,
	auth_failed_reconnectable = NULL
WHERE refresh_policy = 'not_applicable'
	AND auth_failed_reason = 'missing_refresh_token';
