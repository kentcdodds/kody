import { systemEmailOwnerId } from './email-owner.ts'
import { assertSystemEmailGraphAuthority } from './system-email-authority.ts'

export type SystemEmailHealth = {
	authority: {
		authority: 'dedicated'
		cutoverAt: string
	}
	counts: {
		threads: number
		messages: number
		attachments: number
		deliveryEvents: number
	}
	invalidReferenceCount: number
	providerLinkCount: number
	healthy: boolean
}

export async function loadSystemEmailHealth(input: {
	db: D1Database
}): Promise<SystemEmailHealth> {
	await assertSystemEmailGraphAuthority(input.db)
	const row = await input.db
		.prepare(
			`SELECT
				authority.authority,
				authority.cutover_at,
				(SELECT COUNT(*) FROM system_email_threads) AS threads,
				(SELECT COUNT(*) FROM system_email_messages) AS messages,
				(SELECT COUNT(*) FROM system_email_attachments) AS attachments,
				(SELECT COUNT(*) FROM system_email_delivery_events) AS delivery_events,
				(
					SELECT COUNT(*) FROM system_email_threads thread
					WHERE thread.inbox_id IS NOT NULL AND NOT EXISTS (
						SELECT 1 FROM email_inboxes inbox
						WHERE inbox.id = thread.inbox_id AND inbox.user_id = ?
					)
				) + (
					SELECT COUNT(*) FROM system_email_messages message
					WHERE
						(message.inbox_id IS NOT NULL AND NOT EXISTS (
							SELECT 1 FROM email_inboxes inbox
							WHERE inbox.id = message.inbox_id AND inbox.user_id = ?
						))
						OR (message.sender_identity_id IS NOT NULL AND NOT EXISTS (
							SELECT 1 FROM email_sender_identities sender
							WHERE sender.id = message.sender_identity_id
								AND sender.user_id = ?
						))
						OR (message.thread_id IS NOT NULL AND NOT EXISTS (
							SELECT 1 FROM system_email_threads thread
							WHERE thread.id = message.thread_id
						))
				) + (
					SELECT COUNT(*) FROM system_email_attachments attachment
					WHERE NOT EXISTS (
						SELECT 1 FROM system_email_messages message
						WHERE message.id = attachment.message_id
					)
				) + (
					SELECT COUNT(*) FROM system_email_delivery_events event
					WHERE
						(event.inbox_id IS NOT NULL AND NOT EXISTS (
							SELECT 1 FROM email_inboxes inbox
							WHERE inbox.id = event.inbox_id AND inbox.user_id = ?
						))
						OR (event.message_id IS NOT NULL AND NOT EXISTS (
							SELECT 1 FROM system_email_messages message
							WHERE message.id = event.message_id
						))
				) AS invalid_references,
				(
					SELECT COUNT(*) FROM email_outbound_provider_index
					WHERE user_id = ?
				) + (
					SELECT COUNT(*) FROM system_email_messages
					WHERE provider_message_id IS NOT NULL
				) AS provider_links
			FROM system_email_graph_authority authority
			WHERE authority.singleton = 1`,
		)
		.bind(
			systemEmailOwnerId,
			systemEmailOwnerId,
			systemEmailOwnerId,
			systemEmailOwnerId,
			systemEmailOwnerId,
		)
		.first<{
			authority: 'dedicated'
			cutover_at: string
			threads: number
			messages: number
			attachments: number
			delivery_events: number
			invalid_references: number
			provider_links: number
		}>()
	if (!row) {
		throw new Error('System email dedicated authority marker is missing.')
	}
	const invalidReferenceCount = Number(row.invalid_references)
	const providerLinkCount = Number(row.provider_links)
	return {
		authority: {
			authority: row.authority,
			cutoverAt: row.cutover_at,
		},
		counts: {
			threads: Number(row.threads),
			messages: Number(row.messages),
			attachments: Number(row.attachments),
			deliveryEvents: Number(row.delivery_events),
		},
		invalidReferenceCount,
		providerLinkCount,
		healthy: invalidReferenceCount === 0 && providerLinkCount === 0,
	}
}
