import { systemEmailOwnerId } from './email-owner.ts'

export type SystemEmailGraphTableParity = {
	legacyCount: number
	dedicatedCount: number
	missingFromDedicatedCount: number
	missingFromLegacyCount: number
	ownershipMismatchCount: number
	relationshipMismatchCount: number
	keyFieldMismatchCount: number
	parity: boolean
}

export type SystemEmailOutboundProviderParity = {
	legacyProviderLinkedMessageCount: number
	dedicatedProviderLinkedMessageCount: number
	legacyAuthorityIndexCount: number
	missingFromLegacyAuthorityIndexCount: number
	mismatchedLegacyAuthorityIndexCount: number
	classification:
		| 'no-system-provider-links'
		| 'legacy-authority-parity'
		| 'legacy-authority-mismatch'
	authorityDisposition: 'legacy-email-messages-until-4b-routing'
	parity: boolean
}

export type SystemEmailGraphParityReport = {
	threads: SystemEmailGraphTableParity
	messages: SystemEmailGraphTableParity
	attachments: SystemEmailGraphTableParity
	deliveryEvents: SystemEmailGraphTableParity
	outboundProviderIndex: SystemEmailOutboundProviderParity
	parity: boolean
}

type TablePrefix = 'thread' | 'message' | 'attachment' | 'event'

type ParityRow = Record<string, number | null>

