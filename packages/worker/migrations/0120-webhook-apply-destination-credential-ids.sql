-- Webhook apply destination approvals pin auth to a stable credential id.
-- Fingerprints used to include secretName / integration by string, so a deleted
-- then recreated name kept the old grant. Grants (#3442 / 0110) already key by
-- credential id; these approvals follow. The destination shape (method, url,
-- headers, body — including host) stays in the fingerprint as today.
--
-- Backfill: every live approval whose secretName or integration resolves to
-- exactly one credential TODAY gets that id. Orphans (name present, no live
-- credential) are dropped so a later recreate cannot inherit them. Runtime
-- dual-reads legacy name-keyed fingerprints and rewrites them to id-keyed ones
-- on first use so nothing currently working needs re-approval.

ALTER TABLE webhook_apply_destination_pending
	ADD COLUMN credential_id TEXT;
ALTER TABLE webhook_apply_destination_grants
	ADD COLUMN credential_id TEXT;

UPDATE webhook_apply_destination_pending
SET credential_id = (
	SELECT e.id
	FROM secret_entries e
	JOIN secret_buckets b ON b.id = e.bucket_id
	WHERE b.user_id = webhook_apply_destination_pending.user_id
		AND b.scope = 'user'
		AND b.binding_key = ''
		AND e.name = json_extract(destination_json, '$.secretName')
		AND e.deleted_at IS NULL
		AND b.deleted_at IS NULL
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
		AND b.scope = 'user'
		AND b.binding_key = ''
		AND e.name = json_extract(destination_json, '$.secretName')
		AND e.deleted_at IS NULL
		AND b.deleted_at IS NULL
	LIMIT 1
)
WHERE json_extract(destination_json, '$.secretName') IS NOT NULL
	AND trim(json_extract(destination_json, '$.secretName')) != '';

UPDATE webhook_apply_destination_pending
SET credential_id = (
	SELECT i.id
	FROM user_integrations i
	WHERE i.user_id = webhook_apply_destination_pending.user_id
		AND i.name = json_extract(destination_json, '$.integration')
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
		AND i.name = json_extract(destination_json, '$.integration')
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
