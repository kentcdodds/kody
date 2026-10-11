/**
 * Migration auto-enable against a migrated APP_DB with real orgs and
 * memberships. Jobs, manifests, email and signing secrets are injected.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	buildEnablementNotice,
	runEnablementBackfill,
	type EnablementBackfillDeps,
} from './backfill.ts'
import {
	getEnablementOrgMigration,
	listEnablementsForOrg,
	pauseEnablement,
} from './repo.ts'

const now = '2026-10-11T00:00:00.000Z'

type Manifest = {
	subscriptions?: Record<string, { handler: string }>
	webhooks?: Array<{
		name: string
		export: string
		verification?: { type: 'hmac-sha256'; header: string; encoding: 'hex' }
	}>
}

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const ownerId = testStableUserIdFromEmail('owner@example.com')
	const memberId = testStableUserIdFromEmail('member@example.com')
	const leaverId = testStableUserIdFromEmail('leaver@example.com')
	for (const [stableUserId, username] of [
		[ownerId, 'owner'],
		[memberId, 'member'],
		[leaverId, 'leaver'],
	] as const) {
		await db
			.prepare(
				`INSERT INTO users (
					username, email, password_hash, created_at, updated_at, stable_user_id
				) VALUES (?, ?, 'hash', ?, ?, ?)`,
			)
			.bind(username, `${username}@example.com`, now, now, stableUserId)
			.run()
		await provisionPersonalOrg(db, { stableUserId, username, createdAt: now })
	}
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: personIdFromStored(ownerId),
			audit: createTestOrgAuditWriter(),
			slug: 'zeta-co',
			displayName: 'Zeta Co',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const teamOrg = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'zeta-co'`)
		.first<{ id: string }>()
	const teamOrgId = ownerIdFromStored(teamOrg!.id)
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(teamOrgId, memberId, now)
		.run()

	const jobsByOrg = new Map<
		string,
		Array<{ id: string; name: string; creatorUserId: string | null }>
	>()
	const manifestsByPackage = new Map<string, Manifest>()
	const notices: Array<{ to: string; subject: string; text: string }> = []
	const mintedSecrets: Array<string> = []
	const deps: EnablementBackfillDeps = {
		async listJobs(orgId) {
			return jobsByOrg.get(orgId) ?? []
		},
		async loadManifest({ savedPackage }) {
			const kody = manifestsByPackage.get(savedPackage.id)
			if (!kody) throw new Error(`no manifest for ${savedPackage.id}`)
			return {
				manifest: { name: savedPackage.name, kody },
			} as unknown as Awaited<
				ReturnType<EnablementBackfillDeps['loadManifest']>
			>
		},
		async sendNotice(notice) {
			notices.push(notice)
		},
		async mintWebhookSigningSecret({ orgId, endpointId }) {
			mintedSecrets.push(endpointId)
			await db
				.prepare(
					`UPDATE webhook_endpoints SET hmac_secret_encrypted = 'minted'
					 WHERE id = ? AND user_id = ?`,
				)
				.bind(endpointId, orgId)
				.run()
		},
	}

	async function addPackage(input: {
		orgId: string
		id: string
		name: string
		manifest: Manifest
	}) {
		await db
			.prepare(
				`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
				 VALUES (?, ?, ?, ?, '', ?)`,
			)
			.bind(input.id, input.orgId, input.name, input.id, `source-${input.id}`)
			.run()
		manifestsByPackage.set(input.id, input.manifest)
	}

	async function addWebhookEndpoint(input: {
		orgId: string
		id: string
		packageId: string
		webhookName: string
		createdByUserId: string | null
		hmacSecretEncrypted?: string | null
	}) {
		await db
			.prepare(
				`INSERT INTO webhook_endpoints (
					id, user_id, package_id, webhook_name, url_secret_hash, created_at,
					rotated_at, created_by_user_id, hmac_secret_encrypted
				) VALUES (?, ?, ?, ?, 'hash', ?, ?, ?, ?)`,
			)
			.bind(
				input.id,
				input.orgId,
				input.packageId,
				input.webhookName,
				now,
				now,
				input.createdByUserId,
				input.hmacSecretEncrypted ?? null,
			)
			.run()
	}

	return {
		db,
		sqlite,
		ownerId,
		memberId,
		leaverId,
		personalOrgId: ownerIdFromStored(ownerId),
		teamOrgId,
		jobsByOrg,
		notices,
		mintedSecrets,
		deps,
		addPackage,
		addWebhookEndpoint,
	}
}

async function seedTeamOrg(t: Awaited<ReturnType<typeof setup>>) {
	await t.addPackage({
		orgId: t.teamOrgId,
		id: 'pkg-mail',
		name: '@zeta-co/mail',
		manifest: {
			subscriptions: {
				'email.message.received': { handler: './src/on-email.ts' },
				'package.published': { handler: './src/on-publish.ts' },
			},
			webhooks: [
				{ name: 'github', export: './github' },
				{
					name: 'stripe',
					export: './stripe',
					verification: {
						type: 'hmac-sha256',
						header: 'stripe-signature',
						encoding: 'hex',
					},
				},
				{ name: 'linear', export: './linear' },
			],
		},
	})
	t.jobsByOrg.set(t.teamOrgId, [
		{ id: 'job-member', name: 'digest', creatorUserId: t.memberId },
		{ id: 'job-left', name: 'cleanup', creatorUserId: t.leaverId },
		{ id: 'job-legacy', name: 'legacy', creatorUserId: null },
	])
	await t.addWebhookEndpoint({
		orgId: t.teamOrgId,
		id: 'wh-github',
		packageId: 'pkg-mail',
		webhookName: 'github',
		createdByUserId: t.memberId,
	})
	await t.addWebhookEndpoint({
		orgId: t.teamOrgId,
		id: 'wh-stripe',
		packageId: 'pkg-mail',
		webhookName: 'stripe',
		createdByUserId: t.ownerId,
	})
	await t.addWebhookEndpoint({
		orgId: t.teamOrgId,
		id: 'wh-linear',
		packageId: 'pkg-mail',
		webhookName: 'linear',
		createdByUserId: t.memberId,
		hmacSecretEncrypted: 'already-set',
	})
}

test('dry-run plans one enablement per trigger for a real member and writes nothing', async () => {
	const t = await setup()
	await seedTeamOrg(t)

	const report = await runEnablementBackfill({
		db: t.db,
		mode: 'dry-run',
		deps: t.deps,
		orgIds: [t.teamOrgId],
	})

	const org = report.orgs[0]!
	expect(org).toMatchObject({
		orgSlug: 'zeta-co',
		teamOrg: true,
		stateBefore: 'legacy',
		outcome: 'planned',
	})
	const summary = org.planned.map((item) => [
		item.triggerKind,
		item.instanceId,
		item.triggerName,
		item.enablerUserId,
		item.enablerSource,
		item.unsignedWebhook,
	])
	expect(summary).toEqual([
		['cron', 'job-member', 'digest', t.memberId, 'creator', false],
		// The creator left the org; the earliest Owner takes it, never the org.
		['cron', 'job-left', 'cleanup', t.ownerId, 'earliest_owner', false],
		['cron', 'job-legacy', 'legacy', t.ownerId, 'earliest_owner', false],
		['webhook', 'wh-github', 'github', t.memberId, 'creator', true],
		['webhook', 'wh-linear', 'linear', t.memberId, 'creator', false],
		['webhook', 'wh-stripe', 'stripe', t.ownerId, 'creator', false],
		// Inbound email is the email subscription kind.
		[
			'subscription',
			'pkg-mail',
			'email.message.received',
			t.ownerId,
			'earliest_owner',
			false,
		],
		[
			'subscription',
			'pkg-mail',
			'package.published',
			t.ownerId,
			'earliest_owner',
			false,
		],
	])
	expect(
		org.notices.map((notice) => [notice.enablerUserId, notice.itemCount]),
	).toEqual([
		[t.memberId, 3],
		[t.ownerId, 5],
	])
	expect(org.notices.every((notice) => notice.recipient?.includes('@'))).toBe(
		true,
	)
	expect(report.totals).toMatchObject({
		orgsScanned: 1,
		teamOrgs: 1,
		enablementsByKind: { cron: 3, webhook: 3, subscription: 2 },
		unsignedWebhooks: 1,
		distinctEnablers: 2,
		noticesSent: 0,
	})

	expect(await listEnablementsForOrg({ db: t.db, orgId: t.teamOrgId })).toEqual(
		[],
	)
	expect(t.notices).toEqual([])
	expect(t.mintedSecrets).toEqual([])
	expect(
		await getEnablementOrgMigration({ db: t.db, orgId: t.teamOrgId }),
	).toMatchObject({ state: 'legacy' })
})

test('a team org must be notified before apply, and each member is emailed their own items', async () => {
	const t = await setup()
	await seedTeamOrg(t)

	const refused = await runEnablementBackfill({
		db: t.db,
		mode: 'apply',
		deps: t.deps,
		orgIds: [t.teamOrgId],
	})
	expect(refused.orgs[0]).toMatchObject({
		outcome: 'skipped',
		skipReason: 'notice_required',
	})
	expect(await listEnablementsForOrg({ db: t.db, orgId: t.teamOrgId })).toEqual(
		[],
	)

	const notified = await runEnablementBackfill({
		db: t.db,
		mode: 'notify',
		deps: t.deps,
		orgIds: [t.teamOrgId],
	})
	expect(notified.orgs[0]?.outcome).toBe('notified')
	expect(notified.totals.noticesSent).toBe(2)
	expect(t.notices.map((notice) => notice.to).sort()).toEqual([
		'member@example.com',
		'owner@example.com',
	])
	const memberNotice = t.notices.find(
		(notice) => notice.to === 'member@example.com',
	)!
	expect(memberNotice.subject).toBe(
		'Kody: automations in @zeta-co will run as you',
	)
	expect(memberNotice.text).toContain('- Scheduled job: digest')
	expect(memberNotice.text).toContain('- Webhook: github (@zeta-co/mail)')
	expect(memberNotice.text).not.toContain('cleanup')
	expect(memberNotice.text).not.toContain('\u2014')
	expect(
		await getEnablementOrgMigration({ db: t.db, orgId: t.teamOrgId }),
	).toMatchObject({ state: 'notified', noticeSentAt: expect.any(String) })

	// A second notify does not email again.
	await runEnablementBackfill({
		db: t.db,
		mode: 'notify',
		deps: t.deps,
		orgIds: [t.teamOrgId],
	})
	expect(t.notices).toHaveLength(2)

	const applied = await runEnablementBackfill({
		db: t.db,
		mode: 'apply',
		deps: t.deps,
		orgIds: [t.teamOrgId],
		now: () => now,
	})
	expect(applied.orgs[0]?.outcome).toBe('migrated')
	expect(t.mintedSecrets).toEqual(['wh-github'])
	const rows = await listEnablementsForOrg({ db: t.db, orgId: t.teamOrgId })
	expect(rows).toHaveLength(8)
	expect(
		rows.every((row) => row.state === 'on' && row.origin === 'migrated'),
	).toBe(true)
	expect(
		rows.find((row) => row.instanceId === 'job-member')?.enablerUserId,
	).toBe(t.memberId)
	expect(
		await getEnablementOrgMigration({ db: t.db, orgId: t.teamOrgId }),
	).toMatchObject({ state: 'migrated', migratedAt: now })
	const signed = await t.db
		.prepare(`SELECT hmac_secret_encrypted FROM webhook_endpoints WHERE id = ?`)
		.bind('wh-github')
		.first<{ hmac_secret_encrypted: string | null }>()
	expect(signed?.hmac_secret_encrypted).toBe('minted')

	// Migrated orgs leave the pending list; a rerun writes nothing new.
	const rerun = await runEnablementBackfill({
		db: t.db,
		mode: 'apply',
		deps: t.deps,
		orgIds: [t.teamOrgId],
	})
	expect(rerun.orgs).toEqual([])
	expect(
		await listEnablementsForOrg({ db: t.db, orgId: t.teamOrgId }),
	).toHaveLength(8)
})

test('a personal org migrates without a notice, and existing enablements are not duplicated', async () => {
	const t = await setup()
	await t.addPackage({
		orgId: t.personalOrgId,
		id: 'pkg-own',
		name: '@owner/own',
		manifest: { subscriptions: { 'job.run.failed': { handler: './a.ts' } } },
	})
	t.jobsByOrg.set(t.personalOrgId, [
		{ id: 'job-own', name: 'own', creatorUserId: null },
	])

	consoleWarn.mockImplementation(() => {})
	// A partial earlier run already wrote the job enablement, then paused.
	await runEnablementBackfill({
		db: t.db,
		mode: 'apply',
		deps: {
			...t.deps,
			async loadManifest() {
				throw new Error('registry unavailable')
			},
		},
		orgIds: [t.personalOrgId],
	}).then((report) => {
		expect(report.orgs[0]).toMatchObject({
			outcome: 'skipped',
			skipReason: 'manifest_load_failed',
		})
	})
	expect(consoleWarn.mock.calls[0]?.[0]).toBe(
		'enablement-backfill-manifest-load-failed',
	)
	await t.db
		.prepare(
			`INSERT INTO enablements (
				id, org_id, trigger_kind, trigger_name, instance_id, enabler_user_id,
				state, origin, enabled_at, updated_at
			) VALUES ('e-1', ?, 'cron', 'own', 'job-own', ?, 'on', 'migrated', ?, ?)`,
		)
		.bind(t.personalOrgId, t.ownerId, now, now)
		.run()
	await pauseEnablement({
		db: t.db,
		orgId: t.personalOrgId,
		id: 'e-1',
		pause: { reason: 'org_access' },
	})

	const report = await runEnablementBackfill({
		db: t.db,
		mode: 'apply',
		deps: t.deps,
		orgIds: [t.personalOrgId],
	})
	expect(report.orgs[0]).toMatchObject({ teamOrg: false, outcome: 'migrated' })
	expect(report.orgs[0]?.notices).toEqual([])
	expect(t.notices).toEqual([])
	const rows = await listEnablementsForOrg({
		db: t.db,
		orgId: t.personalOrgId,
	})
	expect(
		rows.map((row) => [row.triggerKind, row.instanceId, row.state]),
	).toEqual([
		['cron', 'job-own', 'paused'],
		['subscription', 'pkg-own', 'on'],
	])
})

test('paging walks every live org in id order, skipping migrated and deleted ones', async () => {
	const t = await setup()
	const first = await runEnablementBackfill({
		db: t.db,
		mode: 'dry-run',
		deps: t.deps,
		limit: 2,
	})
	expect(first.orgs).toHaveLength(2)
	expect(first.nextCursor).toBe(first.orgs[1]?.orgId)
	const rest = await runEnablementBackfill({
		db: t.db,
		mode: 'dry-run',
		deps: t.deps,
		limit: 10,
		cursor: first.nextCursor,
	})
	expect(rest.nextCursor).toBeNull()
	const all = [...first.orgs, ...rest.orgs].map((org) => org.orgId)
	expect(all).toEqual([...all].sort())
	expect(new Set(all)).toEqual(
		new Set([
			t.personalOrgId,
			ownerIdFromStored(t.memberId),
			ownerIdFromStored(t.leaverId),
			t.teamOrgId,
		]),
	)

	await runEnablementBackfill({
		db: t.db,
		mode: 'apply',
		deps: t.deps,
		orgIds: [t.personalOrgId],
	})
	await t.db
		.prepare(`UPDATE orgs SET deleted_at = ? WHERE id = ?`)
		.bind(now, ownerIdFromStored(t.leaverId))
		.run()
	const after = await runEnablementBackfill({
		db: t.db,
		mode: 'dry-run',
		deps: t.deps,
	})
	expect(new Set(after.orgs.map((org) => org.orgId))).toEqual(
		new Set([ownerIdFromStored(t.memberId), t.teamOrgId]),
	)
})

test('an org with no live Owner is skipped instead of falling back to a system owner', async () => {
	const t = await setup()
	t.jobsByOrg.set(t.teamOrgId, [
		{ id: 'job-1', name: 'digest', creatorUserId: t.memberId },
	])
	await t.db
		.prepare(
			`UPDATE org_memberships SET deleted_at = ?
			 WHERE org_id = ? AND role = 'owner'`,
		)
		.bind(now, t.teamOrgId)
		.run()
	const report = await runEnablementBackfill({
		db: t.db,
		mode: 'dry-run',
		deps: t.deps,
		orgIds: [t.teamOrgId],
	})
	expect(report.orgs[0]).toMatchObject({
		outcome: 'skipped',
		skipReason: 'no_owner',
		planned: [],
	})
})

test('the notice names each item and contains no em dashes', () => {
	const notice = buildEnablementNotice({
		orgSlug: 'zeta-co',
		items: [
			{
				triggerKind: 'subscription',
				triggerName: 'email.message.received',
				instanceId: 'pkg',
				packageId: 'pkg',
				packageName: '@zeta-co/mail',
				enablerUserId: 'u',
				enablerSource: 'creator',
				unsignedWebhook: false,
			} satisfies Parameters<typeof buildEnablementNotice>[0]['items'][number],
		],
	})
	expect(notice.text).toContain(
		'- Subscription: email.message.received (@zeta-co/mail)',
	)
	expect(`${notice.subject}\n${notice.text}`).not.toMatch(/\u2014/)
})