const paritySql = `
WITH
legacy_threads AS (
	SELECT *
	FROM email_threads
	WHERE user_id = ?
),
thread_ids AS (
	SELECT id FROM legacy_threads
	UNION
	SELECT id FROM system_email_threads
),
thread_compare AS (
	SELECT
		ids.id,
		legacy.id IS NOT NULL AS has_legacy,
		dedicated.id IS NOT NULL AS has_dedicated,
		foreign_owner.id IS NOT NULL AS ownership_mismatch,
		legacy.id IS NOT NULL
			AND dedicated.id IS NOT NULL
			AND legacy.inbox_id IS NOT dedicated.inbox_id
			AS relationship_mismatch,
		legacy.id IS NOT NULL
			AND dedicated.id IS NOT NULL
			AND (
				legacy.subject_normalized IS NOT dedicated.subject_normalized
				OR legacy.root_message_id_header
					IS NOT dedicated.root_message_id_header
				OR legacy.last_message_at IS NOT dedicated.last_message_at
				OR legacy.created_at IS NOT dedicated.created_at
				OR legacy.updated_at IS NOT dedicated.updated_at
			) AS key_mismatch
	FROM thread_ids ids
	LEFT JOIN legacy_threads legacy ON legacy.id = ids.id
	LEFT JOIN system_email_threads dedicated ON dedicated.id = ids.id
	LEFT JOIN email_threads foreign_owner
		ON foreign_owner.id = dedicated.id
		AND foreign_owner.user_id != ?
),
thread_stats AS (
	SELECT
		(SELECT COUNT(*) FROM legacy_threads) AS legacy_count,
		(SELECT COUNT(*) FROM system_email_threads) AS dedicated_count,
		COALESCE(SUM(has_legacy AND NOT has_dedicated), 0) AS missing_dedicated,
		COALESCE(SUM(has_dedicated AND NOT has_legacy), 0) AS missing_legacy,
		COALESCE(SUM(ownership_mismatch), 0) AS ownership_mismatch,
		COALESCE(SUM(relationship_mismatch), 0) AS relationship_mismatch,
		COALESCE(SUM(key_mismatch), 0) AS key_mismatch
	FROM thread_compare
),
legacy_messages AS (
	SELECT *
	FROM email_messages
	WHERE user_id = ?
),
message_ids AS (
	SELECT id FROM legacy_messages
	UNION
	SELECT id FROM system_email_messages
),
message_compare AS (
	SELECT
		ids.id,
		legacy.id IS NOT NULL AS has_legacy,
		dedicated.id IS NOT NULL AS has_dedicated,
		foreign_owner.id IS NOT NULL AS ownership_mismatch,
		legacy.id IS NOT NULL
			AND dedicated.id IS NOT NULL
			AND (
				legacy.inbox_id IS NOT dedicated.inbox_id
				OR legacy.thread_id IS NOT dedicated.thread_id
				OR legacy.sender_identity_id IS NOT dedicated.sender_identity_id
			) AS relationship_mismatch,
		legacy.id IS NOT NULL
			AND dedicated.id IS NOT NULL
			AND (
				legacy.direction IS NOT dedicated.direction
				OR legacy.from_address IS NOT dedicated.from_address
				OR legacy.envelope_from IS NOT dedicated.envelope_from
				OR legacy.to_addresses_json IS NOT dedicated.to_addresses_json
				OR legacy.cc_addresses_json IS NOT dedicated.cc_addresses_json
				OR legacy.bcc_addresses_json IS NOT dedicated.bcc_addresses_json
				OR legacy.reply_to_addresses_json
					IS NOT dedicated.reply_to_addresses_json
				OR legacy.subject IS NOT dedicated.subject
				OR legacy.message_id_header IS NOT dedicated.message_id_header
				OR legacy.in_reply_to_header IS NOT dedicated.in_reply_to_header
				OR legacy.references_json IS NOT dedicated.references_json
				OR legacy.headers_json IS NOT dedicated.headers_json
				OR legacy.auth_results IS NOT dedicated.auth_results
				OR legacy.text_body IS NOT dedicated.text_body
				OR legacy.html_body IS NOT dedicated.html_body
				OR legacy.raw_size IS NOT dedicated.raw_size
				OR legacy.processing_status IS NOT dedicated.processing_status
				OR legacy.provider_message_id IS NOT dedicated.provider_message_id
				OR legacy.error IS NOT dedicated.error
				OR legacy.received_at IS NOT dedicated.received_at
				OR legacy.sent_at IS NOT dedicated.sent_at
				OR legacy.created_at IS NOT dedicated.created_at
				OR legacy.updated_at IS NOT dedicated.updated_at
				OR legacy.raw_mime_key IS NOT dedicated.raw_mime_key
				OR legacy.delivery_status IS NOT dedicated.delivery_status
				OR legacy.delivery_status_at IS NOT dedicated.delivery_status_at
				OR legacy.classification IS NOT dedicated.classification
				OR legacy.classification_reason
					IS NOT dedicated.classification_reason
			) AS key_mismatch
	FROM message_ids ids
	LEFT JOIN legacy_messages legacy ON legacy.id = ids.id
	LEFT JOIN system_email_messages dedicated ON dedicated.id = ids.id
	LEFT JOIN email_messages foreign_owner
		ON foreign_owner.id = dedicated.id
		AND foreign_owner.user_id != ?
),
message_stats AS (
	SELECT
		(SELECT COUNT(*) FROM legacy_messages) AS legacy_count,
		(SELECT COUNT(*) FROM system_email_messages) AS dedicated_count,
		COALESCE(SUM(has_legacy AND NOT has_dedicated), 0) AS missing_dedicated,
		COALESCE(SUM(has_dedicated AND NOT has_legacy), 0) AS missing_legacy,
		COALESCE(SUM(ownership_mismatch), 0) AS ownership_mismatch,
		COALESCE(SUM(relationship_mismatch), 0) AS relationship_mismatch,
		COALESCE(SUM(key_mismatch), 0) AS key_mismatch
	FROM message_compare
),
legacy_attachments AS (
	SELECT attachment.*
	FROM email_attachments attachment
	INNER JOIN email_messages message ON message.id = attachment.message_id
	WHERE message.user_id = ?
),
attachment_ids AS (
	SELECT id FROM legacy_attachments
	UNION
	SELECT id FROM system_email_attachments
),
attachment_compare AS (
	SELECT
		ids.id,
		legacy.id IS NOT NULL AS has_legacy,
		dedicated.id IS NOT NULL AS has_dedicated,
		foreign_owner_message.id IS NOT NULL AS ownership_mismatch,
		legacy.id IS NOT NULL
			AND dedicated.id IS NOT NULL
			AND legacy.message_id IS NOT dedicated.message_id
			AS relationship_mismatch,
		legacy.id IS NOT NULL
			AND dedicated.id IS NOT NULL
			AND (
				legacy.filename IS NOT dedicated.filename
				OR legacy.content_type IS NOT dedicated.content_type
				OR legacy.content_id IS NOT dedicated.content_id
				OR legacy.disposition IS NOT dedicated.disposition
				OR legacy.size IS NOT dedicated.size
				OR legacy.storage_kind IS NOT dedicated.storage_kind
				OR legacy.storage_key IS NOT dedicated.storage_key
				OR legacy.created_at IS NOT dedicated.created_at
			) AS key_mismatch
	FROM attachment_ids ids
	LEFT JOIN legacy_attachments legacy ON legacy.id = ids.id
	LEFT JOIN system_email_attachments dedicated ON dedicated.id = ids.id
	LEFT JOIN email_attachments foreign_attachment
		ON foreign_attachment.id = dedicated.id
	LEFT JOIN email_messages foreign_owner_message
		ON foreign_owner_message.id = foreign_attachment.message_id
		AND foreign_owner_message.user_id != ?
),
attachment_stats AS (
	SELECT
		(SELECT COUNT(*) FROM legacy_attachments) AS legacy_count,
		(SELECT COUNT(*) FROM system_email_attachments) AS dedicated_count,
		COALESCE(SUM(has_legacy AND NOT has_dedicated), 0) AS missing_dedicated,
		COALESCE(SUM(has_dedicated AND NOT has_legacy), 0) AS missing_legacy,
		COALESCE(SUM(ownership_mismatch), 0) AS ownership_mismatch,
		COALESCE(SUM(relationship_mismatch), 0) AS relationship_mismatch,
		COALESCE(SUM(key_mismatch), 0) AS key_mismatch
	FROM attachment_compare
),
legacy_events AS (
	SELECT *
	FROM email_delivery_events
	WHERE user_id = ?
),
event_ids AS (
	SELECT id FROM legacy_events
	UNION
	SELECT id FROM system_email_delivery_events
),
event_compare AS (
	SELECT
		ids.id,
		legacy.id IS NOT NULL AS has_legacy,
		dedicated.id IS NOT NULL AS has_dedicated,
		foreign_owner.id IS NOT NULL AS ownership_mismatch,
		legacy.id IS NOT NULL
			AND dedicated.id IS NOT NULL
			AND (
				legacy.message_id IS NOT dedicated.message_id
				OR legacy.inbox_id IS NOT dedicated.inbox_id
			) AS relationship_mismatch,
		legacy.id IS NOT NULL
			AND dedicated.id IS NOT NULL
			AND (
				legacy.event_type IS NOT dedicated.event_type
				OR legacy.provider IS NOT dedicated.provider
				OR legacy.provider_message_id IS NOT dedicated.provider_message_id
				OR legacy.provider_event_id IS NOT dedicated.provider_event_id
				OR legacy.detail_json IS NOT dedicated.detail_json
				OR legacy.created_at IS NOT dedicated.created_at
				OR legacy.needs_effect_reconcile
					IS NOT dedicated.needs_effect_reconcile
				OR legacy.usage_effect_recorded_at
					IS NOT dedicated.usage_effect_recorded_at
				OR legacy.usage_month IS NOT dedicated.usage_month
				OR legacy.usage_bytes IS NOT dedicated.usage_bytes
				OR legacy.usage_duration_ms IS NOT dedicated.usage_duration_ms
				OR legacy.state IS NOT dedicated.state
				OR legacy.fingerprint IS NOT dedicated.fingerprint
				OR legacy.storage_lease IS NOT dedicated.storage_lease
				OR legacy.storage_lease_at IS NOT dedicated.storage_lease_at
				OR legacy.cleanup_lease IS NOT dedicated.cleanup_lease
				OR legacy.cleanup_lease_at IS NOT dedicated.cleanup_lease_at
				OR legacy.cleanup_retry_at IS NOT dedicated.cleanup_retry_at
				OR legacy.expected_attachment_count
					IS NOT dedicated.expected_attachment_count
				OR legacy.finalization_token IS NOT dedicated.finalization_token
				OR legacy.reconcile_after IS NOT dedicated.reconcile_after
				OR legacy.dedupe_expires_at IS NOT dedicated.dedupe_expires_at
				OR legacy.usage_effect_suppressed_at
					IS NOT dedicated.usage_effect_suppressed_at
				OR legacy.usage_started_at IS NOT dedicated.usage_started_at
				OR legacy.usage_effect_retry_at
					IS NOT dedicated.usage_effect_retry_at
				OR legacy.usage_effect_lease IS NOT dedicated.usage_effect_lease
				OR legacy.usage_effect_lease_at
					IS NOT dedicated.usage_effect_lease_at
				OR legacy.subscription_effect_state
					IS NOT dedicated.subscription_effect_state
				OR legacy.subscription_effect_lease
					IS NOT dedicated.subscription_effect_lease
				OR legacy.subscription_effect_lease_at
					IS NOT dedicated.subscription_effect_lease_at
				OR legacy.subscription_effect_retry_at
					IS NOT dedicated.subscription_effect_retry_at
				OR legacy.subscription_effect_attempt_count
					IS NOT dedicated.subscription_effect_attempt_count
				OR legacy.subscription_effect_dead_letter_at
					IS NOT dedicated.subscription_effect_dead_letter_at
				OR legacy.subscription_effect_last_error
					IS NOT dedicated.subscription_effect_last_error
				OR legacy.updated_at IS NOT dedicated.updated_at
			) AS key_mismatch
	FROM event_ids ids
	LEFT JOIN legacy_events legacy ON legacy.id = ids.id
	LEFT JOIN system_email_delivery_events dedicated ON dedicated.id = ids.id
	LEFT JOIN email_delivery_events foreign_owner
		ON foreign_owner.id = dedicated.id
		AND foreign_owner.user_id != ?
),
event_stats AS (
	SELECT
		(SELECT COUNT(*) FROM legacy_events) AS legacy_count,
		(SELECT COUNT(*) FROM system_email_delivery_events) AS dedicated_count,
		COALESCE(SUM(has_legacy AND NOT has_dedicated), 0) AS missing_dedicated,
		COALESCE(SUM(has_dedicated AND NOT has_legacy), 0) AS missing_legacy,
		COALESCE(SUM(ownership_mismatch), 0) AS ownership_mismatch,
		COALESCE(SUM(relationship_mismatch), 0) AS relationship_mismatch,
		COALESCE(SUM(key_mismatch), 0) AS key_mismatch
	FROM event_compare
),
provider_stats AS (
	SELECT
		(
			SELECT COUNT(*)
			FROM email_messages
			WHERE user_id = ?
				AND direction = 'outbound'
				AND provider_message_id IS NOT NULL
		) AS legacy_linked,
		(
			SELECT COUNT(*)
			FROM system_email_messages
			WHERE direction = 'outbound' AND provider_message_id IS NOT NULL
		) AS dedicated_linked,
		(
			SELECT COUNT(*)
			FROM email_outbound_provider_index
			WHERE user_id = ?
		) AS legacy_index,
		(
			SELECT COUNT(*)
			FROM email_messages message
			WHERE message.user_id = ?
				AND message.direction = 'outbound'
				AND message.provider_message_id IS NOT NULL
				AND NOT EXISTS (
					SELECT 1
					FROM email_outbound_provider_index provider_index
					WHERE provider_index.provider = 'cloudflare-email'
						AND provider_index.provider_message_id
							= message.provider_message_id
						AND provider_index.user_id = message.user_id
						AND provider_index.message_id = message.id
						AND provider_index.inbox_id IS message.inbox_id
				)
		) AS missing_index,
		(
			SELECT COUNT(*)
			FROM email_outbound_provider_index provider_index
			LEFT JOIN email_messages message
				ON message.id = provider_index.message_id
			WHERE provider_index.user_id = ?
				AND (
					provider_index.provider != 'cloudflare-email'
					OR message.id IS NULL
					OR message.user_id != ?
					OR message.direction != 'outbound'
					OR message.provider_message_id
						IS NOT provider_index.provider_message_id
					OR message.inbox_id IS NOT provider_index.inbox_id
				)
		) AS mismatched_index
)
SELECT
	thread_stats.legacy_count AS threadLegacyCount,
	thread_stats.dedicated_count AS threadDedicatedCount,
	thread_stats.missing_dedicated AS threadMissingDedicated,
	thread_stats.missing_legacy AS threadMissingLegacy,
	thread_stats.ownership_mismatch AS threadOwnershipMismatch,
	thread_stats.relationship_mismatch AS threadRelationshipMismatch,
	thread_stats.key_mismatch AS threadKeyMismatch,
	message_stats.legacy_count AS messageLegacyCount,
	message_stats.dedicated_count AS messageDedicatedCount,
	message_stats.missing_dedicated AS messageMissingDedicated,
	message_stats.missing_legacy AS messageMissingLegacy,
	message_stats.ownership_mismatch AS messageOwnershipMismatch,
	message_stats.relationship_mismatch AS messageRelationshipMismatch,
	message_stats.key_mismatch AS messageKeyMismatch,
	attachment_stats.legacy_count AS attachmentLegacyCount,
	attachment_stats.dedicated_count AS attachmentDedicatedCount,
	attachment_stats.missing_dedicated AS attachmentMissingDedicated,
	attachment_stats.missing_legacy AS attachmentMissingLegacy,
	attachment_stats.ownership_mismatch AS attachmentOwnershipMismatch,
	attachment_stats.relationship_mismatch AS attachmentRelationshipMismatch,
	attachment_stats.key_mismatch AS attachmentKeyMismatch,
	event_stats.legacy_count AS eventLegacyCount,
	event_stats.dedicated_count AS eventDedicatedCount,
	event_stats.missing_dedicated AS eventMissingDedicated,
	event_stats.missing_legacy AS eventMissingLegacy,
	event_stats.ownership_mismatch AS eventOwnershipMismatch,
	event_stats.relationship_mismatch AS eventRelationshipMismatch,
	event_stats.key_mismatch AS eventKeyMismatch,
	provider_stats.legacy_linked AS providerLegacyLinked,
	provider_stats.dedicated_linked AS providerDedicatedLinked,
	provider_stats.legacy_index AS providerLegacyIndex,
	provider_stats.missing_index AS providerMissingIndex,
	provider_stats.mismatched_index AS providerMismatchedIndex
FROM thread_stats, message_stats, attachment_stats, event_stats, provider_stats
`

