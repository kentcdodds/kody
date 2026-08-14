import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	CloudflareApiError,
	createCloudflareRestClient,
} from '#mcp/cloudflare/cloudflare-rest-client.ts'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import { type EntityKind } from './types.ts'

export type ArtifactToken = {
	id: string
	plaintext: string
	scope: string
	expiresAt: string
}

export type ArtifactStoredToken = {
	id: string
	scope: string
	expiresAt: string
	createdAt?: string | null
}

export type ArtifactBootstrapAccess = {
	defaultBranch: string
	remote: string
	token: string
	expiresAt: string
}

export type ArtifactRepoReadyResult =
	| { recreated: false; repo: ArtifactRepoHandle }
	| {
			recreated: true
			bootstrapAccess: ArtifactBootstrapAccess
			repo: ArtifactRepoHandle
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
	listTokens?(): Promise<Array<ArtifactStoredToken>>
	revokeToken?(idOrPlaintext: string): Promise<void>
}

export type ArtifactGetRepoResult =
	| { status: 'ready'; repo: ArtifactRepoHandle }
	| { status: 'not_found' }
	| { status: 'importing'; retryAfter: number }

export type ArtifactDeleteRepoResult = {
	id: string | null
	alreadyDeleted: boolean
}

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
		expiresAt: string
	}>
	get(name: string): Promise<ArtifactGetRepoResult>
	delete(name: string): Promise<ArtifactDeleteRepoResult>
	list(opts?: { limit?: number; cursor?: string }): Promise<{
		repos: Array<Omit<ArtifactRepoInfo, 'remote'>>
		total: number
		cursor?: string
	}>
	/** Local handle for `name`. Does not fetch; `info` / tokens hit the API later. */
	repo(name: string): ArtifactRepoHandle
}

export function resolveArtifactsNamespace(env: Env, namespace?: string | null) {
	const trimmed = namespace?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : getArtifactsNamespace(env)
}

function readNativeArtifactsBinding(env: Env): Artifacts | null {
	const binding = env.ARTIFACTS
	if (!binding || typeof binding.create !== 'function') return null
	return binding
}

