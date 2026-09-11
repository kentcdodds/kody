import { McpCallerError } from '#mcp/caller-error.ts'
import {
	decryptWebhookUrlSecret,
	encryptWebhookUrlSecret,
	userWebhookUrlSecretContext,
} from '#mcp/secrets/crypto.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { getUniqueConstraintField } from '#worker/database-errors.ts'
import { resolvePublicUsername } from '#worker/identity/user-lookup.ts'
import {
	listPackageWebhooks,
	type PackageWebhookManifestEntry,
} from '#worker/package-registry/manifest.ts'
import { resolveSavedPackage } from '#worker/package-invocations/module-artifacts.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	dispatchWebhookUrlApply,
	type WebhookUrlApplyDestination,
	type WebhookUrlApplyResult,
} from './apply.ts'
import {
	generateWebhookUrlSecret,
	hashWebhookUrlSecret,
	webhookUrlSecretMatches,
} from './crypto.ts'
import { WebhookEndpointIdRaceError } from './errors.ts'
import {
	formatWebhookUrlHandle,
	parseWebhookUrlHandle,
	webhookUrlHostFromOrigin,
} from './handle.ts'
import { buildWebhookEndpointUrl } from './public-url.ts'
import {
	getWebhookEndpointByIdForUser,
	getWebhookEndpointByKey,
	listWebhookEndpointsForUser,
	setWebhookEndpointEnabled,
	upsertWebhookEndpointSecret,
} from './repo.ts'
import { type WebhookEndpointRecord } from './types.ts'

export type ListedWebhook = {
	packageId: string
	packageKodyId: string
	packageName: string
	name: string
	exportName: string
	description: string | null
	responseMode: 'ack' | 'sync'
	inputMode: 'request' | 'params'
	rateLimitPerMinute: number
	verification: PackageWebhookManifestEntry['verification']
	replay: PackageWebhookManifestEntry['replay']
	minted: boolean
	handle: string | null
	urlHost: string | null
	enabled: boolean | null
	/**
	 * False for mints that predate encrypted secret storage: the hash alone
	 * cannot rebuild the URL, so apply / reveal need a rotate first.
	 */
	urlRecoverable: boolean
	createdAt: string | null
	rotatedAt: string | null
}

export type MintedWebhookHandle = {
	packageId: string
	packageKodyId: string
	name: string
	handle: string
	urlHost: string
	enabled: boolean
	createdAt: string
	rotatedAt: string
}

export type {
	WebhookUrlApplyDestination,
	WebhookUrlApplyGithubDestination,
	WebhookUrlApplyResult,
} from './apply.ts'

async function resolveOwnerUsername(input: {
	db: D1Database
	email?: string | null
	username?: string | null
}) {
	if (input.username?.trim()) return input.username.trim()
	const resolved = await resolvePublicUsername({
		db: input.db,
		email: input.email,
	})
	if (!resolved) {
		throw new Error(
			'A public username is required to mint webhook endpoint URLs.',
		)
	}
	return resolved
}

async function resolveOwnedPackage(input: {
	db: D1Database
	userId: string
	packageId?: string
	kodyId?: string
}): Promise<SavedPackageRecord> {
	const packageIdOrKodyId = (input.packageId ?? input.kodyId ?? '').trim()
	if (!packageIdOrKodyId) {
		throw new McpCallerError('packageId or kodyId is required.')
	}
	const savedPackage = await resolveSavedPackage({
		db: input.db,
		userId: input.userId,
		packageIdOrKodyId,
	})
	if (!savedPackage) {
		throw new McpCallerError(
			`Saved package "${packageIdOrKodyId}" was not found for this user.`,
		)
	}
	return savedPackage
}

