-- Store the D1 portion of each user's storage-byte entitlement baseline on the
-- indexed users row. The one-time backfill deliberately pays the old full-scan
-- cost during migration so quota checks can switch immediately to point reads.
-- A bounded cron lane reconciles this estimate after deploy.

ALTER TABLE users ADD COLUMN d1_storage_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN d1_storage_bytes_updated_at TEXT;

UPDATE users
SET d1_storage_bytes =
	COALESCE((
		SELECT SUM(
			COALESCE(raw_size, 0)
			+ length(CAST(COALESCE(from_address, '') AS BLOB))
			+ length(CAST(COALESCE(envelope_from, '') AS BLOB))
			+ length(CAST(COALESCE(to_addresses_json, '') AS BLOB))
			+ length(CAST(COALESCE(cc_addresses_json, '') AS BLOB))
			+ length(CAST(COALESCE(bcc_addresses_json, '') AS BLOB))
			+ length(CAST(COALESCE(reply_to_addresses_json, '') AS BLOB))
			+ length(CAST(COALESCE(subject, '') AS BLOB))
			+ length(CAST(COALESCE(message_id_header, '') AS BLOB))
			+ length(CAST(COALESCE(in_reply_to_header, '') AS BLOB))
			+ length(CAST(COALESCE(references_json, '') AS BLOB))
			+ length(CAST(COALESCE(headers_json, '') AS BLOB))
			+ length(CAST(COALESCE(auth_results, '') AS BLOB))
			+ length(CAST(COALESCE(text_body, '') AS BLOB))
			+ length(CAST(COALESCE(html_body, '') AS BLOB))
			+ length(CAST(COALESCE(provider_message_id, '') AS BLOB))
			+ length(CAST(COALESCE(error, '') AS BLOB))
		)
		FROM email_messages
		WHERE user_id = users.stable_user_id
	), 0)
	+ COALESCE((
		SELECT SUM(ea.size)
		FROM email_attachments ea
		JOIN email_messages em ON em.id = ea.message_id
		WHERE em.user_id = users.stable_user_id
			AND ea.storage_kind = 'external'
	), 0)
	+ COALESCE((
		SELECT SUM(
			length(CAST(COALESCE(ve.name, '') AS BLOB))
			+ length(CAST(COALESCE(ve.description, '') AS BLOB))
			+ length(CAST(COALESCE(ve.value, '') AS BLOB))
		)
		FROM value_entries ve
		JOIN value_buckets vb ON vb.id = ve.bucket_id
		WHERE vb.user_id = users.stable_user_id
	), 0)
	+ COALESCE((
		SELECT SUM(
			length(CAST(COALESCE(se.name, '') AS BLOB))
			+ length(CAST(COALESCE(se.description, '') AS BLOB))
			+ length(CAST(COALESCE(se.encrypted_value, '') AS BLOB))
			+ length(CAST(COALESCE(se.allowed_hosts, '') AS BLOB))
			+ length(CAST(COALESCE(se.allowed_capabilities, '') AS BLOB))
			+ length(CAST(COALESCE(se.allowed_packages, '') AS BLOB))
		)
		FROM secret_entries se
		JOIN secret_buckets sb ON sb.id = se.bucket_id
		WHERE sb.user_id = users.stable_user_id
	), 0)
	+ COALESCE((
		SELECT SUM(
			length(CAST(COALESCE(category, '') AS BLOB))
			+ length(CAST(COALESCE(subject, '') AS BLOB))
			+ length(CAST(COALESCE(summary, '') AS BLOB))
			+ length(CAST(COALESCE(details, '') AS BLOB))
			+ length(CAST(COALESCE(tags_json, '') AS BLOB))
			+ length(CAST(COALESCE(source_uris_json, '') AS BLOB))
			+ length(CAST(COALESCE(dedupe_key, '') AS BLOB))
		)
		FROM mcp_memories
		WHERE user_id = users.stable_user_id
	), 0)
	+ COALESCE((
		SELECT SUM(
			length(CAST(COALESCE(name, '') AS BLOB))
			+ length(CAST(COALESCE(kody_id, '') AS BLOB))
			+ length(CAST(COALESCE(description, '') AS BLOB))
			+ length(CAST(COALESCE(tags_json, '') AS BLOB))
			+ length(CAST(COALESCE(search_text, '') AS BLOB))
			+ length(CAST(COALESCE(source_id, '') AS BLOB))
		)
		FROM saved_packages
		WHERE user_id = users.stable_user_id
	), 0)
	+ COALESCE((
		SELECT SUM(
			length(CAST(COALESCE(name, '') AS BLOB))
			+ length(CAST(COALESCE(params_json, '') AS BLOB))
			+ length(CAST(COALESCE(schedule_json, '') AS BLOB))
			+ length(CAST(COALESCE(timezone, '') AS BLOB))
			+ length(CAST(COALESCE(caller_context_json, '') AS BLOB))
			+ length(CAST(COALESCE(last_run_status, '') AS BLOB))
			+ length(CAST(COALESCE(last_run_error, '') AS BLOB))
			+ length(CAST(COALESCE(source_id, '') AS BLOB))
			+ length(CAST(COALESCE(published_commit, '') AS BLOB))
			+ length(CAST(COALESCE(storage_id, '') AS BLOB))
		)
		FROM jobs
		WHERE user_id = users.stable_user_id
	), 0)
	+ COALESCE((
		SELECT SUM(
			length(CAST(COALESCE(entity_kind, '') AS BLOB))
			+ length(CAST(COALESCE(entity_id, '') AS BLOB))
			+ length(CAST(COALESCE(repo_id, '') AS BLOB))
			+ length(CAST(COALESCE(published_commit, '') AS BLOB))
			+ length(CAST(COALESCE(indexed_commit, '') AS BLOB))
			+ length(CAST(COALESCE(manifest_path, '') AS BLOB))
			+ length(CAST(COALESCE(source_root, '') AS BLOB))
		)
		FROM entity_sources
		WHERE user_id = users.stable_user_id
	), 0)
	+ COALESCE((
		SELECT SUM(
			length(CAST(COALESCE(source_id, '') AS BLOB))
			+ length(CAST(COALESCE(source_repo_id, '') AS BLOB))
			+ length(CAST(COALESCE(session_branch, '') AS BLOB))
			+ length(CAST(COALESCE(source_branch, '') AS BLOB))
			+ length(CAST(COALESCE(base_commit, '') AS BLOB))
			+ length(CAST(COALESCE(source_root, '') AS BLOB))
			+ length(CAST(COALESCE(conversation_id, '') AS BLOB))
			+ length(CAST(COALESCE(last_checkpoint_commit, '') AS BLOB))
			+ length(CAST(COALESCE(last_check_run_id, '') AS BLOB))
			+ length(CAST(COALESCE(last_check_tree_hash, '') AS BLOB))
		)
		FROM repo_sessions
		WHERE user_id = users.stable_user_id
	), 0)
	+ COALESCE((
		SELECT SUM(
			length(CAST(COALESCE(source_id, '') AS BLOB))
			+ length(CAST(COALESCE(artifact_kind, '') AS BLOB))
			+ length(CAST(COALESCE(artifact_name, '') AS BLOB))
			+ length(CAST(COALESCE(entry_point, '') AS BLOB))
			+ length(CAST(COALESCE(published_commit, '') AS BLOB))
			+ length(CAST(COALESCE(kv_key, '') AS BLOB))
			+ length(CAST(COALESCE(dependencies_json, '') AS BLOB))
		)
		FROM published_bundle_artifacts
		WHERE user_id = users.stable_user_id
	), 0),
	d1_storage_bytes_updated_at = CURRENT_TIMESTAMP;

CREATE INDEX idx_users_d1_storage_bytes_reconciliation
	ON users(d1_storage_bytes_updated_at, stable_user_id);
