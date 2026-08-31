import { DatabaseSync } from 'node:sqlite'
import {
	mailboxBlobRefAttachmentCursorPrefix,
	mailboxBlobRefRawMimeCursorPrefix,
	parseMailboxBlobRefCursor,
} from '#worker/email/mailbox-types.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'

export function applyMigrations(db: DatabaseSync) {
	const migrationsDir = new URL('../../migrations/', import.meta.url)
	applyAllMigrations(db, migrationsDir)
	// The APP_DB fallback jobs store serves the jobs-worker schema (ADR 0016)
	// from the same test database handle.
	applyAllMigrations(
		db,
		new URL('../../../jobs-worker/migrations/', import.meta.url),
	)
}

export function createD1FromSqlite(
	db: DatabaseSync,
	options?: {
		onQueryRows?: (rowCount: number) => void
		onQuery?: (query: string) => void
	},
) {
	return {
		prepare(query: string) {
			options?.onQuery?.(query.replace(/\s+/g, ' ').trim())
			return {
				bind(...params: Array<unknown>) {
					return {
						async all<T>() {
							const statement = db.prepare(query)
							const rows = statement.all(...params) as Array<T>
							options?.onQueryRows?.(rows.length)
							return { results: rows, meta: { changes: 0 } }
						},
						async first<T>() {
							const statement = db.prepare(query)
							return (statement.get(...params) ?? null) as T | null
						},
						async run() {
							const statement = db.prepare(query)
							const result = statement.run(...params)
							return { meta: { changes: result.changes } }
						},
					}
				},
				async all<T>() {
					const statement = db.prepare(query)
					const rows = statement.all() as Array<T>
					options?.onQueryRows?.(rows.length)
					return { results: rows, meta: { changes: 0 } }
				},
				async first<T>() {
					const statement = db.prepare(query)
					return (statement.get() ?? null) as T | null
				},
				async run() {
					const statement = db.prepare(query)
					const result = statement.run()
					return { meta: { changes: result.changes } }
				},
			}
		},
		async exec(query: string) {
			db.exec(query)
		},
	} as unknown as D1Database
}

export function createMigratedDb(options?: {
	onQueryRows?: (rowCount: number) => void
	onQuery?: (query: string) => void
}) {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrations(sqlite)
	return {
		sqlite,
		db: createD1FromSqlite(sqlite, options),
	}
}

export type TestMailboxBlobReference = {
	kind: 'raw_mime' | 'attachment'
	key: string
	messageId: string
	attachmentId: string | null
}

export function createMailboxBinding(input?: {
	blobReferences?: () => Array<TestMailboxBlobReference>
}) {
	const cursorAfter = (reference: TestMailboxBlobReference) =>
		reference.kind === 'raw_mime'
			? `${mailboxBlobRefRawMimeCursorPrefix}${reference.messageId}`
			: `${mailboxBlobRefAttachmentCursorPrefix}${reference.attachmentId}`
	const listBlobReferences = async ({
		pageSize = 100,
		startAfter,
	}: {
		pageSize?: number
		startAfter?: string | null
	}) => {
		const cursor = parseMailboxBlobRefCursor(startAfter ?? null)
		const references = (input?.blobReferences?.() ?? [])
			.filter((reference) => {
				if (cursor.phase === 'raw_mime') {
					return (
						reference.kind === 'attachment' ||
						reference.messageId > cursor.startAfterId
					)
				}
				return (
					reference.kind === 'attachment' &&
					(reference.attachmentId ?? '') > cursor.startAfterId
				)
			})
			.sort((left, right) => {
				if (left.kind !== right.kind) return left.kind === 'raw_mime' ? -1 : 1
				return cursorAfter(left).localeCompare(cursorAfter(right))
			})
		const page = references.slice(0, pageSize)
		const truncated = references.length > page.length
		return {
			references: page,
			nextStartAfter: truncated ? cursorAfter(page.at(-1)!) : null,
			truncated,
		}
	}
	return {
		idFromName: (name: string) => name as unknown as DurableObjectId,
		get: () => ({
			countMailbox: async () => ({
				threads: 0,
				messages: 0,
				attachments: 0,
				deliveryEvents: 0,
			}),
			exportMailbox: async () => ({
				rows: [],
				nextStartAfter: null,
				truncated: false,
			}),
			listBlobReferences,
		}),
	} as unknown as DurableObjectNamespace
}

export function encodeTestBase64Url(bytes: Uint8Array) {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/u, '')
}

export async function createSignedR2Cursor(input: {
	secret: string
	userId: string
	cursor: unknown
}) {
	const payload = encodeTestBase64Url(
		new TextEncoder().encode(
			JSON.stringify({ userId: input.userId, cursor: input.cursor }),
		),
	)
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(input.secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(payload),
	)
	return `${payload}.${encodeTestBase64Url(new Uint8Array(signature))}`
}
