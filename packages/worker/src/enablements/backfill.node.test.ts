/**
 * Migration auto-enable against a migrated APP_DB with real orgs and
 * memberships. Jobs, manifests, email and signing secrets are injected.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
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
	buildInsertEnablementStatement,
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
	// New team orgs start on enablements; this one predates the migration.
	await db
		.prepare(`DELETE FROM enablement_org_migrations WHERE org_id = ?`)
		.bind(teamOrgId)
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(teamOrgId, memberId, now)
		.run()

	const jobsByOrg = new Map<
		string,
		Array<{
			id: string
			name: string
			creatorUserId: string | null
			active: boolean
		}>
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
		await db
			.prepare(
				`INSERT INTO entity_sources (
					id, user_id, entity_kind, entity_id, repo_id, published_commit,
					created_at, updated_at
				) VALUES (?, ?, 'package', ?, ?, 'commit-1', ?, ?)`,
			)
			.bind(
				`source-${input.id}`,
				input.orgId,
				input.id,
				`repo-${input.id}`,
				now,
				now,
			)
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
		enabled?: boolean
	}) {
		await db
			.prepare(
				`INSERT INTO webhook_endpoints (
					id, user_id, package_id, webhook_name, url_secret_hash, created_at,
					rotated_at, created_by_user_id, hmac_secret_encrypted, enabled
				) VALUES (?, ?, ?, ?, 'hash', ?, ?, ?, ?, ?)`,
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
				input.enabled === false ? 0 : 1,
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
				{ name: 'sentry', export: './sentry' },
			],
		},
	})
	t.jobsByOrg.set(t.teamOrgId, [
		{
			id: 'job-member',
			name: 'digest',
			creatorUserId: t.memberId,
			active: true,
		},
		{
			id: 'job-left',
			name: 'cleanup',
			creatorUserId: t.leaverId,
			active: true,
		},
		{ id: 'job-legacy', name: 'legacy', creatorUserId: null, active: true },
		// Disabled or kill-switched: it does not run today.
		{ id: 'job-off', name: 'paused', creatorUserId: t.memberId, active: false },
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
	// A disabled URL, and a URL whose webhook the package no longer declares.
	await t.addWebhookEndpoint({
		orgId: t.teamOrgId,
		id: 'wh-disabled',
		packageId: 'pkg-mail',
		webhookName: 'sentry',
		createdByUserId: t.memberId,
		enabled: false,
	})
	await t.addWebhookEndpoint({
		orgId: t.teamOrgId,
		id: 'wh-gone',
		packageId: 'pkg-mail',
		webhookName: 'removed',
		createdByUserId: t.memberId,
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
		inactive: 3,
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
		inactiveTriggers: 3,
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
		{ id: 'job-own', name: 'own', creatorUserId: null, active: true },
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
		{ id: 'job-1', name: 'digest', creatorUserId: t.memberId, active: true },
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

test('a rerun after a rename or a turned-off personal row keeps one migrated row per trigger', async () => {
	const t = await setup()
	t.jobsByOrg.set(t.personalOrgId, [
		{ id: 'job-a', name: 'renamed', creatorUserId: null, active: true },
		{ id: 'job-b', name: 'nightly', creatorUserId: null, active: true },
	])
	// An earlier partial apply wrote job-a under its old name.
	await t.db
		.prepare(
			`INSERT INTO enablements (
				id, org_id, trigger_kind, trigger_name, instance_id, enabler_user_id,
				state, origin, enabled_at, updated_at
			) VALUES ('e-a', ?, 'cron', 'old-name', 'job-a', ?, 'on', 'migrated', ?, ?)`,
		)
		.bind(t.personalOrgId, t.ownerId, now, now)
		.run()
	// Someone's own enablement of job-b that they turned off.
	await t.db
		.prepare(
			`INSERT INTO enablements (
				id, org_id, trigger_kind, trigger_name, instance_id, enabler_user_id,
				state, origin, enabled_at, disabled_at, updated_at
			) VALUES ('e-b', ?, 'cron', 'nightly', 'job-b', ?, 'off', 'enabled', ?, ?, ?)`,
		)
		.bind(t.personalOrgId, t.ownerId, now, now, now)
		.run()

	const report = await runEnablementBackfill({
		db: t.db,
		mode: 'apply',
		deps: t.deps,
		orgIds: [t.personalOrgId],
	})
	expect(report.orgs[0]?.planned.map((item) => item.instanceId)).toEqual([
		'job-b',
	])
	const migrated = await t.db
		.prepare(
			`SELECT instance_id FROM enablements
			 WHERE org_id = ? AND origin = 'migrated' AND state = 'on'
			 ORDER BY instance_id`,
		)
		.bind(t.personalOrgId)
		.all<{ instance_id: string }>()
	expect(migrated.results.map((row) => row.instance_id)).toEqual([
		'job-a',
		'job-b',
	])
})

test('the unique migrated index makes an overlapping apply a no-op', async () => {
	const t = await setup()
	// Two applies that both planned before either wrote insert the same
	// trigger, even when a rename between their reads changed the name.
	const insert = (input: {
		id: string
		triggerKind: 'cron' | 'subscription'
		triggerName: string
		instanceId: string
	}) =>
		buildInsertEnablementStatement({
			db: t.db,
			enablement: {
				...input,
				orgId: t.personalOrgId,
				packageId:
					input.triggerKind === 'subscription' ? input.instanceId : null,
				enablerUserId: t.ownerId,
				origin: 'migrated',
			},
			now,
			ignoreConflicts: true,
		}).statement.run()
	await insert({
		id: 'e-1',
		triggerKind: 'cron',
		triggerName: 'a',
		instanceId: 'job-a',
	})
	await insert({
		id: 'e-2',
		triggerKind: 'cron',
		triggerName: 'renamed',
		instanceId: 'job-a',
	})
	await insert({
		id: 'e-3',
		triggerKind: 'subscription',
		triggerName: 'job.run.failed',
		instanceId: 'pkg-a',
	})
	await insert({
		id: 'e-4',
		triggerKind: 'subscription',
		triggerName: 'job.run.failed',
		instanceId: 'pkg-a',
	})
	await insert({
		id: 'e-5',
		triggerKind: 'subscription',
		triggerName: 'email.received',
		instanceId: 'pkg-a',
	})
	const rows = await listEnablementsForOrg({ db: t.db, orgId: t.personalOrgId })
	expect(rows.map((row) => row.id).sort()).toEqual(['e-1', 'e-3', 'e-5'])
})

test('a never-published package does not block its org, but a failed manifest read does', async () => {
	const t = await setup()
	await t.addPackage({
		orgId: t.personalOrgId,
		id: 'pkg-live',
		name: '@owner/live',
		manifest: { subscriptions: { 'job.run.failed': { handler: './a.ts' } } },
	})
	await t.db
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES ('pkg-draft', ?, '@owner/draft', 'pkg-draft', '', 'source-draft')`,
		)
		.bind(t.personalOrgId)
		.run()

	const report = await runEnablementBackfill({
		db: t.db,
		mode: 'dry-run',
		deps: t.deps,
		orgIds: [t.personalOrgId],
	})
	expect(report.orgs[0]).toMatchObject({ outcome: 'planned' })
	expect(report.orgs[0]?.planned.map((item) => item.instanceId)).toEqual([
		'pkg-live',
	])

	consoleWarn.mockImplementation(() => {})
	await t.db
		.prepare(
			`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit,
				created_at, updated_at
			) VALUES ('source-draft', ?, 'package', 'pkg-draft', 'repo-draft', 'c1', ?, ?)`,
		)
		.bind(t.personalOrgId, now, now)
		.run()
	const blocked = await runEnablementBackfill({
		db: t.db,
		mode: 'dry-run',
		deps: t.deps,
		orgIds: [t.personalOrgId],
	})
	expect(blocked.orgs[0]).toMatchObject({
		outcome: 'skipped',
		skipReason: 'manifest_load_failed',
	})
})

test('notify covers every enabler before an org counts as notified, and never emails twice', async () => {
	const t = await setup()
	await seedTeamOrg(t)
	await t.db
		.prepare(`UPDATE users SET email = '' WHERE stable_user_id = ?`)
		.bind(t.memberId)
		.run()

	const missing = await runEnablementBackfill({
		db: t.db,
		mode: 'notify',
		deps: t.deps,
		orgIds: [t.teamOrgId],
	})
	expect(missing.orgs[0]).toMatchObject({
		outcome: 'skipped',
		skipReason: 'notice_incomplete',
	})
	expect(t.notices.map((notice) => notice.to)).toEqual(['owner@example.com'])
	expect(
		await getEnablementOrgMigration({ db: t.db, orgId: t.teamOrgId }),
	).toMatchObject({ state: 'legacy' })
	const refused = await runEnablementBackfill({
		db: t.db,
		mode: 'apply',
		deps: t.deps,
		orgIds: [t.teamOrgId],
	})
	expect(refused.orgs[0]).toMatchObject({ skipReason: 'notice_required' })

	// The member's address is fixed, but the first send fails.
	await t.db
		.prepare(
			`UPDATE users SET email = 'member@example.com' WHERE stable_user_id = ?`,
		)
		.bind(t.memberId)
		.run()
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	const failing = await runEnablementBackfill({
		db: t.db,
		mode: 'notify',
		deps: {
			...t.deps,
			async sendNotice() {
				throw new Error('daily send limit')
			},
		},
		orgIds: [t.teamOrgId],
	})
	expect(failing.orgs[0]).toMatchObject({ skipReason: 'notice_incomplete' })
	expect(consoleError.mock.calls[0]?.[0]).toBe(
		'enablement-backfill-notice-failed',
	)
	consoleError.mockRestore()

	const retried = await runEnablementBackfill({
		db: t.db,
		mode: 'notify',
		deps: t.deps,
		orgIds: [t.teamOrgId],
	})
	expect(retried.orgs[0]?.outcome).toBe('notified')
	expect(t.notices.map((notice) => notice.to)).toEqual([
		'owner@example.com',
		'member@example.com',
	])
})

test('apply refuses items added after the notice until their enabler is told', async () => {
	const t = await setup()
	await seedTeamOrg(t)
	await runEnablementBackfill({
		db: t.db,
		mode: 'notify',
		deps: t.deps,
		orgIds: [t.teamOrgId],
	})
	expect(t.notices).toHaveLength(2)

	t.jobsByOrg.get(t.teamOrgId)!.push({
		id: 'job-new',
		name: 'weekly',
		creatorUserId: t.memberId,
		active: true,
	})
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
	expect(
		refused.orgs[0]?.notices.map((notice) => [
			notice.enablerUserId,
			notice.notified,
		]),
	).toEqual([
		[t.memberId, false],
		[t.ownerId, true],
	])

	const renotified = await runEnablementBackfill({
		db: t.db,
		mode: 'notify',
		deps: t.deps,
		orgIds: [t.teamOrgId],
	})
	expect(renotified.orgs[0]?.outcome).toBe('notified')
	expect(t.notices.map((notice) => notice.to)).toEqual([
		expect.any(String),
		expect.any(String),
		'member@example.com',
	])
	expect(t.notices[2]?.text).toContain('- Scheduled job: weekly')

	const applied = await runEnablementBackfill({
		db: t.db,
		mode: 'apply',
		deps: t.deps,
		orgIds: [t.teamOrgId],
	})
	expect(applied.orgs[0]?.outcome).toBe('migrated')
	expect(
		(await listEnablementsForOrg({ db: t.db, orgId: t.teamOrgId })).some(
			(row) => row.instanceId === 'job-new',
		),
	).toBe(true)
})

test('a full page filtered by org ids still returns a cursor', async () => {
	const t = await setup()
	const orgIds = [t.personalOrgId, t.teamOrgId]
	const first = await runEnablementBackfill({
		db: t.db,
		mode: 'dry-run',
		deps: t.deps,
		orgIds,
		limit: 1,
	})
	expect(first.nextCursor).toBe(first.orgs[0]?.orgId)
	const second = await runEnablementBackfill({
		db: t.db,
		mode: 'dry-run',
		deps: t.deps,
		orgIds,
		limit: 1,
		cursor: first.nextCursor,
	})
	const third = await runEnablementBackfill({
		db: t.db,
		mode: 'dry-run',
		deps: t.deps,
		orgIds,
		limit: 1,
		cursor: second.nextCursor,
	})
	expect(
		new Set([...first.orgs, ...second.orgs].map((org) => org.orgId)),
	).toEqual(new Set(orgIds))
	expect(third.orgs).toEqual([])
	expect(third.nextCursor).toBeNull()
})

test('the notice tells the enabler of an unsigned webhook where its signing secret is', () => {
	const notice = buildEnablementNotice({
		orgSlug: 'zeta-co',
		items: [
			{
				triggerKind: 'webhook',
				triggerName: 'github',
				instanceId: 'wh',
				packageId: 'pkg',
				packageName: '@zeta-co/mail',
				enablerUserId: 'u',
				enablerSource: 'creator',
				unsignedWebhook: true,
			},
		],
	})
	expect(notice.text).toContain('X-Kody-Signature')
	expect(notice.text).toContain('package settings')
	expect(notice.text).not.toMatch(/\u2014/)
})
