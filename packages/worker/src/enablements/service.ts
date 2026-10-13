/**
 * Enablement writes from people (credentials plan v4, section 3.3). Each
 * person turns triggers on for themselves; nobody enables a trigger for
 * someone else, and publishing never turns anything on. An enabler, or an
 * Owner, can turn an enablement off.
 */
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	authorize,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { buildPackageJobId } from '#worker/jobs/package-job-id.ts'
import { resolveSavedPackage } from '#worker/package-invocations/module-artifacts.ts'
import {
	listPackageSubscriptions,
	listPackageWebhooks,
	webhookHmacVerification,
} from '#worker/package-registry/manifest.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { buildWebhookApprovalUrl } from '#worker/webhooks/approval.ts'
import {
	getWebhookEndpointByKey,
	setWebhookEndpointHmacSecret,
} from '#worker/webhooks/repo.ts'
import { mintPackageOwnedWebhookHmacCiphertext } from '#worker/webhooks/signing-secret.ts'
import {
	buildInsertEnablementStatement,
	buildInsertWebhookEnablementStatement,
	disableEnablement,
	getEnablementById,
	isWebhookOneLiveConflict,
	listEnablementsForInstance,
	listEnablementsForOrg,
} from './repo.ts'
import { type EnablementRecord, type EnablementTriggerKind } from './types.ts'

export type TriggerEnablementErrorCode =
	| 'trigger_unknown'
	| 'webhook_not_minted'
	| 'webhook_other_enabler'
	| 'webhook_approval_required'

/** A trigger the caller cannot turn on, with a code mapping surfaces can show. */
export class TriggerEnablementError extends McpCallerError {
	readonly code: TriggerEnablementErrorCode

	constructor(code: TriggerEnablementErrorCode, message: string) {
		super(message)
		this.name = 'TriggerEnablementError'
		this.code = code
	}
}

function requireActor(request: RequestContext) {
	if (!request.actor) {
		throw new McpCallerError(
			'Only a signed-in person can turn a trigger on, and it runs as them.',
		)
	}
	return request.actor
}

async function resolveOrgPackage(input: {
	db: D1Database
	request: RequestContext
	packageIdOrKodyId: string
}): Promise<SavedPackageRecord> {
	const ref = input.packageIdOrKodyId.trim()
	if (!ref) throw new McpCallerError('packageId or kodyId is required.')
	const savedPackage = await resolveSavedPackage({
		db: input.db,
		userId: input.request.org.id,
		packageIdOrKodyId: ref,
	})
	if (!savedPackage) {
		throw new McpCallerError(`Saved package "${ref}" was not found.`)
	}
	return savedPackage
}

type ResolvedTrigger = {
	instanceId: string
	triggerName: string
	/** A webhook already enabled by someone else: one enabler per endpoint. */
	webhookEnablers?: Array<EnablementRecord>
	/** A webhook URL with no signing secret whose manifest declares no HMAC scheme. */
	unsignedWebhookEndpointId?: string
}

