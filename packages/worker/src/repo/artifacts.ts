import {
	CloudflareApiError,
	createCloudflareRestClient,
} from '#mcp/cloudflare/cloudflare-rest-client.ts'
import { type EntityKind } from './types.ts'

export type ArtifactToken = {
	id: string
	plaintext: string
	scope: string
	expiresAt: string
}

export type ArtifactRepoInfo = {
	id: string
	name: string
	description: string | null
	defaultBranch: string
	createdAt: string
	updatedAt: string
	lastPushAt: string | null
	source: string | null
	readOnly: boolean
	remote: string
}

export type ArtifactRepoHandle = {
	info(): Promise<ArtifactRepoInfo | null>
	createToken(scope?: 'write' | 'read', ttl?: number): Promise<ArtifactToken>
	fork(target: {
		name: string
		readOnly?: boolean
	}): Promise<{
		id: string
		name: string
		description: string | null
		defaultBranch: string
		remote: string
		token: string
		expiresAt: string | null
		repo: ArtifactRepoHandle
	}>
}

export type ArtifactGetRepoResult =
	| { status: 'ready'; repo: ArtifactRepoHandle }
	| { status: 'not_found' }
	| { status: 'importing'; retryAfter: number }
	| { status: 'forking'; retryAfter: number }

export type ArtifactNamespaceBinding = {
	create(
		name: string,
		opts?: {
			description?: string
			readOnly?: boolean
			setDefaultBranch?: string
		},
	): Promise<{
		id: string
		name: string
		description: string | null
		defaultBranch: string
		remote: string
		token: string
		expiresAt: string | null
	}>
	get(name: string): Promise<ArtifactGetRepoResult>
	list(opts?: { limit?: number; cursor?: string }): Promise<{
		repos: Array<Omit<ArtifactRepoInfo, 'remote'>>
		total: number
		cursor?: string
	}>
}

export function getArtifactsBinding(
	env: Env,
	namespaceOverride?: string | null,
): ArtifactNamespaceBinding & Record<string, unknown> {
	const restBinding = createArtifactsRestBinding(env, namespaceOverride)
	if (!restBinding) {
		throw new Error(
			'Cloudflare Artifacts REST access requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.',
		)
	}
	return restBinding
}

export function hasArtifactsAccess(env: Env) {
	try {
		void getArtifactsBinding(env)
		return true
	} catch {
		return false
	}
}

export function getArtifactsNamespace(env: Env) {
	const namespace = (
		env as Env & { ARTIFACTS_NAMESPACE?: string | undefined }
	).ARTIFACTS_NAMESPACE?.trim()
	return namespace || 'default'
}

type ArtifactApiEnvelope<T> = {
	result: T | null
	success: boolean
	errors: Array<{
		code: number
		message: string
	}>
	messages: Array<{
		code: number
		message: string
	}>
	result_info?: {
		cursor?: string
		count?: number
		total_count?: number
	}
}

type ArtifactRestRepoInfo = {
	id: string
	name: string
	description: string | null
	default_branch: string
	created_at: string
	updated_at: string
	last_push_at: string | null
	source: string | null
	read_only: boolean
	remote: string
}

type ArtifactRestCreateRepoResult = {
	id: string
	name: string
	description: string | null
	default_branch: string
	remote: string
	token: string
}

type ArtifactRestCreateTokenResult = {
	id: string
	plaintext: string
	scope: string
	expires_at: string
}

type ArtifactRestForkRepoResult = ArtifactRestCreateRepoResult & {
	objects?: number
}

type ArtifactPendingRepoResponse = {
	status: 'importing' | 'forking'
	retryAfter: number
}

type ArtifactPendingStatusPayload = {
	status?: string
	retry_after?: number
	retryAfter?: number
}

type ArtifactEnvelopeResponse<T> = {
	status: number
	headers: Headers
	envelope: ArtifactApiEnvelope<T>
}

const defaultArtifactRetryAfterSeconds = 2
const maxArtifactRetryAfterSeconds = 2