export function getArtifactsBinding(
	env: Env,
	namespace?: string | null,
): ArtifactNamespaceBinding & Record<string, unknown> {
	const requestedNamespace = resolveArtifactsNamespace(env, namespace)
	const native = readNativeArtifactsBinding(env)
	if (native && requestedNamespace === getArtifactsNamespace(env)) {
		return adaptNativeArtifactsBinding(native, env)
	}
	const restBinding = createArtifactsRestBinding(env, requestedNamespace)
	if (!restBinding) {
		throw new Error(
			'Cloudflare Artifacts access requires the ARTIFACTS binding or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.',
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
	const configured = env.ARTIFACTS_NAMESPACE?.trim()
	return configured && configured.length > 0 ? configured : 'default'
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

type ArtifactRestStoredToken = {
	id: string
	scope: string
	expires_at: string
	created_at?: string | null
}

function isArtifactsBindingError(error: unknown): error is ArtifactsError {
	// Binding errors may not pass `instanceof Error` across the JSRPC
	// boundary. Match the documented `{ name, code }` shape only.
	if (error === null || typeof error !== 'object') return false
	const candidate = error as { name?: unknown; code?: unknown }
	return (
		candidate.name === 'ArtifactsError' && typeof candidate.code === 'string'
	)
}

function readArtifactsErrorMessage(error: unknown) {
	if (typeof error === 'string') return error
	if (error instanceof Error) return error.message
	if (
		error !== null &&
		typeof error === 'object' &&
		'message' in error &&
		typeof error.message === 'string'
	) {
		return error.message
	}
	return ''
}

function artifactsBindingErrorCode(error: unknown) {
	if (isArtifactsBindingError(error)) return error.code
	// JSRPC may flatten the class so `name` is Error and the message is
	// `ArtifactsError: Repository not found: <repo>`. Strip that prefix,
	// then require the known create-safe starts.
	const message = readArtifactsErrorMessage(error).replace(
		/^ArtifactsError:\s*/,
		'',
	)
	if (/^Repository not found(?::|\b)/.test(message)) return 'NOT_FOUND'
	if (/^Repository already exists(?::|\b)/.test(message)) {
		return 'ALREADY_EXISTS'
	}
	if (/^Import in progress(?::|\b)/i.test(message)) {
		return 'IMPORT_IN_PROGRESS'
	}
	return null
}

async function getNativeRepoOrThrow(native: Artifacts, name: string) {
	try {
		return await native.get(name)
	} catch (error) {
		const code = artifactsBindingErrorCode(error)
		if (code === 'NOT_FOUND') {
			throw new Error(`Artifacts repo "${name}" was not found.`, {
				cause: error,
			})
		}
		throw error
	}
}

function adaptNativeRepoHandle(
	repo: ArtifactsRepo,
	restRepo?: ArtifactRepoHandle,
): ArtifactRepoHandle {
	return {
		info: async () => {
			if (restRepo) {
				const info = await restRepo.info()
				if (info?.remote) return info
			}
			return {
				id: repo.id,
				name: repo.name,
				description: repo.description,
				defaultBranch: repo.defaultBranch,
				createdAt: repo.createdAt,
				updatedAt: repo.updatedAt,
				lastPushAt: repo.lastPushAt,
				source: repo.source,
				readOnly: repo.readOnly,
				remote: repo.remote,
			}
		},
		createToken: async (scope = 'write', ttl = 3600) => {
			// Native createToken still throws `undefined.split` across JSRPC
			// after mapping plaintext/token. Mint via REST when credentials
			// exist — that path worked before #1437 preferred the binding.
			if (restRepo) {
				return restRepo.createToken(scope, ttl)
			}
			try {
				const token = await repo.createToken(scope, ttl)
				const plaintext = readArtifactTokenPlaintext(token)
				return {
					id: token.id,
					plaintext,
					scope: token.scope,
					expiresAt: resolveCreatedTokenExpiry({
						token: plaintext,
						tokenExpiresAt:
							typeof token.expiresAt === 'string' ? token.expiresAt : null,
					}),
				}
			} catch (error) {
				throw new Error(
					`Artifacts native createToken failed: ${getErrorMessage(error)}`,
					{ cause: error },
				)
			}
		},
		listTokens: async () => {
			const listed = await repo.listTokens()
			return listed.tokens.map((token) => ({
				id: token.id,
				scope: token.scope,
				expiresAt: token.expiresAt,
				createdAt: token.createdAt,
			}))
		},
		revokeToken: async (idOrPlaintext) => {
			await repo.revokeToken(idOrPlaintext)
		},
	}
}

function adaptNativeArtifactsBinding(
	native: Artifacts,
	env: Env,
): ArtifactNamespaceBinding & Record<string, unknown> {
	const rest = createArtifactsRestBinding(env, getArtifactsNamespace(env))
	const repo = (name: string): ArtifactRepoHandle => ({
		info: async () => {
			const handle = await getNativeRepoOrThrow(native, name)
			return adaptNativeRepoHandle(handle, rest?.repo(name)).info()
		},
		createToken: async (scope = 'write', ttl = 3600) => {
			if (rest) {
				return rest.repo(name).createToken(scope, ttl)
			}
			const handle = await getNativeRepoOrThrow(native, name)
			return adaptNativeRepoHandle(handle).createToken(scope, ttl)
		},
		listTokens: async () => {
			const handle = await getNativeRepoOrThrow(native, name)
			return (
				adaptNativeRepoHandle(handle, rest?.repo(name)).listTokens?.() ?? []
			)
		},
		revokeToken: async (idOrPlaintext) => {
			const handle = await getNativeRepoOrThrow(native, name)
			await adaptNativeRepoHandle(handle, rest?.repo(name)).revokeToken?.(
				idOrPlaintext,
			)
		},
	})
	return {
		create: async (name, opts) => {
			const created = await native.create(name, opts)
			return {
				id: created.id,
				name: created.name,
				description: created.description,
				defaultBranch: created.defaultBranch,
				remote: created.remote,
				token: created.token,
				// Provider create currently omits tokenExpiresAt despite the
				// generated binding type. Prefer the field when present; else
				// parse `?expires=` from the token; else leave empty.
				expiresAt: resolveCreatedTokenExpiry({
					token: created.token,
					tokenExpiresAt:
						typeof created.tokenExpiresAt === 'string'
							? created.tokenExpiresAt
							: null,
				}),
			}
		},
		get: async (name) => {
			try {
				const handle = await native.get(name)
				return {
					status: 'ready' as const,
					repo: adaptNativeRepoHandle(handle, rest?.repo(name)),
				}
			} catch (error) {
				const code = artifactsBindingErrorCode(error)
				if (code === 'NOT_FOUND') {
					return { status: 'not_found' as const }
				}
				if (code === 'IMPORT_IN_PROGRESS') {
					return { status: 'importing' as const, retryAfter: 5 }
				}
				throw error
			}
		},
		delete: async (name) => {
			const deleted = await native.delete(name)
			return {
				id: null,
				alreadyDeleted: !deleted,
			}
		},
		list: async (opts) => await native.list(opts),
		repo,
	}
}

function createArtifactsRestBinding(env: Env, namespace: string) {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
	if (!accountId || !apiToken) {
		return null
	}
	const client = createCloudflareRestClient(env)
	const basePath = `/client/v4/accounts/${accountId}/artifacts/namespaces/${namespace}`
	const getRepoInfo = async (
		name: string,
	): Promise<ArtifactRepoInfo | null> => {
		const response = await requestArtifactsEnvelope<ArtifactRestRepoInfo>(
			client,
			{
				method: 'GET',
				path: `${basePath}/repos/${encodeURIComponent(name)}`,
				treat404AsNull: true,
			},
		)
		return response.result ? normalizeArtifactRepoInfo(response.result) : null
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
			const plaintext = readArtifactTokenPlaintext(result)
			return {
				id: result.id,
				plaintext,
				scope: result.scope,
				expiresAt: result.expires_at,
			}
		},
		listTokens: async () => {
			const envelope = await requestArtifactsEnvelope<
				Array<ArtifactRestStoredToken>
			>(client, {
				method: 'GET',
				path: `${basePath}/tokens`,
				query: {
					repo: name,
				},
			})
			return (envelope.result ?? []).map((token) => ({
				id: token.id,
				scope: token.scope,
				expiresAt: token.expires_at,
				createdAt: token.created_at ?? null,
			}))
		},
		revokeToken: async (idOrPlaintext) => {
			await requestArtifactsEnvelope(client, {
				method: 'DELETE',
				path: `${basePath}/tokens/${encodeURIComponent(idOrPlaintext)}`,
			})
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
		get: async (name) => {
			const info = await getRepoInfo(name)
			if (!info) {
				return { status: 'not_found' as const }
			}
			return {
				status: 'ready' as const,
				repo: repoHandle(name),
			}
		},
		delete: async (name) => {
			const envelope = await requestArtifactsEnvelope<{ id: string }>(client, {
				method: 'DELETE',
				path: `${basePath}/repos/${encodeURIComponent(name)}`,
				treat404AsNull: true,
			})
			if (!envelope.result) {
				return {
					id: null,
					alreadyDeleted: true,
				}
			}
			return {
				id: envelope.result.id,
				alreadyDeleted: false,
			}
		},
		list: async (opts) => {
			const query: Record<string, string> = {}
			if (opts?.limit !== undefined) {
				query['limit'] = String(opts.limit)
			}
			if (opts?.cursor) {
				query['cursor'] = opts.cursor
			}
			const envelope = await requestArtifactsEnvelope<
				Array<ArtifactRestRepoInfo>
			>(client, {
				method: 'GET',
				path: `${basePath}/repos`,
				query,
			})
			const repos = (envelope.result ?? []).map((repo) => {
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
				total: envelope.result_info?.total_count ?? repos.length,
				cursor: envelope.result_info?.cursor,
			}
		},
		repo: (name) => repoHandle(name),
	} satisfies ArtifactNamespaceBinding & Record<string, unknown>
}

function redactArtifactsRestPath(path: string) {
	return path.replace(/\/tokens\/[^/?#]+/g, '/tokens/:token')
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
	if (envelope.result == null) {
		throw new Error(`Artifacts API returned no result for ${input.path}.`)
	}
	return envelope.result
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
) {
	try {
		const response = await client.rawRequest({
			method: input.method,
			path: input.path,
			query: input.query,
			body: input.body,
		})
		if (response.cfRay) {
			console.info('artifacts-rest', {
				method: input.method,
				path: redactArtifactsRestPath(input.path),
				status: response.status,
				cfRay: response.cfRay,
			})
		}
		const envelope = response.body as ArtifactApiEnvelope<T> | null
		if (!envelope?.success) {
			const primaryError = envelope?.errors?.[0]
			const message =
				primaryError?.message ??
				`Artifacts API request failed (${response.status}).`
			if (input.treat404AsNull && response.status === 404) {
				return {
					result: null,
					success: true,
					errors: [],
					messages: [],
				} satisfies ArtifactApiEnvelope<T>
			}
			throw new Error(
				message,
				primaryError ? { cause: primaryError } : undefined,
			)
		}
		return envelope
	} catch (error) {
		if (
			input.treat404AsNull &&
			error instanceof CloudflareApiError &&
			error.status === 404
		) {
			return {
				result: null,
				success: true,
				errors: [],
				messages: [],
			} satisfies ArtifactApiEnvelope<T>
		}
		throw error
	}
}

function normalizeArtifactRepoInfo(
	repo: ArtifactRestRepoInfo,
): ArtifactRepoInfo {
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
	const expiresAt = tryParseArtifactTokenExpiry(token)
	if (expiresAt) return expiresAt
	throw new Error('Artifacts token is missing a parseable expires timestamp.')
}

function tryParseArtifactTokenExpiry(token: string) {
	const expiresAtSeconds = Number.parseInt(
		token.split('?expires=')[1] ?? '',
		10,
	)
	if (Number.isFinite(expiresAtSeconds)) {
		return new Date(expiresAtSeconds * 1000).toISOString()
	}
	return null
}

function readArtifactTokenPlaintext(token: {
	plaintext?: unknown
	token?: unknown
}) {
	if (typeof token.plaintext === 'string' && token.plaintext.length > 0) {
		return token.plaintext
	}
	// Native create() uses `token`; createToken is typed as `plaintext`.
	// JSRPC can drop one or the other the same way it dropped
	// `tokenExpiresAt`. Accept either so git remotes do not call
	// `undefined.split`.
	if (typeof token.token === 'string' && token.token.length > 0) {
		return token.token
	}
	throw new Error('Artifacts createToken result is missing plaintext.')
}

function resolveCreatedTokenExpiry(input: {
	token: string
	tokenExpiresAt?: string | null
}) {
	const fromBinding = input.tokenExpiresAt?.trim()
	if (fromBinding) return fromBinding
	return tryParseArtifactTokenExpiry(input.token) ?? ''
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
	if (typeof token !== 'string' || token.length === 0) {
		throw new Error('Artifacts token plaintext is missing.')
	}
	return token.split('?expires=')[0] ?? token
}

export function buildArtifactsGitAuth(input: { token: string }) {
	return {
		username: 'x',
		password: parseArtifactTokenSecret(input.token),
	}
}

export function buildAuthenticatedArtifactsRemote(input: {
	remote: string
	token: string
}) {
	const remoteUrl = new URL(input.remote)
	const isLoopbackHost = isLoopbackHostname(remoteUrl.hostname)
	const isAllowedProtocol =
		remoteUrl.protocol === 'https:' ||
		(remoteUrl.protocol === 'http:' && isLoopbackHost)
	if (!isAllowedProtocol) {
		throw new Error(`Artifact remote must use https://, got: ${input.remote}`)
	}
	const auth = buildArtifactsGitAuth({ token: input.token })
	remoteUrl.username = auth.username
	remoteUrl.password = auth.password
	return remoteUrl.toString()
}

function describeArtifactRemote(remote: string) {
	try {
		const url = new URL(remote)
		url.username = ''
		url.password = ''
		return url.toString()
	} catch {
		return 'unparseable-remote'
	}
}

export async function listArtifactServerRefs(input: {
	remote: string
	token: string
	prefix?: string
}) {
	// Embed credentials in the URL so the first info/refs request is
	// authenticated. onAuth only runs after 401; Artifacts can fail earlier.
	const url = buildAuthenticatedArtifactsRemote({
		remote: input.remote,
		token: input.token,
	})
	return git.listServerRefs({
		http,
		url,
		prefix: input.prefix,
		symrefs: true,
	})
}

export async function resolveArtifactDefaultBranchHead(input: {
	repo: ArtifactRepoHandle
	token?: string
	info?: ArtifactRepoInfo | null
}) {
	const [info, tokenPlaintext] = await Promise.all([
		input.info === undefined ? input.repo.info() : Promise.resolve(input.info),
		input.token !== undefined
			? Promise.resolve(input.token)
			: input.repo.createToken('read', 300).then((token) => token.plaintext),
	])
	if (!info?.remote) {
		throw new Error('Artifact repo remote URL is unavailable.')
	}
	if (typeof tokenPlaintext !== 'string' || tokenPlaintext.length === 0) {
		throw new Error('Artifacts createToken result is missing plaintext.')
	}
	const refName = `refs/heads/${info.defaultBranch || 'main'}`
	let refs: Awaited<ReturnType<typeof listArtifactServerRefs>>
	try {
		refs = await listArtifactServerRefs({
			remote: info.remote,
			token: tokenPlaintext,
			prefix: refName,
		})
	} catch (error) {
		throw new Error(
			`Artifacts listServerRefs failed for ${describeArtifactRemote(info.remote)}: ${getErrorMessage(error)}`,
			{ cause: error },
		)
	}
	const branchRef = refs.find((ref) => ref.ref === refName)
	if (!branchRef?.oid) {
		return null
	}
	return {
		remote: info.remote,
		defaultBranch: info.defaultBranch || 'main',
		commit: branchRef.oid,
	}
}

export function isLoopbackHostname(hostname: string) {
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '[::1]' ||
		hostname === '::1'
	)
}

export function isLoopbackArtifactsRemote(remote: string) {
	try {
		const url = new URL(remote)
		return url.protocol === 'http:' && isLoopbackHostname(url.hostname)
	} catch {
		return false
	}
}

type MockArtifactSnapshot = {
	published_commit: string
	files: Record<string, string>
}

function buildArtifactsNamespaceBasePath(env: Env) {
	return `/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/artifacts/namespaces/${getArtifactsNamespace(env)}`
}

export async function writeMockArtifactSnapshot(input: {
	env: Env
	repoId: string
	files: Record<string, string>
}) {
	const client = createCloudflareRestClient(input.env)
	const result = await requestArtifactsApi<MockArtifactSnapshot>(client, {
		method: 'POST',
		path: `${buildArtifactsNamespaceBasePath(input.env)}/repos/${encodeURIComponent(input.repoId)}/mock-source-snapshot`,
		body: {
			files: input.files,
		},
	})
	return result
}

export async function readMockArtifactSnapshot(input: {
	env: Env
	repoId: string
	commit: string | null
}) {
	const client = createCloudflareRestClient(input.env)
	const envelope = await requestArtifactsEnvelope<MockArtifactSnapshot>(
		client,
		{
			method: 'GET',
			path: `${buildArtifactsNamespaceBasePath(input.env)}/repos/${encodeURIComponent(input.repoId)}/mock-source-snapshot`,
			query: input.commit ? { commit: input.commit } : undefined,
			treat404AsNull: true,
		},
	)
	return envelope.result
}

function isArtifactRepoAlreadyExistsError(error: unknown) {
	if (artifactsBindingErrorCode(error) === 'ALREADY_EXISTS') {
		return true
	}
	if (!(error instanceof Error)) {
		return false
	}
	const text = error.message
	const cause = error.cause
	const causeMessage =
		cause && typeof cause === 'object' && 'message' in cause
			? String(cause.message)
			: ''
	const causeCode =
		cause && typeof cause === 'object' && 'code' in cause
			? Number(cause.code)
			: null
	return (
		causeCode === 10201 ||
		/already[\s_-]*exists|already_exists/i.test(`${text} ${causeMessage}`)
	)
}

function waitForArtifactRepoCheck(delayMs: number) {
	return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function waitForArtifactRepoReadyAfterCreateConflict(input: {
	binding: ArtifactNamespaceBinding
	repoId: string
	maxAttempts?: number
	delayMs?: number
}): Promise<ArtifactRepoReadyResult> {
	const maxAttempts = input.maxAttempts ?? 5
	const delayMs = input.delayMs ?? 50
	let lastStatus = 'not_found'
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const result = await input.binding.get(input.repoId)
		if (result.status === 'ready') {
			return { recreated: false, repo: result.repo }
		}
		lastStatus = result.status
		if (result.status === 'importing') {
			throw new Error(
				`Artifacts repo "${input.repoId}" is importing. Retry after ${result.retryAfter}s.`,
			)
		}
		if (attempt < maxAttempts) {
			await waitForArtifactRepoCheck(delayMs)
		}
	}
	throw new Error(
		`Artifacts repo "${input.repoId}" is ${lastStatus} after create conflict.`,
	)
}

export async function ensureArtifactRepoReady(
	env: Env,
	repoId: string,
	binding: ArtifactNamespaceBinding = getArtifactsBinding(env),
): Promise<ArtifactRepoReadyResult> {
	const existing = await binding.get(repoId)
	if (existing.status === 'ready') {
		return { recreated: false, repo: existing.repo }
	}
	if (existing.status === 'importing') {
		throw new Error(
			`Artifacts repo "${repoId}" is importing. Retry after ${existing.retryAfter}s.`,
		)
	}
	let created: Awaited<ReturnType<ArtifactNamespaceBinding['create']>>
	try {
		created = await binding.create(repoId, { readOnly: false })
	} catch (error) {
		if (isArtifactRepoAlreadyExistsError(error)) {
			return await waitForArtifactRepoReadyAfterCreateConflict({
				binding,
				repoId,
			})
		}
		throw error
	}
	const bootstrapAccess = {
		defaultBranch: created.defaultBranch,
		remote: created.remote,
		token: created.token,
		expiresAt: created.expiresAt,
	}
	return {
		recreated: true,
		bootstrapAccess,
		repo: binding.repo(created.name),
	}
}

export async function resolveArtifactSourceRepo(env: Env, repoId: string) {
	const binding = getArtifactsBinding(env)
	const result = await ensureArtifactRepoReady(env, repoId, binding)
	return result.repo
}

export async function resolveExistingArtifactSourceRepo(
	env: Env,
	repoId: string,
	binding: ArtifactNamespaceBinding = getArtifactsBinding(env),
) {
	const result = await binding.get(repoId)
	if (result.status === 'ready') {
		return result.repo
	}
	if (result.status === 'not_found') {
		return null
	}
	throw new Error(
		`Artifacts repo "${repoId}" is ${result.status}. Retry after ${result.retryAfter}s.`,
	)
}

export async function resolveArtifactSourceHead(env: Env, repoId: string) {
	const repo = await resolveExistingArtifactSourceRepo(env, repoId)
	if (!repo) {
		return {
			branch: 'main',
			commit: null,
		}
	}
	const ref = await resolveArtifactDefaultBranchHead({ repo })
	return {
		branch: ref?.defaultBranch ?? 'main',
		commit: ref?.commit ?? null,
	}
}