async function resolveDeclaredTrigger(input: {
	env: Env
	baseUrl: string
	savedPackage: SavedPackageRecord
	kind: EnablementTriggerKind
	name: string
}): Promise<ResolvedTrigger> {
	const { savedPackage } = input
	const name = input.name.trim()
	if (!name) throw new McpCallerError('trigger name is required.')
	const { manifest } = await loadPackageManifestBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: savedPackage.userId,
		sourceId: savedPackage.sourceId,
	})
	const notDeclared = (where: string) =>
		new TriggerEnablementError(
			'trigger_unknown',
			`Package "${savedPackage.kodyId}" does not declare ${input.kind} "${name}" in package.json#kody.${where}.`,
		)
	switch (input.kind) {
		case 'cron': {
			if (!Object.hasOwn(manifest.kody.jobs ?? {}, name)) {
				throw notDeclared('jobs')
			}
			return {
				instanceId: buildPackageJobId(savedPackage.id, name),
				triggerName: name,
			}
		}
		case 'subscription': {
			const declared = listPackageSubscriptions(manifest).some(
				(subscription) => subscription.topic === name,
			)
			if (!declared) throw notDeclared('subscriptions')
			return { instanceId: savedPackage.id, triggerName: name }
		}
		case 'webhook': {
			const declared = listPackageWebhooks(manifest).find(
				(webhook) => webhook.name === name,
			)
			if (!declared) throw notDeclared('webhooks')
			const endpoint = await getWebhookEndpointByKey({
				db: input.env.APP_DB,
				userId: savedPackage.userId,
				packageId: savedPackage.id,
				webhookName: name,
			})
			if (!endpoint) {
				throw new TriggerEnablementError(
					'webhook_not_minted',
					`Webhook "${name}" has no URL yet. Mint one with webhookUrlMint, then approve it at the approval URL the mint returns.`,
				)
			}
			return {
				instanceId: endpoint.id,
				triggerName: name,
				webhookEnablers: await listEnablementsForInstance({
					db: input.env.APP_DB,
					orgId: savedPackage.userId,
					triggerKind: 'webhook',
					instanceId: endpoint.id,
				}),
				...(!webhookHmacVerification(declared.verification) &&
				!endpoint.hmacSecretEncrypted
					? { unsignedWebhookEndpointId: endpoint.id }
					: {}),
			}
		}
		default: {
			const exhaustive: never = input.kind
			throw new Error(`Unhandled trigger kind: ${String(exhaustive)}`)
		}
	}
}

export type DeclaredTrigger = {
	kind: EnablementTriggerKind
	name: string
	/** Job id, package id, or webhook endpoint id; null for an unminted webhook. */
	instanceId: string | null
	/** Enablements of this instance that are not off, oldest first. */
	enablements: Array<EnablementRecord>
}

/** Every trigger the package declares, with each instance's live enablements. */
export async function listDeclaredTriggers(input: {
	env: Env
	baseUrl: string
	savedPackage: SavedPackageRecord
}): Promise<Array<DeclaredTrigger>> {
	const { savedPackage } = input
	const db = input.env.APP_DB
	const orgId = savedPackage.userId
	const { manifest } = await loadPackageManifestBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: savedPackage.userId,
		sourceId: savedPackage.sourceId,
	})
	const declared: Array<Omit<DeclaredTrigger, 'enablements'>> = [
		...Object.keys(manifest.kody.jobs ?? {}).map((name) => ({
			kind: 'cron' as const,
			name,
			instanceId: buildPackageJobId(savedPackage.id, name),
		})),
		...listPackageSubscriptions(manifest).map((subscription) => ({
			kind: 'subscription' as const,
			name: subscription.topic,
			instanceId: savedPackage.id,
		})),
		...(await Promise.all(
			listPackageWebhooks(manifest).map(async (webhook) => ({
				kind: 'webhook' as const,
				name: webhook.name,
				instanceId:
					(
						await getWebhookEndpointByKey({
							db,
							userId: orgId,
							packageId: savedPackage.id,
							webhookName: webhook.name,
						})
					)?.id ?? null,
			})),
		)),
	]
	return await Promise.all(
		declared.map(async (trigger) => ({
			...trigger,
			enablements: trigger.instanceId
				? await listEnablementsForInstance({
						db,
						orgId,
						triggerKind: trigger.kind,
						instanceId: trigger.instanceId,
						...(trigger.kind === 'subscription'
							? { triggerName: trigger.name }
							: {}),
					})
				: [],
		})),
	)
}

export type NewTriggerEnablementPlan = {
	enablement: null
	kind: EnablementTriggerKind
	triggerName: string
	enablementId: string
	/**
	 * Inserts the caller's enablement; run it with `runNewEnablementPlans`
	 * (a webhook insert writes nothing when another enabler got there first).
	 */
	statement: D1PreparedStatement
	/** Side effects that must land before the insert commits. */
	prepare: () => Promise<void>
}

export type TriggerEnablementPlan =
	| { enablement: EnablementRecord }
	| NewTriggerEnablementPlan

