import {
	mailboxBlobRefAttachmentCursorPrefix,
	mailboxBlobRefRawMimeCursorPrefix,
	mailboxExportCursorPrefixForPhase,
	normalizeMailboxPageSize,
	parseMailboxBlobRefCursor,
	parseMailboxExportCursor,
	type MailboxBlobReference,
	type MailboxBlobReferencePage,
	type MailboxExportPhase,
	type MailboxExportResult,
	type MailboxExportRow,
} from './mailbox-types.ts'
import {
	mapMailboxAttachmentRow,
	mapMailboxDeliveryEventRow,
	mapMailboxMessageRow,
	mapMailboxThreadRow,
} from './mailbox-mappers.ts'

export function exportMailboxFromStore(
	sql: SqlStorage,
	input: {
		pageSize?: number
		startAfter?: string | null
	},
): MailboxExportResult {
	const pageSize = normalizeMailboxPageSize(input.pageSize)
	const startAfterRaw =
		typeof input.startAfter === 'string' && input.startAfter.length > 0
			? input.startAfter
			: null
	const phaseOrder: Array<MailboxExportPhase> = [
		'thread',
		'message',
		'attachment',
		'delivery_event',
	]
	const result: MailboxExportResult = {
		rows: [],
		nextStartAfter: null,
		truncated: false,
	}
	let { phase, startAfterId } = parseMailboxExportCursor(startAfterRaw)
	let remaining = pageSize
	let phaseIndex = phaseOrder.indexOf(phase)
	const maxIterations = phaseOrder.length + 1
	let iterations = 0

	while (phaseIndex < phaseOrder.length) {
		iterations += 1
		if (iterations > maxIterations) {
			throw new Error('exportMailbox exceeded phase iteration budget')
		}
		if (remaining <= 0) {
			const nextPhase = phaseOrder[phaseIndex]!
			const handoff = mailboxExportCursorPrefixForPhase(nextPhase)
			if (handoff === startAfterRaw) {
				phaseIndex += 1
				startAfterId = ''
				continue
			}
			result.nextStartAfter = handoff
			result.truncated = true
			return result
		}

		const currentPhase = phaseOrder[phaseIndex]!
		const page = exportPhasePage(sql, {
			phase: currentPhase,
			startAfterId,
			limit: remaining,
		})
		result.rows.push(...page.rows)
		remaining -= page.taken

		if (page.truncated) {
			if (page.taken <= 0) {
				phaseIndex += 1
				startAfterId = ''
				continue
			}
			const nextStartAfter = `${mailboxExportCursorPrefixForPhase(currentPhase)}${page.nextId}`
			if (nextStartAfter === startAfterRaw) {
				phaseIndex += 1
				startAfterId = ''
				continue
			}
			result.nextStartAfter = nextStartAfter
			result.truncated = true
			return result
		}

		phaseIndex += 1
		startAfterId = ''
		if (remaining <= 0 && phaseIndex < phaseOrder.length) {
			const nextPhase = phaseOrder[phaseIndex]!
			const handoff = mailboxExportCursorPrefixForPhase(nextPhase)
			if (handoff === startAfterRaw) continue
			result.nextStartAfter = handoff
			result.truncated = true
			return result
		}
	}
	return result
}

