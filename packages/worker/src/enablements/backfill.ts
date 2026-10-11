/**
 * Migration auto-enable (credentials plan v4, section 3.3). Every trigger
 * that runs today becomes exactly one enablement for a real member, so the
 * same things keep running for the same people:
 *
 * - cron jobs, webhooks and subscriptions (inbound email included) get one
 *   enablement each;
 * - the enabler is the item's creator when that person is still a member,
 *   else the org's earliest live Owner. There is no system owner;
 * - each migrated webhook without signature verification gets a generated
 *   signing secret, because every webhook enablement verifies signatures.
 *
 * Team orgs move billing from the org to each enabler, so their members are
 * emailed first (`notify`); `apply` refuses a team org that was not
 * notified. Personal orgs migrate directly (the enabler is the person).
 *
 * Email handlers get one enablement for now. Running only the sender's own
 * enablements (one per member) arrives with the per-sender email change
 * (credentials plan PR 9).
 */
import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { redactEmailRecipient } from '#worker/audit-log.ts'
import { sendSystemEmail } from '#worker/email/system-outbound.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { packageIdFromJobId } from '#worker/jobs/package-job-id.ts'
import {
	listPackageSubscriptions,
	listPackageWebhooks,
} from '#worker/package-registry/manifest.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { setWebhookEndpointHmacSecret } from '#worker/webhooks/repo.ts'
import { mintPackageOwnedWebhookHmacCiphertext } from '#worker/webhooks/signing-secret.ts'
import {
	buildInsertEnablementStatement,
	buildMarkEnablementOrgMigratedStatement,
	listEnablementsForOrg,
	listPendingEnablementOrgMigrations,
	loadEarliestLiveOwnerId,
	markEnablementOrgNotified,
	type EnablementOrgMigration,
} from './repo.ts'
import { type EnablementTriggerKind } from './types.ts'

export type EnablementBackfillMode = 'dry-run' | 'notify' | 'apply'

export type PlannedEnablement = {
	triggerKind: EnablementTriggerKind
	triggerName: string
	instanceId: string
	packageId: string | null
	packageName: string | null
	enablerUserId: string
	enablerSource: 'creator' | 'earliest_owner'
	/** Webhook with no signature verification today; gets a generated secret. */
	unsignedWebhook: boolean
}

export type OrgBackfillOutcome = 'planned' | 'notified' | 'migrated' | 'skipped'

export type OrgBackfillSkipReason =
	| 'no_owner'
	| 'notice_required'
	| 'manifest_load_failed'
	| 'org_missing'

export type OrgBackfillReport = {
	orgId: string
	orgSlug: string | null
	teamOrg: boolean
	stateBefore: EnablementOrgMigration['state']
	outcome: OrgBackfillOutcome
	skipReason: OrgBackfillSkipReason | null
	planned: Array<PlannedEnablement>
	/** One entry per member a team-org notice went (or would go) to. */
	notices: Array<{
		enablerUserId: string
		recipient: string | null
		itemCount: number
	}>
}

export type EnablementBackfillReport = {
	mode: EnablementBackfillMode
	orgs: Array<OrgBackfillReport>
	nextCursor: string | null
	totals: {
		orgsScanned: number
		orgsByOutcome: Record<OrgBackfillOutcome, number>
		teamOrgs: number
		enablementsByKind: Record<EnablementTriggerKind, number>
		unsignedWebhooks: number
		distinctEnablers: number
		noticesSent: number
	}
}

type WebhookEndpointBackfillRow = {
	id: string
	package_id: string
	webhook_name: string
	created_by_user_id: string | null
	hmac_secret_encrypted: string | null
}

type BackfillJob = {
	id: string
	name: string
	creatorUserId: string | null
}

