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
	markEnablementOrgNotified,
	saveEnablementNoticePlan,
	type EnablementNoticePlan,
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
	/** Apply: some planned item is not in a notice its enabler got. */
	| 'notice_required'
	/** Notify: an enabler has no email, or a send failed; rerun notify. */
	| 'notice_incomplete'
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
	/** Disabled jobs and webhooks, and webhooks no longer declared. */
	inactive: number
	/** One entry per member a team-org notice went (or would go) to. */
	notices: Array<{
		enablerUserId: string
		recipient: string | null
		itemCount: number
		/** An earlier notice already listed every one of these items. */
		notified: boolean
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
		inactiveTriggers: number
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
	enabled: number
}

type BackfillJob = {
	id: string
	name: string
	creatorUserId: string | null
	/** Enabled and not kill-switched: it runs today. */
	active: boolean
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
			// Team jobs persist the org identity as caller; the creator is provenance.
			return rows.map((row) => ({
				id: row.record.id,
				name: row.record.name,
				creatorUserId:
					row.created_by_user_id ?? row.callerContext?.user?.userId ?? null,
				active: row.record.enabled && !row.record.killSwitchEnabled,
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

async function loadEarliestOwner(db: D1Database, orgId: string) {
	const row = await db
		.prepare(
			`SELECT m.user_id AS user_id
			 FROM org_memberships m
			 INNER JOIN users u ON u.stable_user_id = m.user_id
			 WHERE m.org_id = ? AND m.role = 'owner' AND m.deleted_at IS NULL
			   AND u.deleted_at IS NULL AND u.deleting_at IS NULL
			 ORDER BY m.created_at, m.user_id
			 LIMIT 1`,
		)
		.bind(orgId)
		.first<{ user_id: string }>()
	return row?.user_id ?? null
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
			        hmac_secret_encrypted, enabled
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

type TriggerRef = {
	triggerKind: EnablementTriggerKind
	instanceId: string
	triggerName: string
}

/** One trigger instance: a job or endpoint by id, a subscription by topic. */
function instanceKey(input: TriggerRef) {
	return input.triggerKind === 'subscription'
		? `${input.triggerKind}\u0000${input.instanceId}\u0000${input.triggerName}`
		: `${input.triggerKind}\u0000${input.instanceId}`
}

/** What a notice listed: the instance and the name the person was shown. */
export function enablementNoticeKey(input: TriggerRef) {
	return `${input.triggerKind}\u0000${input.instanceId}\u0000${input.triggerName}`
}

async function hasPublishedSource(db: D1Database, sourceId: string) {
	const row = await db
		.prepare(
			`SELECT published_commit FROM entity_sources
			 WHERE id = ? AND deleted_at IS NULL`,
		)
		.bind(sourceId)
		.first<{ published_commit: string | null }>()
	return Boolean(row?.published_commit)
}

type OrgPlan =
	| { ok: true; planned: Array<PlannedEnablement>; inactive: number }
	| { ok: false; reason: OrgBackfillSkipReason }

/** What the auto-enable step would write for one org. Reads only. */
export async function planOrgEnablements(input: {
	db: D1Database
	orgId: string
	deps: Pick<EnablementBackfillDeps, 'listJobs' | 'loadManifest'>
}): Promise<OrgPlan> {
	const earliestOwner = await loadEarliestOwner(input.db, input.orgId)
	if (!earliestOwner) return { ok: false, reason: 'no_owner' }
	const members = await loadLiveMemberIds(input.db, input.orgId)
	const enablerFor = (creator: string | null) =>
		creator && members.has(creator)
			? { enablerUserId: creator, enablerSource: 'creator' as const }
			: {
					enablerUserId: earliestOwner,
					enablerSource: 'earliest_owner' as const,
				}

	// A migrated row (even one turned off) means this step already ran for
	// the trigger; a person's own row that is off does not.
	const existing = new Set(
		(
			await listEnablementsForOrg({
				db: input.db,
				orgId: input.orgId,
				includeOff: true,
			})
		)
			.filter((row) => row.origin === 'migrated' || row.state !== 'off')
			.map(instanceKey),
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
			// Never published: none of its triggers can run today, so it holds
			// nothing to migrate. Any other failure may hide live triggers.
			if (!(await hasPublishedSource(input.db, savedPackage.sourceId))) {
				continue
			}
			console.warn('enablement-backfill-manifest-load-failed', {
				orgId: input.orgId,
				packageId: savedPackage.id,
				error,
			})
			return { ok: false, reason: 'manifest_load_failed' }
		}
	}

	const planned: Array<PlannedEnablement> = []
	let inactive = 0
	const add = (entry: PlannedEnablement) => {
		const key = instanceKey(entry)
		if (existing.has(key)) return
		existing.add(key)
		planned.push(entry)
	}

	for (const job of await input.deps.listJobs(input.orgId)) {
		if (!job.active) {
			inactive += 1
			continue
		}
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
		// Ingress answers 404 for a disabled or undeclared webhook today.
		if (!endpoint.enabled || !declared) {
			inactive += 1
			continue
		}
		add({
			triggerKind: 'webhook',
			triggerName: endpoint.webhook_name,
			instanceId: endpoint.id,
			packageId: endpoint.package_id,
			packageName: packagesById.get(endpoint.package_id)?.name ?? null,
			...enablerFor(endpoint.created_by_user_id),
			unsignedWebhook:
				!declared.verification && !endpoint.hmac_secret_encrypted,
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

	return { ok: true, planned, inactive }
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
			...(input.items.some((item) => item.unsignedWebhook)
				? [
						'- A webhook above had no signature check, so Kody generated a signing secret for it. Its sender must sign each request with that secret (X-Kody-Signature). Find the secret in the package settings, in the Webhooks section.',
					]
				: []),
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
		inactiveTriggers: 0,
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
				ignoreConflicts: true,
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

function noticeCovers(
	plan: EnablementNoticePlan,
	enablerUserId: string,
	items: ReadonlyArray<PlannedEnablement>,
) {
	const listed = new Set(plan[enablerUserId] ?? [])
	return items.every((item) => listed.has(enablementNoticeKey(item)))
}

/**
 * Email each enabler whose items no earlier notice listed, recording each
 * notice as it goes. Returns whether every enabler is now covered.
 */
async function notifyTeamOrg(input: {
	db: D1Database
	orgId: string
	orgSlug: string | null
	noticePlan: EnablementNoticePlan
	byEnabler: Map<string, Array<PlannedEnablement>>
	deps: Pick<EnablementBackfillDeps, 'sendNotice'>
	now: () => string
}): Promise<{ complete: boolean; sent: number }> {
	const plan: EnablementNoticePlan = { ...input.noticePlan }
	const emails = await loadMemberEmails(input.db, [...input.byEnabler.keys()])
	let complete = true
	let sent = 0
	for (const [enablerUserId, items] of input.byEnabler) {
		if (noticeCovers(plan, enablerUserId, items)) continue
		const to = emails.get(enablerUserId)
		if (!to) {
			complete = false
			continue
		}
		try {
			await input.deps.sendNotice({
				to,
				...buildEnablementNotice({ orgSlug: input.orgSlug, items }),
			})
		} catch (error) {
			console.error('enablement-backfill-notice-failed', {
				orgId: input.orgId,
				enablerUserId,
				error,
			})
			complete = false
			continue
		}
		sent += 1
		plan[enablerUserId] = items.map(enablementNoticeKey)
		await saveEnablementNoticePlan({
			db: input.db,
			orgId: input.orgId,
			plan,
			now: input.now(),
		})
	}
	return { complete, sent }
}

/**
 * One page of the auto-enable step over orgs not yet migrated, in org id
 * order. `dry-run` writes nothing. `notify` emails team-org members what
 * will bill them and marks the org notified once all of them were told.
 * `apply` writes enablements and marks orgs migrated; a team org migrates
 * only when every planned item was in a notice its enabler got.
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
			inactive: 0,
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
		report.inactive = plan.inactive
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
						notified: noticeCovers(migration.noticePlan, enablerUserId, items),
					}
				},
			)
		}
		const noticesComplete = [...byEnabler.entries()].every(
			([enablerUserId, items]) =>
				noticeCovers(migration.noticePlan, enablerUserId, items),
		)

		switch (input.mode) {
			case 'dry-run':
				report.outcome = 'planned'
				break
			case 'notify': {
				if (!org.teamOrg) {
					report.outcome = 'planned'
					break
				}
				const notified = await notifyTeamOrg({
					db: input.db,
					orgId: migration.orgId,
					orgSlug: org.slug,
					noticePlan: migration.noticePlan,
					byEnabler,
					deps: input.deps,
					now,
				})
				totals.noticesSent += notified.sent
				if (!notified.complete) {
					report.skipReason = 'notice_incomplete'
					report.outcome = 'skipped'
					break
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
				if (org.teamOrg && !noticesComplete) {
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
		totals.inactiveTriggers += plan.inactive
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
		// A full page may have more after it, with or without an org id filter.
		nextCursor:
			pending.length === limit ? (pending.at(-1)?.orgId ?? null) : null,
		totals,
	}
}
