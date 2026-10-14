import {
	buildAuthenticatedArtifactsRemote,
	parseArtifactTokenSecret,
	resolveExistingArtifactSourceRepo,
} from '#worker/repo/artifacts.ts'
import {
	artifactsReceivePackBodyLimitBytes,
	artifactsReceivePackBusyBackoffMs,
	artifactsReceivePackWaitBudgetMs,
	readReceivePackBodyWithLimit,
	ReceivePackBodyTooLargeError,
	ReceivePackWaitTimeoutError,
	waitOutReceivePackBusy,
	withReceivePackGate,
} from '#worker/repo/artifacts-receive-pack-wait.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'

const gitUploadPackService = 'git-upload-pack'
const gitReceivePackService = 'git-receive-pack'
/** Upstream Artifacts lock-contention code observed on concurrent receive-pack. */
export const artifactsGitReceivePackBusyCode = 'artifacts_git_receive_pack_busy'
export const artifactsReceivePackBusyRetryAfterSeconds = 5
export const repositoryBusyRetryMessage = 'repository busy, retry'

export {
	artifactsReceivePackBodyLimitBytes,
	artifactsReceivePackBusyBackoffMs,
	artifactsReceivePackWaitBudgetMs,
}

const hopByHopResponseHeaders = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailers',
	'transfer-encoding',
	'upgrade',
	// Never leak Artifacts host redirects or auth challenges to clients.
	'location',
	'www-authenticate',
	'set-cookie',
])

/** `entity_sources.id` (crypto.randomUUID). */
const plainRepoIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type PlainRepoGitHttpPath =
	| {
			kind: 'info-refs'
			sourceId: string
	  }
	| {
			kind: 'upload-pack'
			sourceId: string
	  }
	| {
			kind: 'receive-pack'
			sourceId: string
	  }
	| {
			kind: 'repo-root'
			sourceId: string
	  }
	| {
			kind: 'unsupported'
			sourceId: string
	  }

function decodePathComponent(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

function stripTrailingSlash(value: string) {
	return value.endsWith('/') ? value.slice(0, -1) : value
}

/**
 * Match `/git/sources/{sourceId}.git` and smart-HTTP suffixes under it.
 * Returns null when the path is not a plain-repo git proxy URL.
 */
export function parsePlainRepoGitHttpPath(
	pathname: string,
): PlainRepoGitHttpPath | null {
	const parts = pathname.split('/').filter(Boolean)
	if (parts.length < 3 || parts[0] !== 'git' || parts[1] !== 'sources') {
		return null
	}
	const sourceSegment = decodePathComponent(parts[2] ?? '')
	if (!sourceSegment.toLowerCase().endsWith('.git')) return null
	const sourceId = sourceSegment.slice(0, -'.git'.length)
	if (!sourceId || !plainRepoIdPattern.test(sourceId)) return null

	const rest = parts.slice(3)
	if (rest.length === 0) {
		return { kind: 'repo-root', sourceId }
	}
	if (rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
		return { kind: 'info-refs', sourceId }
	}
	if (rest.length === 1 && rest[0] === 'git-upload-pack') {
		return { kind: 'upload-pack', sourceId }
	}
	if (rest.length === 1 && rest[0] === 'git-receive-pack') {
		return { kind: 'receive-pack', sourceId }
	}
	return { kind: 'unsupported', sourceId }
}

export function isPlainRepoGitHttpRequest(pathname: string) {
	return parsePlainRepoGitHttpPath(pathname) !== null
}

export function buildPlainRepoGitHttpRemote(input: {
	baseUrl: string
	sourceId: string
}) {
	const origin = stripTrailingSlash(input.baseUrl.trim())
	return `${origin}/git/sources/${input.sourceId}.git`
}

export const plainRepoGitHttpErrorBodyReadLimitBytes = 64 * 1024

/** Read up to `limitBytes` of an error response for busy-code sniffing. */
export async function readCappedResponseText(
	response: Response,
	limitBytes = plainRepoGitHttpErrorBodyReadLimitBytes,
): Promise<string> {
	if (!response.body) return ''
	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let result = ''
	let totalBytes = 0
	try {
		while (totalBytes < limitBytes) {
			let chunk: ReadableStreamReadResult<Uint8Array>
			try {
				chunk = await reader.read()
			} catch {
				// Partial body is still useful when the upstream stream errors mid-read.
				break
			}
			if (chunk.done) break
			totalBytes += chunk.value.byteLength
			result += decoder.decode(chunk.value, { stream: true })
		}
	} catch {
		// Return whatever we sniffed before an unexpected failure.
	} finally {
		try {
			reader.releaseLock()
		} catch {
			try {
				await reader.cancel()
			} catch {
				// ignore
			}
		}
	}
	return result
}

const plainRepoGitHttpHeadersTimeoutMs = 120_000

async function fetchWithHeadersTimeout(
	url: string,
	init: RequestInit,
	timeoutMs = plainRepoGitHttpHeadersTimeoutMs,
): Promise<Response> {
	const controller = new AbortController()
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
	try {
		const response = await fetch(url, { ...init, signal: controller.signal })
		clearTimeout(timeoutId)
		return response
	} catch (error) {
		clearTimeout(timeoutId)
		throw error
	}
}

export function isArtifactsGitReceivePackBusyResponse(input: {
	status: number
	bodyText: string
}) {
	if (input.status >= 200 && input.status < 300) return false
	return input.bodyText.includes(artifactsGitReceivePackBusyCode)
}

export function repositoryBusyRetryResponse(
	retryAfterSeconds = artifactsReceivePackBusyRetryAfterSeconds,
) {
	return new Response(repositoryBusyRetryMessage, {
		status: 503,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
			'Retry-After': String(retryAfterSeconds),
		},
	})
}