export type EnablementBackfillDeps = {
	listJobs(orgId: string): Promise<Array<BackfillJob>>
	loadManifest(input: {
		orgId: string
		savedPackage: SavedPackageRecord
	}): Promise<Awaited<ReturnType<typeof loadPackageManifestBySourceId>>>
	sendNotice(input: {
		to: string
		subject: string
		text: string
	}): Promise<void>
	mintWebhookSigningSecret(input: {
		orgId: string
		endpointId: string
	}): Promise<void>
}

export function defaultEnablementBackfillDeps(input: {
	env: Env
	baseUrl: string
}): EnablementBackfillDeps {
	return {
		async listJobs(orgId) {
			const rows = await jobsData(input.env).listJobsForUser({
				userId: orgId,
			})
			return rows.map((row) => ({
				id: row.record.id,
				name: row.record.name,
				creatorUserId: row.callerContext?.user?.userId ?? null,
			}))
		},
		async loadManifest({ orgId, savedPackage }) {
			return await loadPackageManifestBySourceId({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: orgId,
				sourceId: savedPackage.sourceId,
			})
		},
		async sendNotice(notice) {
			await sendSystemEmail({
				env: input.env,
				to: notice.to,
				subject: notice.subject,
				text: notice.text,
			})
		},
		async mintWebhookSigningSecret({ orgId, endpointId }) {
			const { encrypted } = await mintPackageOwnedWebhookHmacCiphertext({
				env: input.env,
				userId: ownerIdFromStored(orgId),
				endpointId,
			})
			await setWebhookEndpointHmacSecret({
				db: input.env.APP_DB,
				userId: orgId,
				endpointId,
				hmacSecretEncrypted: encrypted,
			})
		},
	}
}

async function loadLiveMemberIds(db: D1Database, orgId: string) {
	const result = await db
		.prepare(
			`SELECT m.user_id AS user_id
			 FROM org_memberships m
			 INNER JOIN users u ON u.stable_user_id = m.user_id
			 WHERE m.org_id = ? AND m.deleted_at IS NULL
			   AND u.deleted_at IS NULL AND u.deleting_at IS NULL`,
		)
		.bind(orgId)
		.all<{ user_id: string }>()
	return new Set((result.results ?? []).map((row) => row.user_id))
}

async function loadOrg(db: D1Database, orgId: string) {
	const org = await db
		.prepare(
			`SELECT id, slug FROM orgs
			 WHERE id = ? AND deleted_at IS NULL AND deleting_at IS NULL`,
		)
		.bind(orgId)
		.first<{ id: string; slug: string | null }>()
	if (!org) return null
	const person = await db
		.prepare(
			`SELECT 1 AS ok FROM users WHERE stable_user_id = ? AND deleted_at IS NULL`,
		)
		.bind(orgId)
		.first<{ ok: number }>()
	return { slug: org.slug, teamOrg: person == null }
}

async function loadWebhookEndpoints(db: D1Database, orgId: string) {
	const result = await db
		.prepare(
			`SELECT id, package_id, webhook_name, created_by_user_id,
			        hmac_secret_encrypted
			 FROM webhook_endpoints
			 WHERE user_id = ? AND deleted_at IS NULL
			 ORDER BY created_at, id`,
		)
		.bind(orgId)
		.all<WebhookEndpointBackfillRow>()
	return result.results ?? []
}

async function loadMemberEmails(
	db: D1Database,
	userIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
	const emails = new Map<string, string>()
	for (const chunk of chunkArray([...userIds], 50)) {
		const result = await db
			.prepare(
				`SELECT stable_user_id, email FROM users
				 WHERE stable_user_id IN (${chunk.map(() => '?').join(', ')})
				   AND deleted_at IS NULL`,
			)
			.bind(...chunk)
			.all<{ stable_user_id: string; email: string | null }>()
		for (const row of result.results ?? []) {
			if (row.email?.trim()) emails.set(row.stable_user_id, row.email.trim())
		}
	}
	return emails
}

function plannedKey(input: {
	triggerKind: EnablementTriggerKind
	instanceId: string
	triggerName: string
}) {
	return `${input.triggerKind}\u0000${input.instanceId}\u0000${input.triggerName}`
}

