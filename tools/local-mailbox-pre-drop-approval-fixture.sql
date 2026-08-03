-- Local development bootstrap only. Production approval is issued exclusively
-- by the backup-control-plane Workflow.
-- Replace the singleton so rerunning the local helper after a failed 0135
-- attempt refreshes counts and expiry instead of colliding on its primary key.
DELETE FROM email_user_graph_drop_approval;

WITH fixture AS (
	SELECT
		'11111111-1111-4111-8111-111111111111' AS request_id,
		'0123456789abcdef0123456789abcdef' AS nonce,
		'8c1014d1-6b41-4695-a0a2-159071f0f919' AS source_database_id,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS timestamp
),
snapshot AS (
	SELECT
		authority.frozen_at AS authority_frozen_at,
		authority.owner_count AS authority_owner_count,
		(
			SELECT COUNT(*) FROM email_threads WHERE user_id != 'system:email'
		) AS thread_count,
		(
			SELECT COUNT(*) FROM email_messages WHERE user_id != 'system:email'
		) AS message_count,
		(
			SELECT COUNT(*)
			FROM email_attachments attachment
			INNER JOIN email_messages message ON message.id = attachment.message_id
			WHERE message.user_id != 'system:email'
		) AS attachment_count,
		(
			SELECT COUNT(*) FROM email_delivery_events
			WHERE user_id != 'system:email'
		) AS event_count
	FROM email_user_graph_authority authority
	WHERE authority.singleton = 1
),
object_prefix AS (
	SELECT
		'adhoc/mailbox-drop/d1/' || fixture.source_database_id || '/' ||
		replace(
			replace(replace(snapshot.authority_frozen_at, '-', ''), ':', ''),
			'.',
			''
		) || '-' || fixture.nonce || '-' || fixture.request_id AS value
	FROM fixture
	CROSS JOIN snapshot
)
INSERT INTO email_user_graph_drop_approval (
	singleton,
	request_id,
	nonce,
	authority_frozen_at,
	authority_owner_count,
	manifest_key,
	sql_object_key,
	sql_sha256,
	sql_bytes,
	r2_etag,
	manifest_key_id,
	manifest_signature_sha256,
	verified_at,
	expires_at,
	owner_count,
	thread_count,
	message_count,
	attachment_count,
	event_count,
	issued_by,
	source_account_id,
	source_database_id,
	source_database_name,
	export_bookmark,
	export_scheduled_at,
	export_started_at,
	export_completed_at,
	build_commit,
	retention_tier,
	restore_baseline_id,
	restore_baseline_sha256,
	signature_algorithm
)
SELECT
	1,
	fixture.request_id,
	fixture.nonce,
	snapshot.authority_frozen_at,
	snapshot.authority_owner_count,
	object_prefix.value || '/manifest.json',
	object_prefix.value || '/backup-request.sql',
	'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	1,
	'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
	'kody-dr-2026-07',
	'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
	fixture.timestamp,
	strftime('%Y-%m-%dT%H:%M:%fZ', fixture.timestamp, '+2 hours'),
	snapshot.authority_owner_count,
	snapshot.thread_count,
	snapshot.message_count,
	snapshot.attachment_count,
	snapshot.event_count,
	'backup-control-plane',
	'a99ee2e72728dd52902ef288b7b1447d',
	fixture.source_database_id,
	'kody',
	'local-fixture',
	snapshot.authority_frozen_at,
	snapshot.authority_frozen_at,
	snapshot.authority_frozen_at,
	'fe1ca2772de7f369fc06a7d1bd9aeadc3347b2a7',
	'daily',
	'kody-migration-set-2026-07',
	'feb76eb26ed72a55d5fa25d14ef9ee904d0758fc29842c898b584a921ccfd995',
	'Ed25519'
FROM fixture
CROSS JOIN snapshot
CROSS JOIN object_prefix;