function count(row: ParityRow, name: string): number {
	return Number(row[name] ?? 0) || 0
}

function tableParity(
	row: ParityRow,
	prefix: TablePrefix,
): SystemEmailGraphTableParity {
	const result = {
		legacyCount: count(row, `${prefix}LegacyCount`),
		dedicatedCount: count(row, `${prefix}DedicatedCount`),
		missingFromDedicatedCount: count(row, `${prefix}MissingDedicated`),
		missingFromLegacyCount: count(row, `${prefix}MissingLegacy`),
		ownershipMismatchCount: count(row, `${prefix}OwnershipMismatch`),
		relationshipMismatchCount: count(row, `${prefix}RelationshipMismatch`),
		keyFieldMismatchCount: count(row, `${prefix}KeyMismatch`),
	}
	return {
		...result,
		parity:
			result.legacyCount === result.dedicatedCount &&
			result.missingFromDedicatedCount === 0 &&
			result.missingFromLegacyCount === 0 &&
			result.ownershipMismatchCount === 0 &&
			result.relationshipMismatchCount === 0 &&
			result.keyFieldMismatchCount === 0,
	}
}

/**
 * Aggregate-only 4a copy-parity report. The SQL compares full metadata rows,
 * including content-bearing fields, but returns counts only: no ids, addresses,
 * subjects, bodies, filenames, provider ids, or storage keys leave the query.
 */