function createArtifactsRestBinding(env: Env, namespaceOverride?: string | null) {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
	if (!accountId || !apiToken) {
		return null
	}
	const client = createCloudflareRestClient(env)
	const namespace = namespaceOverride?.trim() || getArtifactsNamespace(env)
	const basePath = `/client/v4/accounts/${accountId}/artifacts/namespaces/${namespace}`
	const getRepo = async (name: string): Promise<ArtifactGetRepoResult> => {
		const response = await requestArtifactsEnvelope<ArtifactRestRepoInfo>(client, {
			method: 'GET',
			path: `${basePath}/repos/${encodeURIComponent(name)}`,
			treat404AsNull: true,
		})
		const pending = parsePendingArtifactRepoResponse(response)
		if (pending) {
			return pending
		}
		if (response.status === 404 || response.envelope.result == null) {
			return { status: 'not_found' as const }
		}
		return {
			status: 'ready' as const,
			repo: repoHandle(name),
		}
	}
	const getRepoInfo = async (name: string): Promise<ArtifactRepoInfo | null> => {
		const response = await requestArtifactsEnvelope<ArtifactRestRepoInfo>(client, {
			method: 'GET',
			path: `${basePath}/repos/${encodeURIComponent(name)}`,
			treat404AsNull: true,
		})
		if (response.status === 202 || response.status === 404) {
			return null
		}
		return response.envelope.result
			? normalizeArtifactRepoInfo(response.envelope.result)
			: null
	}
	const repoHandle = (name: string): ArtifactRepoHandle => ({
		info: async () => await getRepoInfo(name),
		createToken: async (scope = 'write', ttl = 3600) => {
			const result = await requestArtifactsApi<ArtifactRestCreateTokenResult>(
				client,
				{
					method: 'POST',
					path: `${basePath}/tokens`,
					body: {
						repo: name,
						scope,
						ttl,
					},
				},
			)
			return {
				id: result.id,
				plaintext: result.plaintext,
				scope: result.scope,
				expiresAt: result.expires_at,
			}
		},
		fork: async (target) => {
			const result = await requestArtifactsApi<ArtifactRestForkRepoResult>(
				client,
				{
					method: 'POST',
					path: `${basePath}/repos/${encodeURIComponent(name)}/fork`,
					body: {
						name: target.name,
						read_only: target.readOnly ?? false,
					},
				},
			)
			return {
				id: result.id,
				name: result.name,
				description: result.description,
				defaultBranch: result.default_branch,
				remote: result.remote,
				token: result.token,
				expiresAt: parseArtifactTokenExpiry(result.token),
				repo: repoHandle(result.name),
			}
		},
	})
	return {
		create: async (name, opts) => {
			const result = await requestArtifactsApi<ArtifactRestCreateRepoResult>(
				client,
				{
					method: 'POST',
					path: `${basePath}/repos`,
					body: {
						name,
						...(opts?.description ? { description: opts.description } : {}),
						...(opts?.setDefaultBranch
							? { default_branch: opts.setDefaultBranch }
							: {}),
						...(opts?.readOnly !== undefined
							? { read_only: opts.readOnly }
							: {}),
					},
				},
			)
			return {
				id: result.id,
				name: result.name,
				description: result.description,
				defaultBranch: result.default_branch,
				remote: result.remote,
				token: result.token,
				expiresAt: parseArtifactTokenExpiry(result.token),
			}
		},
		get: getRepo,
		list: async (opts) => {
			const query: Record<string, string> = {}
			if (opts?.limit !== undefined) {
				query['limit'] = String(opts.limit)
			}
			if (opts?.cursor) {
				query['cursor'] = opts.cursor
			}
			const envelope = await requestArtifactsEnvelope<Array<ArtifactRestRepoInfo>>(
				client,
				{
					method: 'GET',
					path: `${basePath}/repos`,
					query,
				},
			)
			const repos = (envelope.envelope.result ?? []).map((repo) => {
				const normalized = normalizeArtifactRepoInfo(repo)
				return {
					id: normalized.id,
					name: normalized.name,
					description: normalized.description,
					defaultBranch: normalized.defaultBranch,
					createdAt: normalized.createdAt,
					updatedAt: normalized.updatedAt,
					lastPushAt: normalized.lastPushAt,
					source: normalized.source,
					readOnly: normalized.readOnly,
				}
			})
			return {
				repos,
				total: envelope.envelope.result_info?.total_count ?? repos.length,
				cursor: envelope.envelope.result_info?.cursor,
			}
		},
	} satisfies ArtifactNamespaceBinding & Record<string, unknown>
}