async function loadDeclaredWebhook(input: {
	env: Env
	baseUrl: string
	userId: string
	savedPackage: SavedPackageRecord
	webhookName: string
}): Promise<PackageWebhookManifestEntry> {
	const loaded = await loadPackageManifestBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
	})
	const declared = listPackageWebhooks(loaded.manifest).find(
		(webhook) => webhook.name === input.webhookName,
	)
	if (!declared) {
		throw new McpCallerError(
			`Package "${input.savedPackage.kodyId}" does not declare webhook "${input.webhookName}".`,
		)
	}
	return declared
}

export async function listWebhooksForUser(input: {
	env: Env
	baseUrl: string
	userId: string
	packageId?: string
	kodyId?: string
}): Promise<Array<ListedWebhook>> {
	const packages = await listSavedPackagesByUserId(input.env.APP_DB, {
		userId: input.userId,
	})
	const packageFilter = (input.packageId ?? input.kodyId ?? '').trim()
	const filteredPackages = packageFilter
		? packages.filter(
				(entry) => entry.id === packageFilter || entry.kodyId === packageFilter,
			)
		: packages

	const mintedByKey = new Map<string, WebhookEndpointRecord>()
	for (const mint of await listWebhookEndpointsForUser({
		db: input.env.APP_DB,
		userId: input.userId,
	})) {
		mintedByKey.set(`${mint.packageId}:${mint.webhookName}`, mint)
	}

	const listed: Array<ListedWebhook> = []
	const urlHost = webhookUrlHostFromOrigin(input.baseUrl)
	for (const savedPackage of filteredPackages) {
		const loaded = await loadPackageManifestBySourceId({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceId: savedPackage.sourceId,
		}).catch((error) => {
			console.warn('Failed to load package manifest for webhooks', {
				packageId: savedPackage.id,
				sourceId: savedPackage.sourceId,
				error,
			})
			return null
		})
		if (!loaded) continue
		for (const webhook of listPackageWebhooks(loaded.manifest)) {
			const mint = mintedByKey.get(`${savedPackage.id}:${webhook.name}`)
			listed.push({
				packageId: savedPackage.id,
				packageKodyId: savedPackage.kodyId,
				packageName: savedPackage.name,
				name: webhook.name,
				exportName: webhook.exportName,
				description: webhook.description,
				responseMode: webhook.responseMode,
				inputMode: webhook.inputMode,
				rateLimitPerMinute: webhook.rateLimitPerMinute,
				verification: webhook.verification,
				replay: webhook.replay,
				minted: mint !== undefined,
				handle: mint ? formatWebhookUrlHandle(mint.id) : null,
				urlHost: mint ? urlHost : null,
				enabled: mint?.enabled ?? null,
				urlRecoverable: mint?.urlSecretEncrypted != null,
				createdAt: mint?.createdAt ?? null,
				rotatedAt: mint?.rotatedAt ?? null,
			})
		}
	}

	return listed.sort(
		(left, right) =>
			left.packageKodyId.localeCompare(right.packageKodyId) ||
			left.name.localeCompare(right.name),
	)
}

