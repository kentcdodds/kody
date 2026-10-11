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
} from '#worker/package-registry/manifest.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	getWebhookEndpointByKey,
	setWebhookEndpointHmacSecret,
} from '#worker/webhooks/repo.ts'
import { mintPackageOwnedWebhookHmacCiphertext } from '#worker/webhooks/signing-secret.ts'
import {
	disableEnablement,
	getEnablementById,
	getEnablementOrgMigration,
	insertEnablement,
	listEnablementsForInstance,
	listEnablementsForOrg,
} from './repo.ts'
import { type EnablementRecord, type EnablementTriggerKind } from './types.ts'

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
	/** A webhook URL with no signing secret whose manifest declares no verification. */
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
		new McpCallerError(
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
				throw new McpCallerError(
					`Webhook "${name}" has no URL yet. Mint one with webhookUrlMint, which also turns it on for you.`,
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
				...(!declared.verification && !endpoint.hmacSecretEncrypted
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

/**
 * Turn a declared trigger on for the caller. The caller needs
 * `package:execute` on the package, and every run then acts as them.
 */
export async function enableTriggerForCaller(input: {
	env: Env
	baseUrl: string
	request: RequestContext
	packageIdOrKodyId: string
	kind: EnablementTriggerKind
	name: string
}): Promise<EnablementRecord> {
	const actor = requireActor(input.request)
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
		throw new McpCallerError(
			`Webhook "${trigger.triggerName}" is already on for another person. Each webhook URL runs as one enabler.`,
		)
	}
	// A migrated org checks X-Kody-Signature on unsigned webhooks, so a URL
	// that never got a signing secret (disabled at migration) gets one now.
	if (
		trigger.unsignedWebhookEndpointId &&
		(await getEnablementOrgMigration({ db, orgId })).state === 'migrated'
	) {
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
	if (webhookEnabler) return webhookEnabler
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
	if (ownExisting) return ownExisting
	return await insertEnablement({
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
	})
}

/**
 * Minting a webhook URL turns it on for the minter in an org moved to
 * enablements, unless it already has an enabler. A minter without
 * `package:execute` gets the URL and no enablement.
 */
export async function ensureWebhookEnablementForMinter(input: {
	env: Env
	request: RequestContext
	savedPackage: SavedPackageRecord
	endpointId: string
	webhookName: string
}): Promise<EnablementRecord | null> {
	const actor = input.request.actor
	if (!actor) return null
	const db = input.env.APP_DB
	const orgId = input.savedPackage.userId
	const migration = await getEnablementOrgMigration({ db, orgId })
	if (migration.state !== 'migrated') return null
	const [existing] = await listEnablementsForInstance({
		db,
		orgId,
		triggerKind: 'webhook',
		instanceId: input.endpointId,
	})
	if (existing) return existing
	try {
		await authorize(
			{ env: input.env, request: input.request },
			'package:execute',
			packageResource({
				id: input.savedPackage.id,
				userId: input.savedPackage.userId,
			}),
		)
	} catch {
		return null
	}
	return await insertEnablement({
		db,
		enablement: {
			orgId,
			packageId: input.savedPackage.id,
			triggerKind: 'webhook',
			triggerName: input.webhookName,
			instanceId: input.endpointId,
			enablerUserId: actor.userId,
			origin: 'enabled',
		},
	})
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
