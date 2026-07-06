import { maxInlineRawMimeBytes } from './parser.ts'
import {
	createEmailInbox,
	createEmailInboxAddress,
	deleteEmailInboxAddressById,
	deleteEmailMessageById,
	getEmailInboxAddressByAddress,
	getEmailInboxById,
	getEmailInboxByName,
} from './repo.ts'
import { buildPlatformEmailAddress } from './platform-address.ts'
import { type EmailInboxAddressRecord, type EmailInboxRecord } from './types.ts'

export const systemEmailOwnerId = 'system:email'

export const systemEmailLocals = [
	'kody',
	'support',
	'abuse',
	'postmaster',
	'security',
	'admin',
] as const

export type SystemEmailLocal = (typeof systemEmailLocals)[number]

export const systemEmailLimits = {
	maxMessageBytes: maxInlineRawMimeBytes,
	maxReceivesPerDay: 1000,
	maxStoredMessages: 5000,
	retentionDays: 90,
	pruneBatchSize: 500,
} as const

const systemEmailLocalSet = new Set<string>(systemEmailLocals)

export type ProvisionedSystemEmailInbox = {
	inbox: EmailInboxRecord
	address: EmailInboxAddressRecord
}

export function isSystemEmailLocal(
	localPart: string,
): localPart is SystemEmailLocal {
	return systemEmailLocalSet.has(localPart.trim().toLowerCase())
}

export async function ensureSystemEmailInbox(input: {
	db: D1Database
	localPart: SystemEmailLocal
	domain: string
}): Promise<ProvisionedSystemEmailInbox | null> {
	const localPart = input.localPart.trim().toLowerCase() as SystemEmailLocal
	const address = buildPlatformEmailAddress({
		username: localPart,
		domain: input.domain,
	})

	const readExisting = async () => {
		const existingAddress = await getEmailInboxAddressByAddress({
			db: input.db,
			address,
		})
		if (!existingAddress) return null
		if (existingAddress.userId !== systemEmailOwnerId) {
			await deleteEmailInboxAddressById({
				db: input.db,
				addressId: existingAddress.id,
			})
			return null
		}
		if (!existingAddress.enabled) {
			return { conflict: true as const }
		}
		const inbox = await getEmailInboxById({
			db: input.db,
			userId: systemEmailOwnerId,
			id: existingAddress.inboxId,
		})
		if (!inbox?.enabled) return { conflict: true as const }
		return { conflict: false as const, inbox, address: existingAddress }
	}

	const existing = await readExisting()
	if (existing) {
		return existing.conflict
			? null
			: { inbox: existing.inbox, address: existing.address }
	}

	let inbox = await getEmailInboxByName({
		db: input.db,
		userId: systemEmailOwnerId,
		name: localPart,
	})
	if (!inbox) {
		try {
			inbox = await createEmailInbox({
				db: input.db,
				userId: systemEmailOwnerId,
				name: localPart,
				description: `Operator-owned system inbox for ${address}`,
			})
		} catch (error) {
			inbox = await getEmailInboxByName({
				db: input.db,
				userId: systemEmailOwnerId,
				name: localPart,
			})
			if (!inbox) throw error
		}
	}

	try {
		const created = await createEmailInboxAddress({
			db: input.db,
			inboxId: inbox.id,
			userId: systemEmailOwnerId,
			address,
			localPart,
			domain: input.domain,
		})
		return { inbox, address: created }
	} catch (error) {
		const raced = await readExisting()
		if (raced) {
			return raced.conflict
				? null
				: { inbox: raced.inbox, address: raced.address }
		}
		throw error
	}
}

export function systemEmailDayKey(now = new Date()) {
	return now.toISOString().slice(0, 'YYYY-MM-DD'.length)
}

export async function consumeSystemEmailDailyReceive(input: {
	db: D1Database
	localPart: SystemEmailLocal
	now?: Date
	limit?: number
}) {
	const now = input.now ?? new Date()
	const limit = input.limit ?? systemEmailLimits.maxReceivesPerDay
	const row = await input.db
		.prepare(
			`INSERT INTO system_email_daily_counters (
				local_part, day, count, updated_at
			) VALUES (?, ?, 1, ?)
			ON CONFLICT(local_part, day) DO UPDATE SET
				count = count + 1,
				updated_at = excluded.updated_at
			WHERE count < ?
			RETURNING count`,
		)
		.bind(input.localPart, systemEmailDayKey(now), now.toISOString(), limit)
		.first<{ count: number }>()
	return row ? Number(row.count) : null
}