export async function mintWebhookUrlForUser(input: {
	env: Env
	userId: string
	email?: string | null
	username?: string | null
	packageId?: string
	kodyId?: string
	webhookName: string
	requestUrl?: string | null
	/** When false, rotate secret without forcing enabled=true on conflict. */
	activate?: boolean
}): Promise<MintedWebhookHandle> {
	const webhookName = input.webhookName.trim()
	if (!webhookName) throw new McpCallerError('webhookName is required.')
	const activate = input.activate !== false
	const baseUrl = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const savedPackage = await resolveOwnedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
	})
	await loadDeclaredWebhook({
		env: input.env,
		baseUrl,
		userId: input.userId,
		savedPackage,
		webhookName,
	})

	const urlSecret = await generateWebhookUrlSecret()
	const urlSecretHash = await hashWebhookUrlSecret(urlSecret)
	const existing = await getWebhookEndpointByKey({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: savedPackage.id,
		webhookName,
	})
	let endpointId = existing?.id ?? crypto.randomUUID()
	let stored: WebhookEndpointRecord | null = null
	for (let attempt = 0; attempt < 2; attempt++) {
		const encrypted = await encryptWebhookUrlSecret(
			input.env,
			urlSecret,
			userWebhookUrlSecretContext(input.userId, endpointId),
		)
		try {
			stored = await upsertWebhookEndpointSecret({
				db: input.env.APP_DB,
				id: endpointId,
				userId: input.userId,
				packageId: savedPackage.id,
				webhookName,
				urlSecretHash,
				urlSecretEncrypted: encrypted,
				enabled: true,
				updateEnabledOnConflict: activate,
			})
			break
		} catch (error) {
			if (attempt > 0) throw error
			if (error instanceof WebhookEndpointIdRaceError) {
				endpointId = error.existingId
				continue
			}
			if (!getUniqueConstraintField(error)) throw error
			const raced = await getWebhookEndpointByKey({
				db: input.env.APP_DB,
				userId: input.userId,
				packageId: savedPackage.id,
				webhookName,
			})
			if (!raced) throw error
			endpointId = raced.id
		}
	}
	if (!stored) {
		throw new Error('Unable to persist webhook URL secret.')
	}

	return {
		packageId: savedPackage.id,
		packageKodyId: savedPackage.kodyId,
		name: webhookName,
		handle: formatWebhookUrlHandle(stored.id),
		urlHost: webhookUrlHostFromOrigin(baseUrl),
		enabled: stored.enabled,
		createdAt: stored.createdAt,
		rotatedAt: stored.rotatedAt,
	}
}

/** Whether a URL secret already exists for this declared webhook. */
export async function isWebhookUrlMinted(input: {
	env: Env
	userId: string
	packageId?: string
	kodyId?: string
	webhookName: string
}) {
	const webhookName = input.webhookName.trim()
	if (!webhookName) throw new McpCallerError('webhookName is required.')
	const savedPackage = await resolveOwnedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
	})
	const existing = await getWebhookEndpointByKey({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: savedPackage.id,
		webhookName,
	})
	return existing !== null
}

export async function rotateWebhookUrlForUser(input: {
	env: Env
	userId: string
	email?: string | null
	username?: string | null
	packageId?: string
	kodyId?: string
	webhookName: string
	requestUrl?: string | null
}): Promise<MintedWebhookHandle> {
	const webhookName = input.webhookName.trim()
	if (!webhookName) throw new McpCallerError('webhookName is required.')
	const savedPackage = await resolveOwnedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
	})
	const existing = await getWebhookEndpointByKey({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: savedPackage.id,
		webhookName,
	})
	if (!existing) {
		throw new McpCallerError(
			'Webhook URL has not been minted. Call webhookUrlMint first.',
		)
	}
	return mintWebhookUrlForUser({
		...input,
		activate: false,
	})
}

export async function setWebhookEnabledForUser(input: {
	env: Env
	userId: string
	packageId?: string
	kodyId?: string
	webhookName: string
	enabled: boolean
}): Promise<WebhookEndpointRecord> {
	const webhookName = input.webhookName.trim()
	if (!webhookName) throw new McpCallerError('webhookName is required.')
	const savedPackage = await resolveOwnedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
	})
	const updated = await setWebhookEndpointEnabled({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: savedPackage.id,
		webhookName,
		enabled: input.enabled,
	})
	if (!updated) {
		throw new McpCallerError(
			'Webhook URL has not been minted. Call webhookUrlMint first.',
		)
	}
	return updated
}