function exportPhasePage(
	sql: SqlStorage,
	input: {
		phase: MailboxExportPhase
		startAfterId: string
		limit: number
	},
): {
	rows: Array<MailboxExportRow>
	taken: number
	truncated: boolean
	nextId: string
} {
	if (input.limit <= 0) {
		return {
			rows: [],
			taken: 0,
			truncated: false,
			nextId: input.startAfterId,
		}
	}
	const limit = Math.trunc(input.limit)
	const tableForPhase = (phase: MailboxExportPhase) => {
		switch (phase) {
			case 'thread':
				return 'email_threads'
			case 'message':
				return 'email_messages'
			case 'attachment':
				return 'email_attachments'
			case 'delivery_event':
				return 'email_delivery_events'
			default: {
				const exhaustive: never = phase
				throw new Error(`Unhandled export phase: ${String(exhaustive)}`)
			}
		}
	}
	const rows = sql
		.exec<Record<string, SqlStorageValue>>(
			`SELECT * FROM ${tableForPhase(input.phase)}
			WHERE id > ?
			ORDER BY id ASC
			LIMIT ?`,
			input.startAfterId,
			limit + 1,
		)
		.toArray()
	const truncated = rows.length > limit
	const pageRows = truncated ? rows.slice(0, limit) : rows
	const last = pageRows[pageRows.length - 1]
	const mapped: Array<MailboxExportRow> = pageRows.map((row) => {
		switch (input.phase) {
			case 'thread':
				return { kind: 'thread', row: mapMailboxThreadRow(row) }
			case 'message':
				return { kind: 'message', row: mapMailboxMessageRow(row) }
			case 'attachment':
				return { kind: 'attachment', row: mapMailboxAttachmentRow(row) }
			case 'delivery_event':
				return {
					kind: 'delivery_event',
					row: mapMailboxDeliveryEventRow(row),
				}
			default: {
				const exhaustive: never = input.phase
				throw new Error(`Unhandled export phase: ${String(exhaustive)}`)
			}
		}
	})
	return {
		rows: mapped,
		taken: pageRows.length,
		truncated,
		nextId: last ? String(last['id']) : input.startAfterId,
	}
}

export function listMailboxBlobReferences(
	sql: SqlStorage,
	input: {
		pageSize?: number
		startAfter?: string | null
	},
): MailboxBlobReferencePage {
	const pageSize = normalizeMailboxPageSize(input.pageSize)
	const startAfterRaw =
		typeof input.startAfter === 'string' && input.startAfter.length > 0
			? input.startAfter
			: null
	const { phase, startAfterId } = parseMailboxBlobRefCursor(startAfterRaw)
	const references: Array<MailboxBlobReference> = []
	let remaining = pageSize

	if (phase === 'raw_mime') {
		const rows = sql
			.exec<{ id: string; raw_mime_key: string }>(
				`SELECT id, raw_mime_key FROM email_messages
				WHERE raw_mime_key IS NOT NULL AND id > ?
				ORDER BY id ASC
				LIMIT ?`,
				startAfterId,
				remaining + 1,
			)
			.toArray()
		const truncated = rows.length > remaining
		const pageRows = truncated ? rows.slice(0, remaining) : rows
		for (const row of pageRows) {
			references.push({
				kind: 'raw_mime',
				key: row.raw_mime_key,
				messageId: row.id,
				attachmentId: null,
			})
		}
		if (truncated) {
			const last = pageRows[pageRows.length - 1]!
			return {
				references,
				nextStartAfter: `${mailboxBlobRefRawMimeCursorPrefix}${last.id}`,
				truncated: true,
			}
		}
		remaining -= pageRows.length
		if (remaining <= 0) {
			return {
				references,
				nextStartAfter: mailboxBlobRefAttachmentCursorPrefix,
				truncated: true,
			}
		}
		const attachmentPage = listAttachmentBlobReferences(sql, {
			startAfterId: '',
			limit: remaining,
		})
		references.push(...attachmentPage.references)
		return {
			references,
			nextStartAfter: attachmentPage.nextStartAfter,
			truncated: attachmentPage.truncated,
		}
	}

	return listAttachmentBlobReferences(sql, {
		startAfterId,
		limit: remaining,
	})
}

function listAttachmentBlobReferences(
	sql: SqlStorage,
	input: {
		startAfterId: string
		limit: number
	},
): MailboxBlobReferencePage {
	if (input.limit <= 0) {
		return { references: [], nextStartAfter: null, truncated: false }
	}
	const rows = sql
		.exec<{ id: string; message_id: string; storage_key: string }>(
			`SELECT id, message_id, storage_key FROM email_attachments
			WHERE storage_key IS NOT NULL AND id > ?
			ORDER BY id ASC
			LIMIT ?`,
			input.startAfterId,
			input.limit + 1,
		)
		.toArray()
	const truncated = rows.length > input.limit
	const pageRows = truncated ? rows.slice(0, input.limit) : rows
	const last = pageRows[pageRows.length - 1]
	return {
		references: pageRows.map((row) => ({
			kind: 'attachment' as const,
			key: row.storage_key,
			messageId: row.message_id,
			attachmentId: row.id,
		})),
		nextStartAfter:
			truncated && last
				? `${mailboxBlobRefAttachmentCursorPrefix}${last.id}`
				: null,
		truncated,
	}
}