async function requestArtifactsApi<T>(
	client: ReturnType<typeof createCloudflareRestClient>,
	input: {
		method: 'GET' | 'POST' | 'DELETE'
		path: string
		query?: Record<string, string>
		body?: unknown
		treat404AsNull?: boolean
	},
) {
	const envelope = await requestArtifactsEnvelope<T>(client, input)
	if (envelope.envelope.result == null) {
		throw new Error(`Artifacts API returned no result for ${input.path}.`)
	}
	return envelope.envelope.result
}

async function requestArtifactsEnvelope<T>(
	client: ReturnType<typeof createCloudflareRestClient>,
	input: {
		method: 'GET' | 'POST' | 'DELETE'
		path: string
		query?: Record<string, string>
		body?: unknown
		treat404AsNull?: boolean
	},
): Promise<ArtifactEnvelopeResponse<T>> {
	try {
		const response = await client.rawRequest({
			method: input.method,
			path: input.path,
			query: input.query,
			body: input.body,
		})
		const envelope = response.body as ArtifactApiEnvelope<T> | null
		if (input.treat404AsNull && response.status === 404) {
			return {
				status: response.status,
				headers: response.headers,
				envelope: {
					result: null,
					success: true,
					errors: [],
					messages: [],
				} satisfies ArtifactApiEnvelope<T>,
			}
		}
		if (response.status === 202) {
			return {
				status: response.status,
				headers: response.headers,
				envelope:
					envelope ??
					({
						result: null,
						success: true,
						errors: [],
						messages: [],
					} satisfies ArtifactApiEnvelope<T>),
			}
		}
		if (!envelope?.success) {
			const message =
				envelope?.errors?.[0]?.message ??
				`Artifacts API request failed (${response.status}).`
			throw new Error(message)
		}
		return {
			status: response.status,
			headers: response.headers,
			envelope,
		}
	} catch (error) {
		if (
			input.treat404AsNull &&
			error instanceof CloudflareApiError &&
			error.status === 404
		) {
			return {
				status: 404,
				headers: new Headers(),
				envelope: {
					result: null,
					success: true,
					errors: [],
					messages: [],
				} satisfies ArtifactApiEnvelope<T>,
			}
		}
		throw error
	}
}

function normalizeArtifactRepoInfo(repo: ArtifactRestRepoInfo): ArtifactRepoInfo {
	return {
		id: repo.id,
		name: repo.name,
		description: repo.description,
		defaultBranch: repo.default_branch,
		createdAt: repo.created_at,
		updatedAt: repo.updated_at,
		lastPushAt: repo.last_push_at,
		source: repo.source,
		readOnly: repo.read_only,
		remote: repo.remote,
	}
}

function parseArtifactTokenExpiry(token: string) {
	const expiresAtSeconds = Number.parseInt(
		new URLSearchParams(token.split('?')[1] ?? '').get('expires') ?? '',
		10,
	)
	if (Number.isFinite(expiresAtSeconds)) {
		return new Date(expiresAtSeconds * 1000).toISOString()
	}
	return null
}

function normalizeRepoNamePart(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
}

function trimRepoName(value: string) {
	return value.slice(0, 63).replace(/-+$/g, '')
}

export function buildEntityRepoId(input: {
	entityKind: EntityKind
	entityId: string
}) {
	return trimRepoName(
		normalizeRepoNamePart(`${input.entityKind}-${input.entityId}`),
	)
}

