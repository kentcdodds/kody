import { DatabaseSync } from 'node:sqlite'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { isMcpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import type * as AuditLog from '#worker/audit-log.ts'
import { type PackageCodemodRunItemRecord } from './ledger.ts'

const mocks = vi.hoisted(() => ({
	items: [] as Array<PackageCodemodRunItemRecord>,
	sendCloudflareEmail: vi.fn(),
}))

vi.mock('./ledger.ts', () => ({
	getPackageCodemodRunById: async (_db: D1Database, runId: string) =>
		runId === 'run-1'
			? { id: 'run-1', codemodId: '0010-detect-legacy-credential-patterns' }
			: null,
	listPackageCodemodRunItems: async (
		_db: D1Database,
		input: { runId: string; afterId?: string | null; limit?: number },
	) =>
		mocks.items
			.filter((item) => item.runId === input.runId)
			.filter((item) => item.id > (input.afterId ?? ''))
			.slice(0, input.limit ?? 50),
}))

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (...args: Array<unknown>) =>
		mocks.sendCloudflareEmail(...args),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return { ...actual, logAuditEvent: vi.fn() }
})

const {
	buildPackageOwnerNoticeEmail,
	packageOwnerNoticeKvKey,
	runPackageOwnerNotice,
} = await import('./owner-notice.ts')
const { adminPackageCodemodOwnerNoticeCapability } =
	await import('#mcp/capabilities/admin/admin-package-codemod-owner-notice.ts')

const bodyFinding =
	'literal secret: {{secret:API_KEY}} is outside a request header.'
const otherFinding = 'computed integration: createAuthenticatedFetch(name).'

const content = {
	subject: 'Your package sends a secret placeholder in a request body',
	whatBreaks:
		'Kody now refuses requests that carry a secret placeholder outside a declared header.',
	howToFix: 'Move the value into a header, or pass non-secret ids as values.',
	effectiveAt: 'November 1, 2026',
}

function item(
	id: string,
	userId: string,
	kodyId: string,
	messages: Array<string>,
): PackageCodemodRunItemRecord {
	return {
		id,
		runId: 'run-1',
		userId,
		packageId: `pkg-${kodyId}`,
		kodyId,
		status: 'detected',
		beforeCommit: null,
		afterCommit: null,
		changedPaths: [],
		findings: messages.map((message) => ({ message })),
		checkSummaryJson: null,
		error: null,
		revertSnapshotKey: null,
		createdAt: '2026-10-01T00:00:00.000Z',
	} as unknown as PackageCodemodRunItemRecord
}