async function resolveMintedWebhookUrl(input: {
	env: Env
	userId: string
	email?: string | null
	username?: string | null
	handle: string
	requestUrl?: string | null
}) {
	const endpointId = parseWebhookUrlHandle(input.handle)
	if (!endpointId) {
		throw new McpCallerError('Invalid webhook URL handle.')
	}
	const endpoint = await getWebhookEndpointByIdForUser({
		db: input.env.APP_DB,
		userId: input.userId,
		endpointId,
	})
	if (!endpoint) {
		throw new McpCallerError('Webhook handle was not found for this user.')
	}
	if (!endpoint.urlSecretEncrypted) {
		throw new McpCallerError(
			'Webhook URL secret is not recoverable from this mint. Call webhookUrlRotate, then webhookUrlApply.',
		)
	}
	const urlSecret = await decryptWebhookUrlSecret(
		input.env,
		endpoint.urlSecretEncrypted,
		userWebhookUrlSecretContext(input.userId, endpoint.id),
	)
	const matches = await webhookUrlSecretMatches({
		candidate: urlSecret,
		storedHash: endpoint.urlSecretHash,
	})
	if (!matches) {
		throw new McpCallerError(
			'Webhook URL secret is inconsistent. Call webhookUrlRotate, then webhookUrlApply.',
		)
	}
	const savedPackage = await resolveOwnedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: endpoint.packageId,
	})
	const baseUrl = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const username = await resolveOwnerUsername({
		db: input.env.APP_DB,
		email: input.email,
		username: input.username,
	})
	const url = buildWebhookEndpointUrl({
		origin: baseUrl,
		username,
		packageKodyId: savedPackage.kodyId,
		webhookName: endpoint.webhookName,
		urlSecret,
	})
	return {
		endpoint,
		savedPackage,
		urlSecret,
		url,
		urlHost: webhookUrlHostFromOrigin(baseUrl),
		baseUrl,
	}
}

export async function applyWebhookUrlForUser(input: {
	env: Env
	userId: string
	email?: string | null
	username?: string | null
	handle: string
	destination: WebhookUrlApplyDestination
	requestUrl?: string | null
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<WebhookUrlApplyResult> {
	const resolved = await resolveMintedWebhookUrl(input)
	return dispatchWebhookUrlApply({
		env: input.env,
		userId: input.userId,
		userEmail: input.email,
		baseUrl: resolved.baseUrl,
		packageId: resolved.savedPackage.id,
		packageKodyId: resolved.savedPackage.kodyId,
		webhookName: resolved.endpoint.webhookName,
		savedPackage: resolved.savedPackage,
		webhookUrl: resolved.url,
		urlSecret: resolved.urlSecret,
		urlHost: resolved.urlHost,
		destination: input.destination,
		waitUntil: input.waitUntil,
	})
}

type WebhookUrlRevealTarget =
	| { handle: string }
	| { packageId?: string; kodyId?: string; webhookName: string }

async function resolveRevealHandle(input: {
	db: D1Database
	userId: string
	target: WebhookUrlRevealTarget
}) {
	if ('handle' in input.target) return input.target.handle
	const webhookName = input.target.webhookName.trim()
	if (!webhookName) throw new McpCallerError('webhookName is required.')
	const savedPackage = await resolveOwnedPackage({
		db: input.db,
		userId: input.userId,
		packageId: input.target.packageId,
		kodyId: input.target.kodyId,
	})
	const existing = await getWebhookEndpointByKey({
		db: input.db,
		userId: input.userId,
		packageId: savedPackage.id,
		webhookName,
	})
	if (!existing) {
		throw new McpCallerError('Webhook URL has not been minted yet.')
	}
	return formatWebhookUrlHandle(existing.id)
}

/**
 * Owner-only reveal for the signed-in account UI (`/account/webhooks`). The
 * credential URL is the human path: do not expose this through MCP or
 * execute, and do not return it from mint / rotate / list capabilities.
 */
export async function revealWebhookUrlForWebsite(input: {
	env: Env
	userId: string
	email?: string | null
	username?: string | null
	target: WebhookUrlRevealTarget
	requestUrl?: string | null
}) {
	const handle = await resolveRevealHandle({
		db: input.env.APP_DB,
		userId: input.userId,
		target: input.target,
	})
	const resolved = await resolveMintedWebhookUrl({ ...input, handle })
	return {
		handle: formatWebhookUrlHandle(resolved.endpoint.id),
		urlHost: resolved.urlHost,
		url: resolved.url,
	}
}
