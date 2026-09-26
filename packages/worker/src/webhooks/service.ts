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
import {
	isWebhookPreviousUrlLive,
	webhookIdempotencyKeyHeader,
	webhookMaxPayloadBytes,
	type WebhookEndpointRecord,
} from './types.ts'

import { utf8ByteLength } from '@kody-internal/shared/backup-restore-safety.ts'
import { readPreExecutionPackageInvocationInfrastructureCode } from '#worker/package-invocations/infrastructure-codes.ts'
import {
	dispatchWebhookInvocation,
	readWebhookInvocationResult,
	recordWebhookDelivery,
} from './delivery.ts'
import { collectSafeWebhookHeaders } from './headers.ts'
import {
	buildWebhookExportParams,
	resolveWebhookParamsModeFirstArg,
} from './params.ts'
import {
	buildFreshSyntheticWebhookIdempotencyKey,
	buildWebhookInputModeMismatchMessage,
	buildWebhookNotMintedMessage,
	stripUntrustedWebhookSyntheticFields,
} from './synthetic.ts'

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
	challenge: PackageWebhookManifestEntry['challenge']
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
	/** ISO timestamp while the previous URL still accepts deliveries. */
	previousUrlActiveUntil: string | null
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
	previousUrlActiveUntil: string | null
}

