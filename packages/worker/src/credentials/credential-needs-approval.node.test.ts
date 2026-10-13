import { DatabaseSync } from 'node:sqlite'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import type * as NeedsClosure from './credential-needs-closure.ts'
import { type CredentialNeed } from './credential-needs.ts'

const mocks = vi.hoisted(() => ({
	before: [] as Array<CredentialNeed>,
	after: [] as Array<CredentialNeed>,
	computeError: null as Error | null,
	source: null as EntitySourceRow | null,
	publishFromExternalRef: vi.fn(),
}))

vi.mock('./credential-needs-closure.ts', async (importOriginal) => ({
	...(await importOriginal<typeof NeedsClosure>()),
	loadPublishedCredentialNeeds: async () => mocks.before,
	computeCredentialNeedsClosure: async () => {
		if (mocks.computeError) throw mocks.computeError
		return { needs: mocks.after, conflicts: [] }
	},
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: async () => mocks.source,
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: () => ({
		publishFromExternalRef: (...args: Array<unknown>) =>
			mocks.publishFromExternalRef(...args),
	}),
}))

const {
	createCredentialNeedsApprovalMessage,
	diffCredentialNeeds,
	requireCredentialNeedsApproval,
} = await import('./credential-needs-approval.ts')
const { approveCredentialNeedsRequest, loadPendingPackageApprovals } =
	await import('#app/account-package-approval-requests.ts')
const { enqueuePackageApprovalRequest, getPackageApprovalRequest } =
	await import('#worker/package-capabilities/approval-requests-repo.ts')

const ownerId = ownerIdFromStored('org-acme')
const manifestContent = JSON.stringify({
	name: '@acme/mailer',
	exports: { '.': './index.ts' },
	kody: { id: 'mailer', description: 'Sends mail' },
})

function need(key: string, overrides: Partial<CredentialNeed> = {}) {
	return {
		key,
		kind: 'secret' as const,
		provider: 'resend',
		description: '',
		multiple: false,
		...overrides,
	}
}

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const env = { APP_DB: db } as unknown as Env
	const packageId = 'package-mailer'
	const now = '2026-10-13T00:00:00.000Z'
	await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: ownerId,
			name: '@acme/mailer',
			kody_id: 'mailer',
			description: 'Sends mail',
			tags_json: '[]',
			search_text: null,
			source_id: 'source-mailer',
			has_app: 0,
			has_skills: 0,
			hidden: 0,
			is_private: 1,
			created_at: now,
			updated_at: now,
		},
		null,
		{ stamp: false },
	)
	const source = {
		id: 'source-mailer',
		user_id: ownerId,
		entity_kind: 'package',
		entity_id: packageId,
		repo_id: 'repo-mailer',
		published_commit: 'commit-old',
		manifest_path: 'package.json',
		source_root: '/',
	} as EntitySourceRow
	mocks.source = source
	const gate = (pendingCommit = 'commit-new') =>
		requireCredentialNeedsApproval({
			env,
			source,
			pendingCommit,
			files: { 'package.json': manifestContent },
			requestedByUserId: 'person-bea',
		})
	return { db, env, packageId, source, gate }
}

beforeEach(() => {
	mocks.before = []
	mocks.after = []
	mocks.computeError = null
	mocks.publishFromExternalRef.mockReset()
})

test('only added or reshaped needs count as a change', () => {
	expect(
		diffCredentialNeeds(
			[need('MAIL'), need('GONE'), need('DOCS', { description: 'old' })],
			[
				need('MAIL', { provider: 'postmark' }),
				need('DOCS', { description: 'new' }),
				need('SMS', { kind: 'login', provider: 'twilio', from: '@acme/sms' }),
			],
		),
	).toEqual([
		{
			key: 'MAIL',
			change: 'changed',
			before: { kind: 'secret', provider: 'resend', multiple: false },
			after: { kind: 'secret', provider: 'postmark', multiple: false },
		},
		{
			key: 'SMS',
			change: 'added',
			after: { kind: 'login', provider: 'twilio', multiple: false },
			from: '@acme/sms',
		},
	])
	expect(
		createCredentialNeedsApprovalMessage({
			packageName: '@acme/mailer',
			changes: diffCredentialNeeds([], [need('MAIL', { multiple: true })]),
			approvalUrl: 'https://kody.test/approve',
		}),
	).toBe(
		'Package "@acme/mailer" changed its credential needs: MAIL (added: secret from "resend", multiple). This publish waits for approval, and the previously published version keeps running until then. The owner approves it at https://kody.test/approve.',
	)
})