type OrgPlan =
	| { ok: true; planned: Array<PlannedEnablement> }
	| { ok: false; reason: OrgBackfillSkipReason }

/** What the auto-enable step would write for one org. Reads only. */
export async function planOrgEnablements(input: {
	db: D1Database
	orgId: string
	deps: Pick<EnablementBackfillDeps, 'listJobs' | 'loadManifest'>
}): Promise<OrgPlan> {
	const earliestOwner = await loadEarliestLiveOwnerId(input.db, input.orgId)
	if (!earliestOwner) return { ok: false, reason: 'no_owner' }
	const members = await loadLiveMemberIds(input.db, input.orgId)
	const enablerFor = (creator: string | null) =>
		creator && members.has(creator)
			? { enablerUserId: creator, enablerSource: 'creator' as const }
			: {
					enablerUserId: earliestOwner,
					enablerSource: 'earliest_owner' as const,
				}

	const existing = new Set(
		(
			await listEnablementsForOrg({
				db: input.db,
				orgId: input.orgId,
				includeOff: true,
			})
		).map(plannedKey),
	)
	const savedPackages = await listSavedPackagesByUserId(input.db, {
		userId: input.orgId,
	})
	const packagesById = new Map(savedPackages.map((pkg) => [pkg.id, pkg]))
	const manifests = new Map<
		string,
		Awaited<ReturnType<EnablementBackfillDeps['loadManifest']>>
	>()
	for (const savedPackage of savedPackages) {
		try {
			manifests.set(
				savedPackage.id,
				await input.deps.loadManifest({ orgId: input.orgId, savedPackage }),
			)
		} catch (error) {
			console.warn('enablement-backfill-manifest-load-failed', {
				orgId: input.orgId,
				packageId: savedPackage.id,
				error,
			})
			return { ok: false, reason: 'manifest_load_failed' }
		}
	}

	const planned: Array<PlannedEnablement> = []
	const add = (entry: PlannedEnablement) => {
		const key = plannedKey(entry)
		if (existing.has(key)) return
		existing.add(key)
		planned.push(entry)
	}

	for (const job of await input.deps.listJobs(input.orgId)) {
		const packageId = packageIdFromJobId(job.id)
		add({
			triggerKind: 'cron',
			triggerName: job.name,
			instanceId: job.id,
			packageId,
			packageName: packageId
				? (packagesById.get(packageId)?.name ?? null)
				: null,
			...enablerFor(job.creatorUserId),
			unsignedWebhook: false,
		})
	}

	for (const endpoint of await loadWebhookEndpoints(input.db, input.orgId)) {
		const manifest = manifests.get(endpoint.package_id)
		const declared = manifest
			? listPackageWebhooks(manifest.manifest).find(
					(webhook) => webhook.name === endpoint.webhook_name,
				)
			: undefined
		add({
			triggerKind: 'webhook',
			triggerName: endpoint.webhook_name,
			instanceId: endpoint.id,
			packageId: endpoint.package_id,
			packageName: packagesById.get(endpoint.package_id)?.name ?? null,
			...enablerFor(endpoint.created_by_user_id),
			unsignedWebhook:
				!declared?.verification && !endpoint.hmac_secret_encrypted,
		})
	}

	for (const savedPackage of savedPackages) {
		const manifest = manifests.get(savedPackage.id)
		if (!manifest) continue
		for (const subscription of listPackageSubscriptions(manifest.manifest)) {
			add({
				triggerKind: 'subscription',
				triggerName: subscription.topic,
				instanceId: savedPackage.id,
				packageId: savedPackage.id,
				packageName: savedPackage.name,
				...enablerFor(null),
				unsignedWebhook: false,
			})
		}
	}

	return { ok: true, planned }
}

const triggerKindLabels: Record<EnablementTriggerKind, string> = {
	cron: 'Scheduled job',
	subscription: 'Subscription',
	webhook: 'Webhook',
}