async function createEnv() {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	await ensureOrgsTestSchema(db)
	await db
		.prepare(
			`CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				stable_user_id TEXT NOT NULL UNIQUE,
				email TEXT,
				email_verified_at TEXT,
				deleting_at TEXT,
				deleted_at TEXT
			)`,
		)
		.run()
	const users: Array<[string, string, string | null]> = [
		['alice', 'alice@example.com', '2026-01-01'],
		['bob', 'bob@example.com', '2026-01-01'],
		['carol', 'carol@example.com', '2026-01-01'],
		['dave', 'dave@example.com', null],
	]
	for (const [id, email, verifiedAt] of users) {
		await db
			.prepare(
				'INSERT INTO users (stable_user_id, email, email_verified_at) VALUES (?, ?, ?)',
			)
			.bind(id, email, verifiedAt)
			.run()
	}
	for (const userId of ['bob', 'carol']) {
		await db
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES ('org-acme', ?, 'owner', '2026-01-01')`,
			)
			.bind(userId)
			.run()
	}
	const { kv } = createMemoryKvNamespace()
	const env = {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: kv,
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.com/client/v4',
		CLOUDFLARE_API_TOKEN: 'token',
		APP_BASE_URL: 'https://kody.test',
		SYSTEM_EMAIL_DOMAIN: 'kody.codes',
	} as unknown as Env
	return { env, kv }
}

beforeEach(() => {
	mocks.sendCloudflareEmail.mockReset()
	mocks.sendCloudflareEmail.mockResolvedValue({ ok: true })
	mocks.items = [
		item('01', 'alice', '@alice/tuckabox', [bodyFinding]),
		item('02', 'org-acme', '@acme/billing', [bodyFinding, bodyFinding]),
		item('03', 'org-acme', '@acme/reports', [otherFinding]),
		item('04', 'dave', '@dave/notes', [bodyFinding]),
		item('05', 'erin', '@erin/clean', [otherFinding]),
	]
})

test('dry run lists flagged owners and previews the email without sending or claiming', async () => {
	const { env, kv } = await createEnv()

	const result = await runPackageOwnerNotice({
		env,
		runId: 'run-1',
		noticeId: '2026-10-body-placeholders',
		content,
		findingMessages: [bodyFinding],
		dryRun: true,
	})

	expect(result.owners).toEqual([
		{
			ownerId: 'alice',
			status: 'would_send',
			recipientCount: 1,
			packages: [
				{
					packageId: 'pkg-@alice/tuckabox',
					kodyId: '@alice/tuckabox',
					findings: [bodyFinding],
				},
			],
		},
		{
			ownerId: 'dave',
			status: 'no_recipients',
			recipientCount: 0,
			packages: [expect.objectContaining({ kodyId: '@dave/notes' })],
		},
		{
			ownerId: 'org-acme',
			status: 'would_send',
			recipientCount: 2,
			packages: [
				{
					packageId: 'pkg-@acme/billing',
					kodyId: '@acme/billing',
					findings: [bodyFinding],
				},
			],
		},
	])
	expect(result.summary).toEqual({ would_send: 2, no_recipients: 1 })
	expect(result.nextCursor).toBeNull()
	expect(result.preview?.subject).toBe(content.subject)
	expect(result.preview?.text).toContain(content.whatBreaks)
	expect(result.preview?.text).toContain('This takes effect November 1, 2026.')
	expect(result.preview?.text).toContain(
		'@alice/tuckabox (https://kody.codes/account/packages/pkg-%40alice%2Ftuckabox)',
	)
	expect(result.preview?.text).toContain(`How to fix it: ${content.howToFix}`)
	expect(mocks.sendCloudflareEmail).not.toHaveBeenCalled()
	expect(
		await kv.get(
			packageOwnerNoticeKvKey({
				noticeId: '2026-10-body-placeholders',
				ownerId: 'alice',
			}),
		),
	).toBeNull()
})

test('send emails every verified org owner once per notice and claims the owner', async () => {
	const { env, kv } = await createEnv()
	const input = {
		env,
		runId: 'run-1',
		noticeId: '2026-10-body-placeholders',
		content,
		findingMessages: [bodyFinding],
		dryRun: false,
	}

	const first = await runPackageOwnerNotice(input)

	expect(first.summary).toEqual({ sent: 2, no_recipients: 1 })
	expect(first.preview).toBeNull()
	const recipients = mocks.sendCloudflareEmail.mock.calls.map(
		([, message]) => (message as { to: string }).to,
	)
	expect(recipients.sort()).toEqual([
		'alice@example.com',
		'bob@example.com',
		'carol@example.com',
	])
	const acmeEmail = mocks.sendCloudflareEmail.mock.calls.find(
		([, message]) => (message as { to: string }).to === 'bob@example.com',
	)?.[1] as { text: string }
	expect(acmeEmail.text).toContain('@acme/billing')
	expect(acmeEmail.text).not.toContain('@acme/reports')
	expect(
		await kv.get(
			packageOwnerNoticeKvKey({
				noticeId: '2026-10-body-placeholders',
				ownerId: 'org-acme',
			}),
		),
	).not.toBeNull()

	mocks.sendCloudflareEmail.mockClear()
	const second = await runPackageOwnerNotice(input)
	expect(second.summary).toEqual({ already_sent: 2, no_recipients: 1 })
	expect(mocks.sendCloudflareEmail).not.toHaveBeenCalled()
})

test('a failed send leaves the owner unclaimed so a retry can deliver', async () => {
	const { env, kv } = await createEnv()
	mocks.items = [item('01', 'alice', '@alice/tuckabox', [bodyFinding])]
	mocks.sendCloudflareEmail.mockRejectedValueOnce(new Error('provider down'))
	consoleWarn.mockImplementation(() => {})

	const result = await runPackageOwnerNotice({
		env,
		runId: 'run-1',
		noticeId: '2026-10-body-placeholders',
		content,
		dryRun: false,
	})

	expect(result.owners[0]?.status).toBe('send_failed')
	expect(consoleWarn).toHaveBeenCalledWith(
		'package-owner-notice-send-failed',
		expect.objectContaining({ ownerId: 'alice' }),
	)
	expect(
		await kv.get(
			packageOwnerNoticeKvKey({
				noticeId: '2026-10-body-placeholders',
				ownerId: 'alice',
			}),
		),
	).toBeNull()
})

test('owners page by cursor in id order', async () => {
	const { env } = await createEnv()
	const base = {
		env,
		runId: 'run-1',
		noticeId: '2026-10-body-placeholders',
		content,
		dryRun: true,
		limit: 2,
	}

	const first = await runPackageOwnerNotice(base)
	expect(first.owners.map((owner) => owner.ownerId)).toEqual(['alice', 'dave'])
	expect(first.nextCursor).toBe('dave')

	const second = await runPackageOwnerNotice({
		...base,
		cursor: first.nextCursor,
	})
	expect(second.owners.map((owner) => owner.ownerId)).toEqual([
		'erin',
		'org-acme',
	])
	expect(second.nextCursor).toBeNull()
})

test('the email lists at most 25 packages and counts the rest', () => {
	const packages = Array.from({ length: 27 }, (_, index) => ({
		packageId: `pkg-${index}`,
		kodyId: `@alice/pkg-${index}`,
		findings: [bodyFinding],
	}))

	const email = buildPackageOwnerNoticeEmail({
		appBaseUrl: 'https://kody.test',
		content,
		packages,
	})

	expect(email.text).toContain('@alice/pkg-24 ')
	expect(email.text).not.toContain('@alice/pkg-25 ')
	expect(email.text).toContain('And 2 more.')
	expect(email.text).toContain('https://kody.test/account/packages')
})

test('the admin capability defaults to a dry run and reports bad input as a caller error', async () => {
	const { env } = await createEnv()
	const args = {
		runId: 'run-1',
		noticeId: '2026-10-body-placeholders',
		...content,
	}
	expect(adminPackageCodemodOwnerNoticeCapability.requiredRole).toBe('admin')

	const ctx = {
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://kody.test',
			user: {
				userId: personIdFromStored('admin-1'),
				email: 'admin@example.com',
				displayName: 'Admin',
				roles: ['admin'],
			},
		}),
	}
	const preview = await adminPackageCodemodOwnerNoticeCapability.handler(
		args,
		ctx as never,
	)
	expect(preview.dryRun).toBe(true)
	expect(mocks.sendCloudflareEmail).not.toHaveBeenCalled()

	const error = await adminPackageCodemodOwnerNoticeCapability
		.handler({ ...args, runId: 'missing-run' }, ctx as never)
		.catch((caught: unknown) => caught)
	expect(isMcpCallerError(error)).toBe(true)
	expect((error as Error).message).toBe('Codemod run missing-run not found.')
})