function webhookOtherEnablerError(triggerName: string) {
	return new TriggerEnablementError(
		'webhook_other_enabler',
		`Webhook "${triggerName}" was just turned on for another person. Each webhook URL runs as one enabler.`,
	)
}

/**
 * Runs new-enablement inserts in one batch. A webhook insert that wrote
 * nothing, or hit the one-live-enablement index, lost a race with another
 * enabler: nothing of that webhook is written and the caller gets
 * `webhook_other_enabler`.
 */
export async function runNewEnablementPlans(input: {
	db: D1Database
	plans: ReadonlyArray<NewTriggerEnablementPlan>
}) {
	if (input.plans.length === 0) return
	const firstWebhook = input.plans.find((plan) => plan.kind === 'webhook')
	let results: Array<D1Result>
	try {
		results = await input.db.batch(input.plans.map((plan) => plan.statement))
	} catch (error) {
		if (firstWebhook && isWebhookOneLiveConflict(error)) {
			throw webhookOtherEnablerError(firstWebhook.triggerName)
		}
		throw error
	}
	for (const [index, plan] of input.plans.entries()) {
		if (plan.kind === 'webhook' && (results[index]?.meta.changes ?? 0) === 0) {
			throw webhookOtherEnablerError(plan.triggerName)
		}
	}
}

/**
 * What turning a declared trigger on for the caller takes, without writing
 * the enablement: the caller's existing enablement (or the webhook's), or an
 * insert to batch with related writes. The caller has already been
 * authorized for `package:execute` on `savedPackage`.
 */
export async function planTriggerEnablementForCaller(input: {
	env: Env
	baseUrl: string
	request: RequestContext
	savedPackage: SavedPackageRecord
	kind: EnablementTriggerKind
	name: string
	now?: string
}): Promise<TriggerEnablementPlan> {
	const actor = requireActor(input.request)
	const { savedPackage } = input
	const trigger = await resolveDeclaredTrigger({
		env: input.env,
		baseUrl: input.baseUrl,
		savedPackage,
		kind: input.kind,
		name: input.name,
	})
	const db = input.env.APP_DB
	const orgId = savedPackage.userId
	const [webhookEnabler] = trigger.webhookEnablers ?? []
	if (
		webhookEnabler &&
		String(webhookEnabler.enablerUserId) !== String(actor.userId)
	) {
		throw new TriggerEnablementError(
			'webhook_other_enabler',
			`Webhook "${trigger.triggerName}" is already on for another person. Each webhook URL runs as one enabler.`,
		)
	}
	// Keeps every enabled URL holding a signing secret, so requiring
	// X-Kody-Signature later would not need a re-mint. Ingress does not check it.
	const prepare = async () => {
		if (!trigger.unsignedWebhookEndpointId) return
		const { encrypted } = await mintPackageOwnedWebhookHmacCiphertext({
			env: input.env,
			userId: orgId,
			endpointId: trigger.unsignedWebhookEndpointId,
		})
		await setWebhookEndpointHmacSecret({
			db,
			userId: orgId,
			endpointId: trigger.unsignedWebhookEndpointId,
			hmacSecretEncrypted: encrypted,
		})
	}
	if (webhookEnabler) {
		await prepare()
		return { enablement: webhookEnabler }
	}
	const ownExisting = (
		await listEnablementsForInstance({
			db,
			orgId,
			triggerKind: input.kind,
			instanceId: trigger.instanceId,
			...(input.kind === 'subscription'
				? { triggerName: trigger.triggerName }
				: {}),
		})
	).find((row) => String(row.enablerUserId) === String(actor.userId))
	if (ownExisting) return { enablement: ownExisting }
	const buildInsert =
		input.kind === 'webhook'
			? buildInsertWebhookEnablementStatement
			: buildInsertEnablementStatement
	const { id, statement } = buildInsert({
		db,
		enablement: {
			orgId,
			packageId: savedPackage.id,
			triggerKind: input.kind,
			triggerName: trigger.triggerName,
			instanceId: trigger.instanceId,
			enablerUserId: actor.userId,
			origin: 'enabled',
		},
		now: input.now ?? new Date().toISOString(),
	})
	return {
		enablement: null,
		kind: input.kind,
		triggerName: trigger.triggerName,
		enablementId: id,
		statement,
		prepare,
	}
}

