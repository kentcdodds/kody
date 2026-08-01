import {
	toMailboxDeliveryEventInput,
	type EmailDeliveryEventMirrorProjection,
} from './mailbox-snapshots.ts'
import { type EmailDeliveryEventType } from './types.ts'
import { type MailboxDeliveryEventInput } from './mailbox-types.ts'

/**
 * D1 loaders for complete Mailbox mirror projections.
 *
 * Delivery-event dual-write callers load one cohesive projection here instead
 * of stitching promoted columns into the converter by hand. Detail JSON
 * decoding stays centralized in `mailbox-snapshots.ts`.
 *
 * Phase-2 high-risk lifecycle mutations must pass the same canonical
 * `sourceMutationAt` used for the D1 mutation as the Mailbox `updatedAt`.
 * Inserts use `created_at`.
 */

type DeliveryEventMirrorRow = {
	id: string
	message_id: string | null
	user_id: string | null
	inbox_id: string | null
	event_type: string
	provider: string | null
	provider_message_id: string | null
	provider_event_id: string | null
	detail_json: string
	needs_effect_reconcile: number
	usage_effect_recorded_at: string | null
	usage_month: string | null
	usage_bytes: number | null
	usage_duration_ms: number | null
	created_at: string
}

const deliveryEventMirrorSelect = `SELECT
				id,
				message_id,
				user_id,
				inbox_id,
				event_type,
				provider,
				provider_message_id,
				provider_event_id,
				detail_json,
				needs_effect_reconcile,
				usage_effect_recorded_at,
				usage_month,
				usage_bytes,
				usage_duration_ms,
				created_at
			FROM email_delivery_events`

function mapDeliveryEventMirrorRow(
	row: DeliveryEventMirrorRow,
): EmailDeliveryEventMirrorProjection {
	return {
		id: String(row.id),
		messageId: row.message_id == null ? null : String(row.message_id),
		userId: row.user_id == null ? null : String(row.user_id),
		inboxId: row.inbox_id == null ? null : String(row.inbox_id),
		eventType: String(row.event_type) as EmailDeliveryEventType,
		provider: row.provider == null ? null : String(row.provider),
		providerMessageId:
			row.provider_message_id == null ? null : String(row.provider_message_id),
		providerEventId:
			row.provider_event_id == null ? null : String(row.provider_event_id),
		detailJson: String(row.detail_json ?? '{}'),
		createdAt: String(row.created_at),
		needsEffectReconcile: Number(row.needs_effect_reconcile ?? 0) === 1,
		usageEffectRecordedAt:
			row.usage_effect_recorded_at == null
				? null
				: String(row.usage_effect_recorded_at),
		usageMonth: row.usage_month == null ? null : String(row.usage_month),
		usageBytes: row.usage_bytes == null ? null : Number(row.usage_bytes),
		usageDurationMs:
			row.usage_duration_ms == null ? null : Number(row.usage_duration_ms),
	}
}

/**
 * Load one complete delivery-event mirror projection scoped by owner + id.
 * Returns null when the row is absent or owned by a different user.
 */
export async function getEmailDeliveryEventMirrorProjection(input: {
	db: D1Database
	ownerId: string
	eventId: string
}): Promise<EmailDeliveryEventMirrorProjection | null> {
	const row = await input.db
		.prepare(
			`${deliveryEventMirrorSelect}
			WHERE id = ?
				AND user_id = ?
			LIMIT 1`,
		)
		.bind(input.eventId, input.ownerId)
		.first<DeliveryEventMirrorRow>()
	return row ? mapDeliveryEventMirrorRow(row) : null
}

/**
 * Load and convert one ready Mailbox delivery-event snapshot for dual-write.
 *
 * @param sourceMutationAt - Canonical mirror `updatedAt`. D1 delivery events
 *   lack `updated_at`. Phase-2 high-risk lifecycle mutations must pass the
 *   same timestamp used for the D1 mutation; inserts use `created_at`.
 */