export function buildEnablementNotice(input: {
	orgSlug: string | null
	items: ReadonlyArray<PlannedEnablement>
}) {
	const org = input.orgSlug ? `@${input.orgSlug}` : 'your organization'
	const lines = input.items.map((item) => {
		const pkg = item.packageName ? ` (${item.packageName})` : ''
		return `- ${triggerKindLabels[item.triggerKind]}: ${item.triggerName}${pkg}`
	})
	return {
		subject: `Kody: automations in ${org} will run as you`,
		text: [
			`Kody is changing how automations run in ${org}.`,
			'',
			"Today, scheduled jobs, webhooks and subscriptions in an organization run with the authority of the organization itself. Soon each one runs as one real member, its enabler, and only with that member's access.",
			'',
			'You will be the enabler of these automations:',
			...lines,
			'',
			'What changes for you:',
			'- Each run acts as you. It can only use organization credentials and resources you have Use on.',
			'- Usage from these runs is billed and audited to you instead of the organization.',
			'- If you lose access (for example, you leave the organization or a credential is no longer shared with you), the automation pauses and resumes by itself when access returns.',
			'- Webhooks now always verify request signatures.',
			'',
			'Nothing else changes, and nothing stops running. To turn one off, ask your agent to list your enablements and disable the ones you do not want.',
			'',
			'Reply to this email if you have questions.',
		].join('\n'),
	}
}

function emptyTotals(): EnablementBackfillReport['totals'] {
	return {
		orgsScanned: 0,
		orgsByOutcome: { planned: 0, notified: 0, migrated: 0, skipped: 0 },
		teamOrgs: 0,
		enablementsByKind: { cron: 0, subscription: 0, webhook: 0 },
		unsignedWebhooks: 0,
		distinctEnablers: 0,
		noticesSent: 0,
	}
}

function groupByEnabler(planned: ReadonlyArray<PlannedEnablement>) {
	const byEnabler = new Map<string, Array<PlannedEnablement>>()
	for (const item of planned) {
		const list = byEnabler.get(item.enablerUserId) ?? []
		list.push(item)
		byEnabler.set(item.enablerUserId, list)
	}
	return byEnabler
}

async function applyOrgPlan(input: {
	db: D1Database
	orgId: string
	planned: ReadonlyArray<PlannedEnablement>
	deps: Pick<EnablementBackfillDeps, 'mintWebhookSigningSecret'>
	now: string
}) {
	for (const item of input.planned) {
		if (item.triggerKind === 'webhook' && item.unsignedWebhook) {
			await input.deps.mintWebhookSigningSecret({
				orgId: input.orgId,
				endpointId: item.instanceId,
			})
		}
	}
	const inserts = input.planned.map(
		(item) =>
			buildInsertEnablementStatement({
				db: input.db,
				enablement: {
					orgId: input.orgId,
					packageId: item.packageId,
					triggerKind: item.triggerKind,
					triggerName: item.triggerName,
					instanceId: item.instanceId,
					enablerUserId: item.enablerUserId,
					origin: 'migrated',
				},
				now: input.now,
			}).statement,
	)
	const markMigrated = buildMarkEnablementOrgMigratedStatement({
		db: input.db,
		orgId: input.orgId,
		now: input.now,
	})
	const chunks = chunkArray(inserts, 50)
	if (chunks.length === 0) {
		await markMigrated.run()
		return
	}
	// The org flips to migrated in the same batch as its last inserts, so a
	// failed batch leaves it legacy and a rerun skips rows already written.
	for (const [index, chunk] of chunks.entries()) {
		await input.db.batch(
			index === chunks.length - 1 ? [...chunk, markMigrated] : chunk,
		)
	}
}

/**
 * One page of the auto-enable step over orgs not yet migrated, in org id
 * order. `dry-run` writes nothing. `notify` emails team-org members and marks
 * those orgs notified. `apply` writes enablements and marks orgs migrated.
 */