function notFoundResponse() {
	return new Response('Not Found', {
		status: 404,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

function unauthorizedResponse() {
	return new Response('Unauthorized', {
		status: 401,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
			'WWW-Authenticate': 'Bearer realm="kody-git"',
		},
	})
}

function methodNotAllowedResponse(allow: string) {
	return new Response('Method Not Allowed', {
		status: 405,
		headers: {
			Allow: allow,
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

function serviceUnavailableResponse(message: string) {
	return new Response(message, {
		status: 503,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

function filterProxiedResponseHeaders(headers: Headers) {
	const filtered = new Headers()
	headers.forEach((value, key) => {
		if (hopByHopResponseHeaders.has(key.toLowerCase())) return
		filtered.set(key, value)
	})
	filtered.set('Cache-Control', 'no-store')
	return filtered
}

/**
 * Prefer Bearer; also accept Basic `x:<token>` from credentialed clone URLs.
 */
export function extractArtifactsTokenFromRequest(request: Request) {
	const auth = request.headers.get('Authorization')?.trim() ?? ''
	if (!auth) return null
	const lower = auth.toLowerCase()
	if (lower.startsWith('bearer ')) {
		const token = auth.slice('Bearer '.length).trim()
		return token.length > 0 ? parseArtifactTokenSecret(token) : null
	}
	if (lower.startsWith('basic ')) {
		const encoded = auth.slice('Basic '.length).trim()
		if (!encoded) return null
		try {
			const decoded = atob(encoded)
			const colon = decoded.indexOf(':')
			const password = (colon >= 0 ? decoded.slice(colon + 1) : decoded).trim()
			return password.length > 0 ? parseArtifactTokenSecret(password) : null
		} catch {
			return null
		}
	}
	return null
}

function artifactsAuthHeaders(token: string) {
	return {
		Authorization: `Bearer ${parseArtifactTokenSecret(token)}`,
	}
}

type ResolvedPlainGitTarget = {
	remote: string
}

async function resolvePlainRepoGitTarget(input: {
	env: Env
	sourceId: string
}): Promise<
	| { kind: 'ok'; target: ResolvedPlainGitTarget }
	| { kind: 'not_found' }
	| { kind: 'unavailable'; message: string }
> {
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	// Accept both plain repos and packages: promote flips entity_kind to
	// `package` while keeping the same entity_sources.id + Artifacts repo_id,
	// so minted `/git/sources/{id}.git` remotes must keep working.
	if (!source || !source.repo_id) {
		return { kind: 'not_found' }
	}

	const repo = await resolveExistingArtifactSourceRepo(
		input.env,
		source.repo_id,
	)
	if (!repo) return { kind: 'not_found' }

	let info: Awaited<ReturnType<typeof repo.info>>
	try {
		info = await repo.info()
	} catch {
		return {
			kind: 'unavailable',
			message: 'Artifact repository is temporarily unavailable.',
		}
	}
	if (!info?.remote) {
		return {
			kind: 'unavailable',
			message: 'Artifact repository remote is unavailable.',
		}
	}

	try {
		// Validate protocol early (same guard as direct Artifacts remotes).
		buildAuthenticatedArtifactsRemote({
			remote: info.remote,
			token: 'x',
		})
	} catch {
		return {
			kind: 'unavailable',
			message: 'Artifact repository remote is unavailable.',
		}
	}

	return { kind: 'ok', target: { remote: info.remote } }
}

function buildArtifactsSmartHttpUrl(
	remote: string,
	parsed: PlainRepoGitHttpPath,
	service?: string | null,
) {
	const base = stripTrailingSlash(remote)
	switch (parsed.kind) {
		case 'info-refs': {
			const selected = service ?? gitUploadPackService
			return `${base}/info/refs?service=${encodeURIComponent(selected)}`
		}
		case 'upload-pack':
			return `${base}/git-upload-pack`
		case 'receive-pack':
			return `${base}/git-receive-pack`
		case 'repo-root':
		case 'unsupported':
			return base
		default: {
			const exhaustive: never = parsed
			throw new Error(`Unhandled plain-repo git path: ${String(exhaustive)}`)
		}
	}
}

function forwardGitRequestHeaders(input: { request: Request; token: string }) {
	const headers = new Headers(artifactsAuthHeaders(input.token))
	const contentType = input.request.headers.get('Content-Type')
	if (contentType) headers.set('Content-Type', contentType)
	const accept = input.request.headers.get('Accept')
	if (accept) headers.set('Accept', accept)
	const gitProtocol = input.request.headers.get('Git-Protocol')
	if (gitProtocol) headers.set('Git-Protocol', gitProtocol)
	return headers
}

function proxiedUpstreamResponse(upstream: Response) {
	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: filterProxiedResponseHeaders(upstream.headers),
	})
}

async function proxyArtifactsReceivePack(input: {
	target: ResolvedPlainGitTarget
	sourceId: string
	request: Request
	token: string
}): Promise<Response> {
	const upstreamUrl = buildArtifactsSmartHttpUrl(input.target.remote, {
		kind: 'receive-pack',
		sourceId: input.sourceId,
	})
	const headers = forwardGitRequestHeaders({
		request: input.request,
		token: input.token,
	})

	const deadlineMs = Date.now() + artifactsReceivePackWaitBudgetMs
	try {
		return await withReceivePackGate(
			input.sourceId,
			artifactsReceivePackWaitBudgetMs,
			async () => {
				// Buffer only while holding the gate so queued pushes do not each
				// retain a full pack in isolate memory while they wait their turn.
				let packBody: Uint8Array
				try {
					packBody = await readReceivePackBodyWithLimit(input.request.body)
				} catch (error) {
					if (error instanceof ReceivePackBodyTooLargeError) {
						return new Response(error.message, {
							status: 413,
							headers: {
								'Cache-Control': 'no-store',
								'Content-Type': 'text/plain; charset=utf-8',
							},
						})
					}
					throw error
				}
				const waited = await waitOutReceivePackBusy({
					deadlineMs,
					backoffMs: artifactsReceivePackBusyBackoffMs,
					send: async () =>
						fetchWithHeadersTimeout(upstreamUrl, {
							method: 'POST',
							headers,
							body: packBody as BodyInit,
						}),
					isBusy: (response, bodyText) =>
						isArtifactsGitReceivePackBusyResponse({
							status: response.status,
							bodyText,
						}),
					readBusyBody: readCappedResponseText,
				})
				if (waited.kind === 'timeout') {
					return repositoryBusyRetryResponse()
				}
				if (waited.response.ok) {
					return proxiedUpstreamResponse(waited.response)
				}
				return new Response(await waited.response.text(), {
					status: waited.response.status,
					statusText: waited.response.statusText,
					headers: filterProxiedResponseHeaders(waited.response.headers),
				})
			},
		)
	} catch (error) {
		if (error instanceof ReceivePackWaitTimeoutError) {
			return repositoryBusyRetryResponse()
		}
		throw error
	}
}

async function proxyArtifactsGitRequest(input: {
	target: ResolvedPlainGitTarget
	parsed: PlainRepoGitHttpPath
	request: Request
	token: string
	service?: string | null
}): Promise<Response> {
	if (input.parsed.kind === 'receive-pack') {
		return proxyArtifactsReceivePack({
			target: input.target,
			sourceId: input.parsed.sourceId,
			request: input.request,
			token: input.token,
		})
	}

	const upstreamUrl = buildArtifactsSmartHttpUrl(
		input.target.remote,
		input.parsed,
		input.service,
	)
	const headers = forwardGitRequestHeaders({
		request: input.request,
		token: input.token,
	})

	const init: RequestInit = {
		method: input.request.method,
		headers,
	}
	if (
		input.request.method !== 'GET' &&
		input.request.method !== 'HEAD' &&
		input.request.body
	) {
		init.body = input.request.body
		;(init as RequestInit & { duplex: 'half' }).duplex = 'half'
	}

	const upstream = await fetchWithHeadersTimeout(upstreamUrl, init)

	// Never rewrite successful fetches — accepted packs must pass through.
	if (upstream.ok || input.request.method === 'HEAD') {
		return proxiedUpstreamResponse(upstream)
	}

	const bodyText = await readCappedResponseText(upstream)
	return new Response(bodyText, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: filterProxiedResponseHeaders(upstream.headers),
	})
}

/**
 * Authenticated smart HTTP Git proxy for plain repos minted by
 * `repoGetGitRemote`. On Artifacts receive-pack lock contention, waits in a
 * bounded FIFO (same-isolate) and retries upstream before returning 503 +
 * Retry-After. Ref updates stay atomic at Artifacts; non-fast-forward rejects
 * pass through unchanged.
 */
export async function handlePlainRepoGitHttpRequest(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const url = new URL(request.url)
	const parsed = parsePlainRepoGitHttpPath(url.pathname)
	if (!parsed) return null

	const token = extractArtifactsTokenFromRequest(request)
	if (!token) return unauthorizedResponse()

	if (parsed.kind === 'unsupported') {
		return notFoundResponse()
	}

	if (parsed.kind === 'repo-root') {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return methodNotAllowedResponse('GET, HEAD')
		}
		const body = `This is a Kody plain-repo git remote.\nClone with: git clone ${url.origin}/git/sources/${parsed.sourceId}.git\n`
		return new Response(request.method === 'HEAD' ? null : body, {
			status: 200,
			headers: {
				'Cache-Control': 'no-store',
				'Content-Type': 'text/plain; charset=utf-8',
			},
		})
	}

	if (parsed.kind === 'info-refs') {
		const service = url.searchParams.get('service')
		if (service !== gitUploadPackService && service !== gitReceivePackService) {
			return new Response(
				'Smart HTTP only. Use ?service=git-upload-pack or ?service=git-receive-pack.',
				{
					status: 403,
					headers: {
						'Cache-Control': 'no-store',
						'Content-Type': 'text/plain; charset=utf-8',
					},
				},
			)
		}
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return methodNotAllowedResponse('GET, HEAD')
		}
	} else if (request.method !== 'POST') {
		return methodNotAllowedResponse('POST')
	}

	const resolved = await resolvePlainRepoGitTarget({
		env,
		sourceId: parsed.sourceId,
	})
	if (resolved.kind === 'not_found') return notFoundResponse()
	if (resolved.kind === 'unavailable') {
		return serviceUnavailableResponse(resolved.message)
	}

	try {
		return await proxyArtifactsGitRequest({
			target: resolved.target,
			parsed,
			request,
			token,
			service:
				parsed.kind === 'info-refs' ? url.searchParams.get('service') : null,
		})
	} catch {
		return serviceUnavailableResponse(
			'Failed to proxy git traffic to the artifact repository.',
		)
	}
}