/**
 * Turn a declared trigger on for the caller. The caller needs
 * `package:execute` on the package, and every run then acts as them. A
 * webhook's first turn-on is refused here: a person approves it (credential
 * approval), which also reviews what it will use.
 */
export async function enableTriggerForCaller(input: {
	env: Env
	baseUrl: string
	request: RequestContext
	packageIdOrKodyId: string
	kind: EnablementTriggerKind
	name: string
}): Promise<EnablementRecord> {
	requireActor(input.request)
	const savedPackage = await resolveOrgPackage({
		db: input.env.APP_DB,
		request: input.request,
		packageIdOrKodyId: input.packageIdOrKodyId,
	})
	await authorize(
		{ env: input.env, request: input.request },
		'package:execute',
		packageResource({
			id: savedPackage.id,
			userId: savedPackage.userId,
			label: savedPackage.kodyId,
		}),
	)
	const plan = await planTriggerEnablementForCaller({
		env: input.env,
		baseUrl: input.baseUrl,
		request: input.request,
		savedPackage,
		kind: input.kind,
		name: input.name,
	})
	if (plan.enablement) return plan.enablement
	if (input.kind === 'webhook') {
		const approvalUrl = buildWebhookApprovalUrl({
			baseUrl: input.baseUrl,
			orgSlug: input.request.org.slug,
			packageKodyId: savedPackage.kodyId,
			webhookName: input.name.trim(),
		})
		throw new TriggerEnablementError(
			'webhook_approval_required',
			`Webhook "${input.name.trim()}" is not approved yet. A webhook's first turn-on needs a person to Approve it${
				approvalUrl
					? ` at ${approvalUrl}`
					: ` from package "${savedPackage.kodyId}"'s Credentials page`
			}; enablementEnable cannot do it.`,
		)
	}
	await plan.prepare()
	await runNewEnablementPlans({ db: input.env.APP_DB, plans: [plan] })
	const created = await getEnablementById({
		db: input.env.APP_DB,
		orgId: savedPackage.userId,
		id: plan.enablementId,
	})
	if (!created) throw new Error('Unable to read the new enablement.')
	return created
}

/** Turn an enablement off for good. Only its enabler or an Owner may. */
export async function disableEnablementForCaller(input: {
	env: Env
	request: RequestContext
	enablementId: string
}): Promise<EnablementRecord> {
	const actor = requireActor(input.request)
	const db = input.env.APP_DB
	const orgId = input.request.org.id
	const enablement = await getEnablementById({
		db,
		orgId,
		id: input.enablementId,
	})
	const notFound = new McpCallerError(
		`Enablement "${input.enablementId}" was not found.`,
	)
	if (!enablement) throw notFound
	if (String(enablement.enablerUserId) !== String(actor.userId)) {
		const access = await computeEffectivePermissions({
			env: input.env,
			request: input.request,
		})
		// Someone else's enablement is invisible to non-Owners.
		if (!access.isOwner) throw notFound
	}
	await disableEnablement({ db, orgId, id: enablement.id })
	const updated = await getEnablementById({ db, orgId, id: enablement.id })
	if (!updated) throw notFound
	return updated
}

/** The caller's enablements; an Owner may list the whole org's. */
export async function listEnablementsForCaller(input: {
	env: Env
	request: RequestContext
	scope: 'mine' | 'org'
	includeOff: boolean
}): Promise<Array<EnablementRecord>> {
	const actor = requireActor(input.request)
	if (input.scope === 'org') {
		const access = await computeEffectivePermissions({
			env: input.env,
			request: input.request,
		})
		if (!access.isOwner) {
			throw new McpCallerError(
				'Only an Owner can list every enablement in the org.',
			)
		}
	}
	return await listEnablementsForOrg({
		db: input.env.APP_DB,
		orgId: input.request.org.id,
		enablerUserId: input.scope === 'mine' ? actor.userId : undefined,
		includeOff: input.includeOff,
	})
}