export async function runEnablementBackfill(input: {
	db: D1Database
	mode: EnablementBackfillMode
	deps: EnablementBackfillDeps
	cursor?: string | null
	orgIds?: ReadonlyArray<string>
	limit?: number
	now?: () => string
}): Promise<EnablementBackfillReport> {
	const limit = Math.max(1, Math.min(input.limit ?? 25, 200))
	const now = input.now ?? (() => new Date().toISOString())
	const pending = await listPendingEnablementOrgMigrations({
		db: input.db,
		afterOrgId: input.cursor ?? null,
		orgIds: input.orgIds,
		limit,
	})
	const totals = emptyTotals()
	const enablers = new Set<string>()
	const orgs: Array<OrgBackfillReport> = []
	for (const migration of pending) {
		totals.orgsScanned += 1
		const report: OrgBackfillReport = {
			orgId: migration.orgId,
			orgSlug: null,
			teamOrg: false,
			stateBefore: migration.state,
			outcome: 'skipped',
			skipReason: null,
			planned: [],
			notices: [],
		}
		orgs.push(report)
		const org = await loadOrg(input.db, migration.orgId)
		if (!org) {
			report.skipReason = 'org_missing'
			totals.orgsByOutcome.skipped += 1
			continue
		}
		report.orgSlug = org.slug
		report.teamOrg = org.teamOrg
		if (org.teamOrg) totals.teamOrgs += 1
		const plan = await planOrgEnablements({
			db: input.db,
			orgId: migration.orgId,
			deps: input.deps,
		})
		if (!plan.ok) {
			report.skipReason = plan.reason
			totals.orgsByOutcome.skipped += 1
			continue
		}
		report.planned = plan.planned
		const byEnabler = groupByEnabler(plan.planned)
		if (org.teamOrg) {
			const emails = await loadMemberEmails(input.db, [...byEnabler.keys()])
			report.notices = [...byEnabler.entries()].map(
				([enablerUserId, items]) => {
					const email = emails.get(enablerUserId) ?? null
					return {
						enablerUserId,
						recipient: email ? redactEmailRecipient(email) : null,
						itemCount: items.length,
					}
				},
			)
		}

		switch (input.mode) {
			case 'dry-run':
				report.outcome = 'planned'
				break
			case 'notify': {
				if (!org.teamOrg || migration.state !== 'legacy') {
					report.outcome = 'planned'
					break
				}
				const emails = await loadMemberEmails(input.db, [...byEnabler.keys()])
				for (const [enablerUserId, items] of byEnabler) {
					const to = emails.get(enablerUserId)
					if (!to) continue
					const notice = buildEnablementNotice({ orgSlug: org.slug, items })
					await input.deps.sendNotice({ to, ...notice })
					totals.noticesSent += 1
				}
				await markEnablementOrgNotified({
					db: input.db,
					orgId: migration.orgId,
					now: now(),
				})
				report.outcome = 'notified'
				break
			}
			case 'apply': {
				if (org.teamOrg && migration.state !== 'notified') {
					report.skipReason = 'notice_required'
					report.outcome = 'skipped'
					break
				}
				await applyOrgPlan({
					db: input.db,
					orgId: migration.orgId,
					planned: plan.planned,
					deps: input.deps,
					now: now(),
				})
				report.outcome = 'migrated'
				break
			}
			default: {
				const exhaustive: never = input.mode
				throw new Error(`Unhandled backfill mode: ${String(exhaustive)}`)
			}
		}
		totals.orgsByOutcome[report.outcome] += 1
		if (report.outcome === 'skipped') continue
		for (const item of plan.planned) {
			totals.enablementsByKind[item.triggerKind] += 1
			if (item.unsignedWebhook) totals.unsignedWebhooks += 1
			enablers.add(item.enablerUserId)
		}
	}
	totals.distinctEnablers = enablers.size
	return {
		mode: input.mode,
		orgs,
		nextCursor:
			pending.length === limit && !input.orgIds?.length
				? (pending.at(-1)?.orgId ?? null)
				: null,
		totals,
	}
}