export async function getMailboxDeliveryEventMirrorInput(input: {
	db: D1Database
	ownerId: string
	eventId: string
	sourceMutationAt: string
}): Promise<MailboxDeliveryEventInput | null> {
	const projection = await getEmailDeliveryEventMirrorProjection({
		db: input.db,
		ownerId: input.ownerId,
		eventId: input.eventId,
	})
	if (!projection) return null
	return toMailboxDeliveryEventInput({
		projection,
		sourceMutationAt: input.sourceMutationAt,
	})
}

/**
 * Load complete delivery-event mirror projections for one message.
 *
 * Selects the newest `limit` rows (`ORDER BY created_at DESC, id DESC`) so
 * truncation keeps recent events, then restores chronological order for
 * insertion. Scoped by owner.
 */
export async function listEmailDeliveryEventMirrorProjectionsForMessage(input: {
	db: D1Database
	ownerId: string
	messageId: string
	limit: number
}): Promise<Array<EmailDeliveryEventMirrorProjection>> {
	const result = await input.db
		.prepare(
			`${deliveryEventMirrorSelect}
			WHERE message_id = ?
				AND user_id = ?
			ORDER BY created_at DESC, id DESC
			LIMIT ?`,
		)
		.bind(input.messageId, input.ownerId, input.limit)
		.all<DeliveryEventMirrorRow>()
	const newestFirst = (result.results ?? []).map(mapDeliveryEventMirrorRow)
	return newestFirst.reverse()
}

/**
 * Load ready Mailbox delivery-event snapshots for one message.
 * Uses each event's `created_at` as `sourceMutationAt` (immutable inserts).
 */
export async function listMailboxDeliveryEventMirrorInputsForMessage(input: {
	db: D1Database
	ownerId: string
	messageId: string
	limit: number
}): Promise<Array<MailboxDeliveryEventInput>> {
	const projections =
		await listEmailDeliveryEventMirrorProjectionsForMessage(input)
	return projections.map((projection) =>
		toMailboxDeliveryEventInput({
			projection,
			sourceMutationAt: projection.createdAt,
		}),
	)
}

/**
 * Owner-scoped delivery-event creation keyset of ready Mailbox snapshots.
 *
 * Orders by `(created_at ASC, id ASC)` so equal timestamps progress by id.
 * Uses each event's `created_at` as `sourceMutationAt` (immutable inserts).
 * Rows deleted before this query simply do not appear — callers advance only
 * over returned snapshots (or reload the same cursor after uniform failure).
 */
export async function listMailboxDeliveryEventMirrorInputsForOwnerKeyset(input: {
	db: D1Database
	ownerId: string
	cursor: { createdAt: string; id: string } | null
	limit: number
}): Promise<Array<MailboxDeliveryEventInput>> {
	const result =
		input.cursor == null
			? await input.db
					.prepare(
						`${deliveryEventMirrorSelect}
						WHERE user_id = ?
						ORDER BY created_at ASC, id ASC
						LIMIT ?`,
					)
					.bind(input.ownerId, input.limit)
					.all<DeliveryEventMirrorRow>()
			: await input.db
					.prepare(
						`${deliveryEventMirrorSelect}
						WHERE user_id = ?
							AND (
								created_at > ?
								OR (created_at = ? AND id > ?)
							)
						ORDER BY created_at ASC, id ASC
						LIMIT ?`,
					)
					.bind(
						input.ownerId,
						input.cursor.createdAt,
						input.cursor.createdAt,
						input.cursor.id,
						input.limit,
					)
					.all<DeliveryEventMirrorRow>()
	return (result.results ?? []).map((row) => {
		const projection = mapDeliveryEventMirrorRow(row)
		return toMailboxDeliveryEventInput({
			projection,
			sourceMutationAt: projection.createdAt,
		})
	})
}