test('a needs change queues one pending approval per package; unchanged, removed, first, and failed computes publish', async () => {
	const t = await setup()
	mocks.before = [need('MAIL'), need('OLD')]
	mocks.after = [need('MAIL')]
	await expect(t.gate()).resolves.toBeNull()

	mocks.computeError = new Error('dependency vanished')
	mocks.after = [need('NEW')]
	await expect(t.gate()).resolves.toBeNull()
	mocks.computeError = null

	await expect(
		requireCredentialNeedsApproval({
			env: t.env,
			source: { ...t.source, published_commit: null },
			pendingCommit: 'commit-first',
			files: { 'package.json': manifestContent },
		}),
	).resolves.toBeNull()

	const first = await t.gate()
	expect(first).toMatchObject({
		packageId: t.packageId,
		packageName: '@acme/mailer',
		kodyId: 'mailer',
		pendingCommit: 'commit-new',
		changes: [{ key: 'NEW', change: 'added' }],
	})
	const again = await t.gate()
	expect(again?.requestId).toBe(first?.requestId)

	const newer = await t.gate('commit-newer')
	expect(newer?.requestId).not.toBe(first?.requestId)
	await expect(
		getPackageApprovalRequest(t.db, {
			id: first!.requestId,
			packageId: t.packageId,
			ownerUserId: ownerId,
		}),
	).resolves.toMatchObject({ status: 'superseded' })
	const pending = await loadPendingPackageApprovals({
		env: t.env,
		ownerUserId: ownerId,
		packageId: t.packageId,
		publishedCommit: 'commit-old',
	})
	expect(pending).toEqual([
		expect.objectContaining({
			id: newer?.requestId,
			reason: 'credential_needs_changed',
			reasonLabel: 'Credential needs changed',
			pendingCommit: 'commit-newer',
			changes: ['NEW (added: secret from "resend")'],
			approveAction: 'approve-credential-needs',
		}),
	])
	await expect(
		loadPendingPackageApprovals({
			env: t.env,
			ownerUserId: ownerId,
			packageId: t.packageId,
			publishedCommit: 'commit-later',
		}),
	).resolves.toEqual([])
})

test('approving publishes the paused commit past the pause; a moved base supersedes it', async () => {
	const t = await setup()
	const savedPackage = {
		id: t.packageId,
		userId: ownerId,
		sourceId: 'source-mailer',
	} as SavedPackageRecord
	const enqueue = (pendingCommit: string) =>
		enqueuePackageApprovalRequest(t.db, {
			packageId: t.packageId,
			ownerUserId: ownerId,
			reason: 'credential_needs_changed',
			pendingCommit,
			baseCommit: 'commit-old',
			details: { changes: [] },
			requestedByUserId: null,
		})
	const approve = (requestId: string) =>
		approveCredentialNeedsRequest({
			env: t.env,
			request: new Request('https://kody.test/approve'),
			savedPackage,
			ownerUserId: ownerId,
			actorUserId: 'person-bea',
			requestId,
		})
	const request = await enqueue('commit-new')
	mocks.publishFromExternalRef.mockResolvedValueOnce({
		status: 'checks_failed',
		failed_checks: [],
		manifest: null,
		run_id: 'run-1',
	})
	await expect(approve(request.id)).resolves.toMatchObject({
		ok: false,
		status: 400,
	})
	mocks.publishFromExternalRef.mockResolvedValueOnce({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'commit-new',
	})
	await expect(approve(request.id)).resolves.toEqual({ ok: true })
	expect(mocks.publishFromExternalRef).toHaveBeenLastCalledWith(
		expect.objectContaining({
			newCommit: 'commit-new',
			credentialNeedsApproved: true,
		}),
	)
	expect(
		(
			await getPackageApprovalRequest(t.db, {
				id: request.id,
				packageId: t.packageId,
				ownerUserId: ownerId,
			})
		)?.status,
	).toBe('approved')
	await expect(approve(request.id)).resolves.toMatchObject({
		ok: false,
		status: 409,
	})

	const stale = await enqueue('commit-two')
	mocks.source = { ...t.source, published_commit: 'commit-codemod' }
	mocks.publishFromExternalRef.mockClear()
	await expect(approve(stale.id)).resolves.toMatchObject({
		ok: false,
		status: 409,
		error: expect.stringContaining('Publish again'),
	})
	expect(mocks.publishFromExternalRef).not.toHaveBeenCalled()
	await expect(approve('missing')).resolves.toMatchObject({ status: 404 })
})
