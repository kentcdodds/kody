-- Non-destructive prerequisite for the separately reviewed legacy USER email
-- graph drop. Only the independently deployed backup control plane writes this
-- singleton after creating and cryptographically verifying a fresh immutable
-- export. This migration does not drop or mutate any legacy graph data.
CREATE TABLE email_user_graph_drop_approval (
	singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
	request_id TEXT NOT NULL CHECK (
		length(request_id) = 36
		AND request_id = lower(request_id)
		AND substr(request_id, 9, 1) = '-'
		AND substr(request_id, 14, 1) = '-'
		AND substr(request_id, 19, 1) = '-'
		AND substr(request_id, 24, 1) = '-'
		AND replace(request_id, '-', '') NOT GLOB '*[^0-9a-f]*'
		AND substr(request_id, 15, 1) GLOB '[1-8]'
		AND substr(request_id, 20, 1) GLOB '[89ab]'
	),
	nonce TEXT NOT NULL CHECK (
		length(nonce) = 32
		AND nonce = lower(nonce)
		AND nonce NOT GLOB '*[^0-9a-f]*'
	),
	authority_frozen_at TEXT NOT NULL CHECK (
		julianday(authority_frozen_at) IS NOT NULL
		AND authority_frozen_at =
			strftime('%Y-%m-%dT%H:%M:%fZ', authority_frozen_at)
	),
	authority_owner_count INTEGER NOT NULL CHECK (authority_owner_count >= 0),
	manifest_key TEXT NOT NULL CHECK (
		manifest_key =
			'adhoc/mailbox-drop/d1/' || source_database_id || '/' ||
			replace(
				replace(replace(export_scheduled_at, '-', ''), ':', ''),
				'.',
				''
			) || '-' || nonce || '-' || request_id || '/manifest.json'
	),
	sql_object_key TEXT NOT NULL CHECK (
		sql_object_key =
			substr(manifest_key, 1, length(manifest_key) - length('manifest.json')) ||
			'backup-request.sql'
	),
	sql_sha256 TEXT NOT NULL CHECK (
		length(sql_sha256) = 64
		AND sql_sha256 = lower(sql_sha256)
		AND sql_sha256 NOT GLOB '*[^0-9a-f]*'
	),
	sql_bytes INTEGER NOT NULL CHECK (sql_bytes > 0),
	r2_etag TEXT NOT NULL CHECK (
		length(r2_etag) = 32
		AND r2_etag = lower(r2_etag)
		AND r2_etag NOT GLOB '*[^0-9a-f]*'
	),
	manifest_key_id TEXT NOT NULL CHECK (
		length(manifest_key_id) BETWEEN 1 AND 128
		AND manifest_key_id = lower(manifest_key_id)
		AND manifest_key_id NOT GLOB '*[^a-z0-9-]*'
		AND substr(manifest_key_id, 1, 1) != '-'
		AND substr(manifest_key_id, -1, 1) != '-'
	),
	manifest_signature_sha256 TEXT NOT NULL CHECK (
		length(manifest_signature_sha256) = 64
		AND manifest_signature_sha256 = lower(manifest_signature_sha256)
		AND manifest_signature_sha256 NOT GLOB '*[^0-9a-f]*'
	),
	verified_at TEXT NOT NULL CHECK (
		julianday(verified_at) IS NOT NULL
		AND verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', verified_at)
		AND julianday(verified_at) >= julianday(authority_frozen_at)
	),
	expires_at TEXT NOT NULL CHECK (
		julianday(expires_at) IS NOT NULL
		AND expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)
		AND julianday(expires_at) > julianday(verified_at)
		AND julianday(expires_at) <= julianday(verified_at, '+2 hours')
	),
	owner_count INTEGER NOT NULL CHECK (
		owner_count >= 0
		AND owner_count <= authority_owner_count
	),
	thread_count INTEGER NOT NULL CHECK (thread_count >= 0),
	message_count INTEGER NOT NULL CHECK (message_count >= 0),
	attachment_count INTEGER NOT NULL CHECK (attachment_count >= 0),
	event_count INTEGER NOT NULL CHECK (event_count >= 0),
	issued_by TEXT NOT NULL CHECK (issued_by = 'backup-control-plane'),
	source_account_id TEXT NOT NULL CHECK (
		source_account_id = lower(source_account_id)
		AND (
			(
				length(source_account_id) = 32
				AND source_account_id NOT GLOB '*[^0-9a-f]*'
			)
			OR (
				length(source_account_id) = 36
				AND substr(source_account_id, 9, 1) = '-'
				AND substr(source_account_id, 14, 1) = '-'
				AND substr(source_account_id, 19, 1) = '-'
				AND substr(source_account_id, 24, 1) = '-'
				AND replace(source_account_id, '-', '')
					NOT GLOB '*[^0-9a-f]*'
				AND substr(source_account_id, 15, 1) GLOB '[1-8]'
				AND substr(source_account_id, 20, 1) GLOB '[89ab]'
			)
		)
	),
	source_database_id TEXT NOT NULL CHECK (
		length(source_database_id) = 36
		AND source_database_id = lower(source_database_id)
		AND substr(source_database_id, 9, 1) = '-'
		AND substr(source_database_id, 14, 1) = '-'
		AND substr(source_database_id, 19, 1) = '-'
		AND substr(source_database_id, 24, 1) = '-'
		AND replace(source_database_id, '-', '') NOT GLOB '*[^0-9a-f]*'
		AND substr(source_database_id, 15, 1) GLOB '[1-8]'
		AND substr(source_database_id, 20, 1) GLOB '[89ab]'
	),
	source_database_name TEXT NOT NULL CHECK (
		length(source_database_name) BETWEEN 1 AND 128
	),
	export_bookmark TEXT NOT NULL CHECK (
		length(export_bookmark) BETWEEN 1 AND 256
	),
	export_scheduled_at TEXT NOT NULL CHECK (
		julianday(export_scheduled_at) IS NOT NULL
		AND export_scheduled_at =
			strftime('%Y-%m-%dT%H:%M:%fZ', export_scheduled_at)
	),
	export_started_at TEXT NOT NULL CHECK (
		julianday(export_started_at) IS NOT NULL
		AND export_started_at =
			strftime('%Y-%m-%dT%H:%M:%fZ', export_started_at)
		AND julianday(export_started_at) >= julianday(export_scheduled_at)
	),
	export_completed_at TEXT NOT NULL CHECK (
		julianday(export_completed_at) IS NOT NULL
		AND export_completed_at =
			strftime('%Y-%m-%dT%H:%M:%fZ', export_completed_at)
		AND julianday(export_completed_at) >= julianday(export_started_at)
		AND julianday(verified_at) >= julianday(export_completed_at)
	),
	build_commit TEXT NOT NULL CHECK (length(build_commit) BETWEEN 1 AND 128),
	retention_tier TEXT NOT NULL CHECK (retention_tier = 'daily'),
	restore_baseline_id TEXT NOT NULL CHECK (
		length(restore_baseline_id) BETWEEN 1 AND 128
	),
	restore_baseline_sha256 TEXT NOT NULL CHECK (
		length(restore_baseline_sha256) = 64
		AND restore_baseline_sha256 = lower(restore_baseline_sha256)
		AND restore_baseline_sha256 NOT GLOB '*[^0-9a-f]*'
	),
	signature_algorithm TEXT NOT NULL CHECK (signature_algorithm = 'Ed25519')
);