export type {
	WebhookUrlApplyDestination,
	WebhookUrlApplyHttpDestination,
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
				challenge: webhook.challenge,
				minted: mint !== undefined,
				handle: mint ? formatWebhookUrlHandle(mint.id) : null,
				urlHost: mint ? urlHost : null,
				enabled: mint?.enabled ?? null,
				urlRecoverable: mint?.urlSecretEncrypted != null,
				createdAt: mint?.createdAt ?? null,
				rotatedAt: mint?.rotatedAt ?? null,
				previousUrlActiveUntil:
					mint && isWebhookPreviousUrlLive(mint)
						? mint.previousUrlSecretExpiresAt
						: null,
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
		previousUrlActiveUntil: isWebhookPreviousUrlLive(stored)
			? stored.previousUrlSecretExpiresAt
			: null,
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
 * Owner-only reveal for the signed-in package settings UI (the Webhooks
 * section of `/@:username/:kodyId/settings`). The credential URL is the human
 * path: do not expose this through MCP or execute, and do not return it from
 * mint / rotate / list capabilities.
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

export type SyntheticWebhookRequestFixture = {
	method?: string
	headers?: Record<string, string>
	body?: string
	json?: unknown
	contentType?: string
}

export type SyntheticWebhookDispatchResult = {
	packageId: string
	packageKodyId: string
	webhookName: string
	inputMode: 'request' | 'params'
	synthetic: true
	status: number
	runId: string
	idempotencyKey: string
	result?: unknown
	error?: { code: string; message: string }
}

/**
 * Interactive-MCP synthetic smoke test for one minted package webhook.
 * Skips public URL + HMAC, invokes the bound export with a caller fixture,
 * marks the Activity webhook run `synthetic: true`, and burns automation
 * usage through the normal `internal:webhook:` invocation token.
 */
export async function dispatchSyntheticWebhookForUser(input: {
	env: Env
	userId: string
	baseUrl: string
	packageId?: string
	kodyId?: string
	webhookName: string
	request?: SyntheticWebhookRequestFixture
	params?: Record<string, unknown>
}): Promise<SyntheticWebhookDispatchResult> {
	const webhookName = input.webhookName.trim()
	if (!webhookName) throw new McpCallerError('webhookName is required.')

	const hasRequest = input.request !== undefined
	const hasParams = input.params !== undefined
	if (hasRequest === hasParams) {
		throw new McpCallerError(
			'Provide exactly one of `request` (inputMode request) or `params` (inputMode params).',
		)
	}

	const savedPackage = await resolveOwnedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
	})
	const declared = await loadDeclaredWebhook({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		savedPackage,
		webhookName,
	})
	const endpoint = await getWebhookEndpointByKey({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: savedPackage.id,
		webhookName,
	})
	if (!endpoint) {
		throw new McpCallerError(
			buildWebhookNotMintedMessage({
				kodyId: savedPackage.kodyId,
				webhookName,
			}),
		)
	}

	const providedMode: 'request' | 'params' = hasParams ? 'params' : 'request'
	if (declared.inputMode !== providedMode) {
		throw new McpCallerError(
			buildWebhookInputModeMismatchMessage({
				webhookName,
				inputMode: declared.inputMode,
				provided: providedMode,
			}),
		)
	}

	const startedAt = new Date().toISOString()
	const invocationId = crypto.randomUUID()
	const idempotencyKey = buildFreshSyntheticWebhookIdempotencyKey()

	let exportParams: Record<string, unknown>
	let payloadBytes: number

	if (declared.inputMode === 'params') {
		const resolved = resolveWebhookParamsModeFirstArg(input.params)
		if (!resolved.ok) {
			throw new McpCallerError(
				'params fixture must be a JSON object for inputMode "params".',
			)
		}
		exportParams = {
			...stripUntrustedWebhookSyntheticFields(resolved.params),
			synthetic: true,
		}
		payloadBytes = utf8ByteLength(JSON.stringify(exportParams) ?? '{}')
	} else {
		const fixture = input.request ?? {}
		const headers = new Headers()
		try {
			for (const [name, value] of Object.entries(fixture.headers ?? {})) {
				if (typeof value === 'string') headers.set(name, value)
			}
			if (fixture.contentType) {
				headers.set('content-type', fixture.contentType)
			}
		} catch (error) {
			throw new McpCallerError(
				`Invalid request fixture header: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		let bodyText: string
		if (typeof fixture.body === 'string') {
			bodyText = fixture.body
		} else if (fixture.json !== undefined) {
			bodyText = JSON.stringify(fixture.json)
			if (!headers.has('content-type')) {
				headers.set('content-type', 'application/json')
			}
		} else {
			bodyText = ''
		}
		payloadBytes = utf8ByteLength(bodyText)
		if (payloadBytes > webhookMaxPayloadBytes) {
			throw new McpCallerError(
				`Fixture exceeds the ${String(webhookMaxPayloadBytes)}-byte webhook payload limit (${String(payloadBytes)} bytes).`,
			)
		}
		const method = (fixture.method ?? 'POST').toUpperCase()
		let request: Request
		try {
			request = new Request('https://kody.synthetic/webhook', {
				method,
				headers,
				body: method === 'GET' || method === 'HEAD' ? undefined : bodyText,
			})
		} catch (error) {
			throw new McpCallerError(
				`Invalid request fixture method: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		const extraAllowedHeaders = [
			...(declared.verification ? [declared.verification.header] : []),
			...(declared.replay?.timestampHeader
				? [declared.replay.timestampHeader]
				: []),
			...(declared.replay?.deliveryIdHeader
				? [declared.replay.deliveryIdHeader]
				: []),
			webhookIdempotencyKeyHeader,
		]
		const safeHeaders = collectSafeWebhookHeaders(request, extraAllowedHeaders)
		const requestParams = buildWebhookExportParams({
			packageKodyId: savedPackage.kodyId,
			webhookName,
			request,
			bodyText,
			receivedAt: startedAt,
			headers: safeHeaders,
		})
		exportParams = {
			...requestParams,
			synthetic: true,
		}
	}

	if (payloadBytes > webhookMaxPayloadBytes) {
		throw new McpCallerError(
			`Fixture exceeds the ${String(webhookMaxPayloadBytes)}-byte webhook payload limit (${String(payloadBytes)} bytes).`,
		)
	}

	const finish = async (inputFinish: {
		status: number
		outcome: 'delivered' | 'failed'
		error?: string | null
		result?: unknown
		errorBody?: { code: string; message: string }
	}): Promise<SyntheticWebhookDispatchResult> => {
		const record = await recordWebhookDelivery({
			env: input.env,
			endpoint,
			kodyId: savedPackage.kodyId,
			outcome: inputFinish.outcome,
			httpStatus:
				inputFinish.outcome === 'delivered' ? inputFinish.status : 502,
			error: inputFinish.error ?? null,
			payloadBytes,
			invocationId,
			result: inputFinish.result,
			startedAt,
			requirePersistence: true,
			synthetic: true,
		})
		if (!record) {
			throw new Error('Webhook synthetic delivery record was not persisted.')
		}
		return {
			packageId: savedPackage.id,
			packageKodyId: savedPackage.kodyId,
			webhookName,
			inputMode: declared.inputMode,
			synthetic: true,
			status: inputFinish.status,
			runId: record.id,
			idempotencyKey,
			...(inputFinish.outcome === 'delivered'
				? { result: inputFinish.result }
				: {
						error: inputFinish.errorBody ?? {
							code: 'invocation_failed',
							message:
								inputFinish.error ??
								`Webhook export invocation failed with HTTP ${inputFinish.status}.`,
						},
					}),
		}
	}

	let response: Awaited<ReturnType<typeof dispatchWebhookInvocation>>
	try {
		response = await dispatchWebhookInvocation({
			env: input.env,
			baseUrl: input.baseUrl,
			endpoint,
			packageKodyId: savedPackage.kodyId,
			exportName: declared.exportName,
			params: exportParams,
			idempotencyKey,
		})
		const retryableCode =
			readPreExecutionPackageInvocationInfrastructureCode(response)
		if (retryableCode) {
			throw new Error(
				`Retryable package invocation infrastructure response: ${retryableCode}.`,
			)
		}
	} catch (error) {
		if (error instanceof McpCallerError) throw error
		const message = error instanceof Error ? error.message : 'invocation_failed'
		return await finish({
			status: 502,
			outcome: 'failed',
			error: message,
			errorBody: {
				code: 'invocation_failed',
				message,
			},
		})
	}

	const ok = response.status >= 200 && response.status < 300
	const result = readWebhookInvocationResult(response.body)
	if (ok) {
		return await finish({
			status: response.status,
			outcome: 'delivered',
			result,
		})
	}
	const errorRecord =
		response.body && typeof response.body === 'object'
			? ((response.body as Record<string, unknown>)['error'] as
					| Record<string, unknown>
					| undefined)
			: undefined
	return await finish({
		status: response.status,
		outcome: 'failed',
		error: `invocation_status_${response.status}`,
		result,
		errorBody: {
			code: String(errorRecord?.['code'] ?? 'invocation_failed'),
			message: String(
				errorRecord?.['message'] ??
					`Webhook export invocation failed with HTTP ${response.status}.`,
			),
		},
	})
}