export async function loadSystemEmailGraphParityReport(input: {
	db: D1Database
}): Promise<SystemEmailGraphParityReport> {
	const ownerBindings = Array.from({ length: 13 }, () => systemEmailOwnerId)
	const row =
		(await input.db
			.prepare(paritySql)
			.bind(...ownerBindings)
			.first<ParityRow>()) ?? {}
	const threads = tableParity(row, 'thread')
	const messages = tableParity(row, 'message')
	const attachments = tableParity(row, 'attachment')
	const deliveryEvents = tableParity(row, 'event')
	const providerCounts = {
		legacyProviderLinkedMessageCount: count(row, 'providerLegacyLinked'),
		dedicatedProviderLinkedMessageCount: count(row, 'providerDedicatedLinked'),
		legacyAuthorityIndexCount: count(row, 'providerLegacyIndex'),
		missingFromLegacyAuthorityIndexCount: count(row, 'providerMissingIndex'),
		mismatchedLegacyAuthorityIndexCount: count(row, 'providerMismatchedIndex'),
	}
	const providerParity =
		providerCounts.legacyProviderLinkedMessageCount ===
			providerCounts.dedicatedProviderLinkedMessageCount &&
		providerCounts.legacyProviderLinkedMessageCount ===
			providerCounts.legacyAuthorityIndexCount &&
		providerCounts.missingFromLegacyAuthorityIndexCount === 0 &&
		providerCounts.mismatchedLegacyAuthorityIndexCount === 0
	const classification =
		providerCounts.legacyProviderLinkedMessageCount === 0 &&
		providerCounts.dedicatedProviderLinkedMessageCount === 0 &&
		providerCounts.legacyAuthorityIndexCount === 0
			? ('no-system-provider-links' as const)
			: providerParity
				? ('legacy-authority-parity' as const)
				: ('legacy-authority-mismatch' as const)
	const outboundProviderIndex: SystemEmailOutboundProviderParity = {
		...providerCounts,
		classification,
		authorityDisposition: 'legacy-email-messages-until-4b-routing',
		parity: providerParity,
	}

	return {
		threads,
		messages,
		attachments,
		deliveryEvents,
		outboundProviderIndex,
		parity:
			threads.parity &&
			messages.parity &&
			attachments.parity &&
			deliveryEvents.parity &&
			outboundProviderIndex.parity,
	}
}