export async function countStoredSystemEmailMessages(input: {
	db: D1Database
}) {
	const row = await input.db
		.prepare(
			`SELECT COUNT(*) AS count
			FROM email_messages
			WHERE user_id = ?
				AND direction = 'inbound'`,
		)
		.bind(systemEmailOwnerId)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

async function listSystemEmailMessageIds(input: {
	db: D1Database
	before?: string
	offset?: number
	limit: number
}) {
	const where = [`user_id = ?`, `direction = 'inbound'`]
	const bindings: Array<string | number> = [systemEmailOwnerId]
	if (input.before) {
		where.push(`created_at < ?`)
		bindings.push(input.before)
	}
	const offset = input.offset ?? 0
	const result = await input.db
		.prepare(
			`SELECT id
			FROM email_messages
			WHERE ${where.join(' AND ')}
			ORDER BY created_at DESC, id DESC
			LIMIT ? OFFSET ?`,
		)
		.bind(...bindings, input.limit, offset)
		.all<{ id: string }>()
	return (result.results ?? []).map((row) => row.id)
}

async function deleteSystemEmailMessagesByIds(input: {
	db: D1Database
	messageIds: ReadonlyArray<string>
}) {
	if (input.messageIds.length === 0) return 0
	const placeholders = input.messageIds.map(() => '?').join(', ')
	await input.db
		.prepare(
			`DELETE FROM email_attachments
			WHERE message_id IN (${placeholders})`,
		)
		.bind(...input.messageIds)
		.run()
	await input.db
		.prepare(
			`DELETE FROM email_delivery_events
			WHERE message_id IN (${placeholders})`,
		)
		.bind(...input.messageIds)
		.run()
	for (const messageId of input.messageIds) {
		await deleteEmailMessageById({ db: input.db, messageId })
	}
	return input.messageIds.length
}

export type SystemEmailRetentionResult = {
	deletedMessages: number
	deletedDeliveryEvents: number
	deletedCounters: number
	deletedThreads: number
}

export async function pruneSystemEmailRetention(input: {
	db: D1Database
	now?: Date
}) {
	const now = input.now ?? new Date()
	const cutoff = new Date(
		now.getTime() - systemEmailLimits.retentionDays * 24 * 60 * 60 * 1000,
	)
	const cutoffIso = cutoff.toISOString()
	const cutoffDay = systemEmailDayKey(cutoff)
	const result: SystemEmailRetentionResult = {
		deletedMessages: 0,
		deletedDeliveryEvents: 0,
		deletedCounters: 0,
		deletedThreads: 0,
	}

	const oldMessageIds = await listSystemEmailMessageIds({
		db: input.db,
		before: cutoffIso,
		limit: systemEmailLimits.pruneBatchSize,
	})
	result.deletedMessages += await deleteSystemEmailMessagesByIds({
		db: input.db,
		messageIds: oldMessageIds,
	})

	const overCapMessageIds = await listSystemEmailMessageIds({
		db: input.db,
		offset: systemEmailLimits.maxStoredMessages,
		limit: systemEmailLimits.pruneBatchSize,
	})
	result.deletedMessages += await deleteSystemEmailMessagesByIds({
		db: input.db,
		messageIds: overCapMessageIds,
	})

	const eventDelete = await input.db
		.prepare(
			`DELETE FROM email_delivery_events
			WHERE user_id = ?
				AND created_at < ?`,
		)
		.bind(systemEmailOwnerId, cutoffIso)
		.run()
	result.deletedDeliveryEvents = eventDelete.meta.changes ?? 0

	const counterDelete = await input.db
		.prepare(`DELETE FROM system_email_daily_counters WHERE day < ?`)
		.bind(cutoffDay)
		.run()
	result.deletedCounters = counterDelete.meta.changes ?? 0

	const threadDelete = await input.db
		.prepare(
			`DELETE FROM email_threads
			WHERE user_id = ?
				AND NOT EXISTS (
					SELECT 1 FROM email_messages WHERE email_messages.thread_id = email_threads.id
				)`,
		)
		.bind(systemEmailOwnerId)
		.run()
	result.deletedThreads = threadDelete.meta.changes ?? 0

	return result
}
