-- Webhook apply destination approvals pin auth to a stable credential id.
-- Fingerprints used to include secretName / integration by string, so a deleted
-- then recreated name kept the old grant. Grants (#3442 / 0110) already key by
-- credential id; these approvals follow. The destination shape (method, url,
-- headers, body — including host) stays in the fingerprint as today.
--
-- Backfill matches apply's webhook-secret lookup: live, unexpired entry and
-- bucket, kind=secret, package scope for the grant's package_id first, then
-- user scope. Integrations match by lower(trim(name)) (canonical casing).
-- Orphans are dropped so a later recreate cannot inherit them. Runtime
-- dual-reads legacy fingerprints and rewrites them on first use so nothing
-- currently working needs re-approval.

ALTER TABLE webhook_apply_destination_pending
	ADD COLUMN credential_id TEXT;
ALTER TABLE webhook_apply_destination_grants
	ADD COLUMN credential_id TEXT;

-- Package-scoped secret for the approval's package wins over user scope.
UPDATE webhook_apply_destination_pending
SET credential_id = (
	SELECT e.id
	FROM secret_entries e
	JOIN secret_buckets b ON b.id = e.bucket_id
	WHERE b.user_id = webhook_apply_destination_pending.user_id
		AND b.scope = 'package'
		AND b.binding_key = webhook_apply_destination_pending.package_id
		AND e.name = json_extract(destination_json, '$.secretName')
		AND e.kind = 'secret'
		AND e.deleted_at IS NULL
		AND b.deleted_at IS NULL
		AND (e.expires_at IS NULL OR e.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		AND (b.expires_at IS NULL OR b.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	LIMIT 1
)
WHERE json_extract(destination_json, '$.secretName') IS NOT NULL
	AND trim(json_extract(destination_json, '$.secretName')) != '';

UPDATE webhook_apply_destination_grants
SET credential_id = (
	SELECT e.id
	FROM secret_entries e
	JOIN secret_buckets b ON b.id = e.bucket_id
	WHERE b.user_id = webhook_apply_destination_grants.user_id
		AND b.scope = 'package'
		AND b.binding_key = webhook_apply_destination_grants.package_id
		AND e.name = json_extract(destination_json, '$.secretName')
		AND e.kind = 'secret'
		AND e.deleted_at IS NULL
		AND b.deleted_at IS NULL
		AND (e.expires_at IS NULL OR e.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		AND (b.expires_at IS NULL OR b.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	LIMIT 1
)
WHERE json_extract(destination_json, '$.secretName') IS NOT NULL
	AND trim(json_extract(destination_json, '$.secretName')) != '';

UPDATE webhook_apply_destination_pending
SET credential_id = (
	SELECT e.id
	FROM secret_entries e
	JOIN secret_buckets b ON b.id = e.bucket_id
	WHERE b.user_id = webhook_apply_destination_pending.user_id
		AND b.scope = 'user'
		AND b.binding_key = ''
		AND e.name = json_extract(destination_json, '$.secretName')
		AND e.kind = 'secret'
		AND e.deleted_at IS NULL
		AND b.deleted_at IS NULL
		AND (e.expires_at IS NULL OR e.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		AND (b.expires_at IS NULL OR b.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	LIMIT 1
)
WHERE credential_id IS NULL
	AND json_extract(destination_json, '$.secretName') IS NOT NULL
	AND trim(json_extract(destination_json, '$.secretName')) != '';

UPDATE webhook_apply_destination_grants
SET credential_id = (
	SELECT e.id
	FROM secret_entries e
	JOIN secret_buckets b ON b.id = e.bucket_id
	WHERE b.user_id = webhook_apply_destination_grants.user_id
		AND b.scope = 'user'
		AND b.binding_key = ''
		AND e.name = json_extract(destination_json, '$.secretName')
		AND e.kind = 'secret'
		AND e.deleted_at IS NULL
		AND b.deleted_at IS NULL
		AND (e.expires_at IS NULL OR e.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		AND (b.expires_at IS NULL OR b.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	LIMIT 1
)
WHERE credential_id IS NULL
	AND json_extract(destination_json, '$.secretName') IS NOT NULL
	AND trim(json_extract(destination_json, '$.secretName')) != '';

UPDATE webhook_apply_destination_pending
SET credential_id = (
	SELECT i.id
	FROM user_integrations i
	WHERE i.user_id = webhook_apply_destination_pending.user_id
		AND lower(trim(i.name)) = lower(trim(json_extract(destination_json, '$.integration')))
		AND i.deleted_at IS NULL
	LIMIT 1
)
WHERE credential_id IS NULL
	AND json_extract(destination_json, '$.integration') IS NOT NULL
	AND trim(json_extract(destination_json, '$.integration')) != '';

UPDATE webhook_apply_destination_grants
SET credential_id = (
	SELECT i.id
	FROM user_integrations i
	WHERE i.user_id = webhook_apply_destination_grants.user_id
		AND lower(trim(i.name)) = lower(trim(json_extract(destination_json, '$.integration')))
		AND i.deleted_at IS NULL
	LIMIT 1
)
WHERE credential_id IS NULL
	AND json_extract(destination_json, '$.integration') IS NOT NULL
	AND trim(json_extract(destination_json, '$.integration')) != '';

UPDATE webhook_apply_destination_pending
SET destination_json = json_set(destination_json, '$.credentialId', credential_id)
WHERE credential_id IS NOT NULL;

UPDATE webhook_apply_destination_grants
SET destination_json = json_set(destination_json, '$.credentialId', credential_id)
WHERE credential_id IS NOT NULL;

-- Name-keyed auth that no longer resolves must not transfer to a later recreate.
DELETE FROM webhook_apply_destination_pending
WHERE credential_id IS NULL
	AND (
		(
			json_extract(destination_json, '$.secretName') IS NOT NULL
			AND trim(json_extract(destination_json, '$.secretName')) != ''
		)
		OR (
			json_extract(destination_json, '$.integration') IS NOT NULL
			AND trim(json_extract(destination_json, '$.integration')) != ''
		)
	);

DELETE FROM webhook_apply_destination_grants
WHERE credential_id IS NULL
	AND (
		(
			json_extract(destination_json, '$.secretName') IS NOT NULL
			AND trim(json_extract(destination_json, '$.secretName')) != ''
		)
		OR (
			json_extract(destination_json, '$.integration') IS NOT NULL
			AND trim(json_extract(destination_json, '$.integration')) != ''
		)
	);

CREATE INDEX idx_webhook_apply_destination_pending_credential
	ON webhook_apply_destination_pending(credential_id);
CREATE INDEX idx_webhook_apply_destination_grants_credential
	ON webhook_apply_destination_grants(credential_id);