export function buildSessionRepoId(input: {
	entityKind: EntityKind
	entityId: string
	sessionId: string
}) {
	return trimRepoName(
		normalizeRepoNamePart(
			`${input.entityKind}-${input.entityId}-session-${input.sessionId}`,
		),
	)
}

export function parseArtifactTokenSecret(token: string) {
	return token.split('?')[0] ?? token
}

export function buildAuthenticatedArtifactsRemote(input: {
	remote: string
	token: string
}) {
	const tokenSecret = parseArtifactTokenSecret(input.token)
	const remoteUrl = new URL(input.remote)
	if (remoteUrl.protocol !== 'https:') {
		throw new Error(`Artifact remote must use https://, got: ${input.remote}`)
	}
	remoteUrl.username = 'x'
	remoteUrl.password = tokenSecret
	return remoteUrl.toString()
}

export async function resolveArtifactSourceRepo(env: Env, repoId: string) {
	const binding = getArtifactsBinding(env)
	return await waitForArtifactRepoReady(binding, repoId)
}

export async function resolveSessionRepo(
	env: Env,
	input: { namespace?: string | null; name: string },
) {
	const binding = getArtifactsBinding(env, input.namespace)
	return await waitForArtifactRepoReady(binding, input.name)
}

export async function waitForArtifactRepoReady(
	binding: ArtifactNamespaceBinding,
	repoName: string,
	maxAttempts = 5,
) {
	let lastPending: ArtifactPendingRepoResponse | null = null
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const result = await binding.get(repoName)
		if (result.status === 'ready') {
			return result.repo
		}
		if (result.status === 'not_found') {
			throw new Error(`Artifacts repo "${repoName}" was not found.`)
		}
		lastPending = result
		if (attempt < maxAttempts) {
			await sleep(result.retryAfter * 1000)
		}
	}
	throw new Error(
		`Artifacts repo "${repoName}" is ${lastPending?.status ?? 'unavailable'}${
			lastPending ? ` (retry after ${lastPending.retryAfter}s)` : ''
		}.`,
	)
}

function parsePendingArtifactRepoResponse(
	response: ArtifactEnvelopeResponse<ArtifactRestRepoInfo>,
) {
	if (response.status !== 202) {
		return null
	}
	const payload = response.envelope.result as ArtifactPendingStatusPayload | null
	const status = normalizePendingArtifactStatus(
		payload?.status ??
			response.envelope.messages[0]?.message ??
			response.envelope.errors[0]?.message,
	)
	return {
		status,
		retryAfter: parseRetryAfterSeconds(response, payload),
	} satisfies ArtifactPendingRepoResponse
}

function normalizePendingArtifactStatus(value: string | undefined) {
	return value?.toLowerCase().includes('fork') ? 'forking' : 'importing'
}

function parseRetryAfterSeconds(
	response: ArtifactEnvelopeResponse<unknown>,
	payload?: ArtifactPendingStatusPayload | null,
) {
	const retryAfterHeader = response.headers.get('retry-after')
	const retryAfterValue =
		Number.parseInt(retryAfterHeader ?? '', 10) ||
		payload?.retry_after ||
		payload?.retryAfter ||
		parseRetryAfterFromMessages(response.envelope)
	return clampRetryAfterSeconds(retryAfterValue)
}

function parseRetryAfterFromMessages(envelope: ArtifactApiEnvelope<unknown>) {
	const combinedMessages = [
		...envelope.messages.map((message) => message.message),
		...envelope.errors.map((error) => error.message),
	].join(' ')
	const match = /retry after (\d+)/i.exec(combinedMessages)
	return match ? Number.parseInt(match[1] ?? '', 10) : undefined
}

function clampRetryAfterSeconds(value: number | undefined) {
	if (!value || !Number.isFinite(value) || value < 0) {
		return defaultArtifactRetryAfterSeconds
	}
	return Math.min(Math.max(1, Math.ceil(value)), maxArtifactRetryAfterSeconds)
}

function sleep(ms: number) {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms)
	})
}
