import {
	parseApiToken,
	readBearerApiToken,
} from '@kody-internal/shared/api-token-format.ts'
import { checkRateLimit } from '#app/rate-limit.ts'
import { getRequestIp } from '#worker/audit-log.ts'
import { getCommunityPackageGitHref } from '#universal/community-links.ts'
import {
	authenticateApiToken,
	getApiTokenIssuedAtMs,
	slideApiTokenExpiry,
	touchApiToken,
} from '#worker/api-tokens/service.ts'
import { resolveCommunityPackageUrl } from '#worker/community/package-url.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
import { buildMcpUserContextFromGrantProps } from '#worker/mcp-auth-user-context.ts'
import { isCredentialInvalidatedByStoredPasswordChange } from '#worker/password-change-lockout.ts'
import { kodyPackageIdPattern } from '#worker/package-registry/types.ts'
import {
	buildAuthenticatedArtifactsRemote,
	parseArtifactTokenSecret,
	resolveExistingArtifactSourceRepo,
} from '#worker/repo/artifacts.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import {
	buildUploadPackAdvertisement,
	rewriteUploadPackAdvertisement,
	uploadPackWantsOnlySnapshot,
} from '#worker/repo/git-pkt-line.ts'
import { resolveGitHttpTargetAccess } from '#worker/repo/git-http-target.ts'

const gitUploadPackService = 'git-upload-pack'
const gitReceivePackService = 'git-receive-pack'
const publicGitProxyAgent = 'kody-public-git'
const authenticatedGitProxyAgent = 'kody-git'
const publicGitTokenTtlSeconds = 300
const authenticatedGitTokenTtlSeconds = 300
const publicGitRateLimit = { maxRequests: 120, windowSeconds: 60 } as const
/** Anonymous upload-pack bodies are tiny (want/have negotiation). Cap memory. */
const publicGitUploadPackMaxBodyBytes = 256 * 1024
/** Authenticated live clones may send larger want/have negotiation. */
const authenticatedGitUploadPackMaxBodyBytes = 1024 * 1024

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

export type PublicPackageGitHttpPath =
	| {
			kind: 'info-refs'
			username: string
			kodyId: string
	  }
	| {
			kind: 'upload-pack'
			username: string
			kodyId: string
	  }
	| {
			kind: 'receive-pack'
			username: string
			kodyId: string
	  }
	| {
			kind: 'repo-root'
			username: string
			kodyId: string
	  }
	| {
			kind: 'unsupported'
			username: string
			kodyId: string
	  }

function decodePathComponent(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

/**
 * Match `/@username/kody-id.git` and the smart-HTTP suffixes under it.
 * Returns null when the path is not a public package git URL.
 */
export function parsePublicPackageGitHttpPath(
	pathname: string,
): PublicPackageGitHttpPath | null {
	const parts = pathname.split('/').filter(Boolean)
	if (parts.length < 2 || !parts[0]?.startsWith('@') || parts[0].length <= 1) {
		return null
	}
	const username = decodePathComponent(parts[0].slice(1))
	const repoSegment = decodePathComponent(parts[1] ?? '')
	if (!username || !repoSegment.toLowerCase().endsWith('.git')) {
		return null
	}
	const kodyId = repoSegment.slice(0, -'.git'.length)
	if (!kodyId || !kodyPackageIdPattern.test(kodyId)) {
		return null
	}

	const rest = parts.slice(2)
	if (rest.length === 0) {
		return { kind: 'repo-root', username, kodyId }
	}
	if (rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
		return { kind: 'info-refs', username, kodyId }
	}
	if (rest.length === 1 && rest[0] === 'git-upload-pack') {
		return { kind: 'upload-pack', username, kodyId }
	}
	if (rest.length === 1 && rest[0] === 'git-receive-pack') {
		return { kind: 'receive-pack', username, kodyId }
	}
	return { kind: 'unsupported', username, kodyId }
}

export function isPublicPackageGitHttpRequest(pathname: string) {
	return parsePublicPackageGitHttpPath(pathname) !== null
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

function authRequiredResponse(message = 'Authentication required') {
	return new Response(message, {
		status: 401,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
			'WWW-Authenticate': 'Basic realm="kody-git"',
		},
	})
}

function forbiddenResponse(message: string) {
	return new Response(message, {
		status: 403,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

function wantRejectedResponse() {
	return new Response(
		'Public package git remotes only serve the published snapshot commit.',
		{
			status: 403,
			headers: {
				'Cache-Control': 'no-store',
				'Content-Type': 'text/plain; charset=utf-8',
			},
		},
	)
}

function payloadTooLargeResponse() {
	return new Response('Upload-pack request body too large.', {
		status: 413,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

function rateLimitedResponse(retryAfterSeconds: number) {
	return new Response('Too Many Requests', {
		status: 429,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
			'Retry-After': String(retryAfterSeconds),
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

async function enforcePublicGitRateLimit(input: {
	env: Env
	request: Request
}) {
	const ip = getRequestIp(input.request) ?? 'unknown'
	return checkRateLimit(
		input.env.APP_DB,
		`public-git:ip:${ip}`,
		publicGitRateLimit,
	)
}

type ResolvedPublicGitTarget = {
	username: string
	kodyId: string
	listingId: string
	sourceId: string
	repoId: string
	snapshotCommit: string
	defaultBranch: string
	remote: string
	tokenPlaintext: string
}

async function resolvePublicGitTarget(input: {
	env: Env
	username: string
	kodyId: string
}): Promise<
	| { kind: 'ok'; target: ResolvedPublicGitTarget }
	| { kind: 'not_found' }
	| { kind: 'redirect'; to: string }
	| { kind: 'unavailable'; message: string }
> {
	const urlTarget = await resolveCommunityPackageUrl({
		db: input.env.APP_DB,
		username: input.username,
		kodyId: input.kodyId,
	})
	if (!urlTarget) return { kind: 'not_found' }
	if (urlTarget.kind === 'redirect') {
		// Only follow public listing moves. Unlisted renames must not leak.
		if (!urlTarget.listingId) return { kind: 'not_found' }
		return {
			kind: 'redirect',
			to: getCommunityPackageGitHref({
				username: urlTarget.username,
				kodyId: urlTarget.kodyId,
			}),
		}
	}

	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId: urlTarget.listingId,
		includeDelisted: false,
	})
	if (!listing) return { kind: 'not_found' }

	const source = await getEntitySourceById(input.env.APP_DB, listing.sourceId)
	if (!source?.repo_id) return { kind: 'not_found' }

	const snapshotCommit = resolveImmutableSnapshotCommit({
		publishedCommit: source.published_commit,
		pinnedCommit: listing.pinnedCommit,
	})
	if (!snapshotCommit) {
		return {
			kind: 'unavailable',
			message: 'Public package has no published snapshot commit to clone.',
		}
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

	let token: Awaited<ReturnType<typeof repo.createToken>>
	try {
		token = await repo.createToken('read', publicGitTokenTtlSeconds)
	} catch {
		return {
			kind: 'unavailable',
			message: 'Failed to mint a read token for the artifact repository.',
		}
	}
	if (typeof token.plaintext !== 'string' || token.plaintext.length === 0) {
		return {
			kind: 'unavailable',
			message: 'Artifact read token was empty.',
		}
	}

	return {
		kind: 'ok',
		target: {
			username: urlTarget.username,
			kodyId: urlTarget.kodyId,
			listingId: listing.id,
			sourceId: listing.sourceId,
			repoId: source.repo_id,
			snapshotCommit,
			defaultBranch: info.defaultBranch?.trim() || 'main',
			remote: info.remote,
			tokenPlaintext: token.plaintext,
		},
	}
}

export function resolveImmutableSnapshotCommit(input: {
	publishedCommit: string | null | undefined
	pinnedCommit: string | null | undefined
}) {
	for (const candidate of [input.publishedCommit, input.pinnedCommit]) {
		const trimmed = candidate?.trim().toLowerCase()
		if (trimmed && /^[0-9a-f]{40}$/.test(trimmed)) {
			return trimmed
		}
	}
	return null
}

function artifactsAuthHeaders(tokenPlaintext: string): HeadersInit {
	return {
		Authorization: `Bearer ${parseArtifactTokenSecret(tokenPlaintext)}`,
	}
}

async function readUploadPackRequestBody(
	request: Request,
	maxBodyBytes: number = publicGitUploadPackMaxBodyBytes,
): Promise<{ ok: true; body: Uint8Array } | { ok: false; response: Response }> {
	const contentLengthHeader = request.headers.get('Content-Length')
	if (contentLengthHeader != null) {
		const contentLength = Number.parseInt(contentLengthHeader, 10)
		if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
			return { ok: false, response: payloadTooLargeResponse() }
		}
	}

	const reader = request.body?.getReader()
	if (!reader) {
		return { ok: true, body: new Uint8Array() }
	}

	const chunks: Array<Uint8Array> = []
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		if (!value || value.byteLength === 0) continue
		size += value.byteLength
		if (size > maxBodyBytes) {
			try {
				await reader.cancel()
			} catch {
				// Ignore cancel errors; the size limit response is what matters.
			}
			return { ok: false, response: payloadTooLargeResponse() }
		}
		chunks.push(value)
	}

	const body = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		body.set(chunk, offset)
		offset += chunk.byteLength
	}
	return { ok: true, body }
}

type ProxiedGitTarget = {
	username: string
	kodyId: string
	defaultBranch: string
	remote: string
	tokenPlaintext: string
	/** Snapshot mode pins advertisement and wants; null = live HEAD. */
	snapshotCommit: string | null
	agent: string
	canWrite: boolean
	resourceKind: 'package' | 'repo' | 'public'
}

function toProxiedPublicTarget(
	target: ResolvedPublicGitTarget,
): ProxiedGitTarget {
	return {
		username: target.username,
		kodyId: target.kodyId,
		defaultBranch: target.defaultBranch,
		remote: target.remote,
		tokenPlaintext: target.tokenPlaintext,
		snapshotCommit: target.snapshotCommit,
		agent: publicGitProxyAgent,
		canWrite: false,
		resourceKind: 'public',
	}
}

async function proxyArtifactsUploadPack(input: {
	target: ProxiedGitTarget
	request: Request
}): Promise<Response> {
	// Authenticated URL builder validates the remote protocol; credentials go
	// in Authorization so proxied responses never need to echo a credentialed URL.
	buildAuthenticatedArtifactsRemote({
		remote: input.target.remote,
		token: input.target.tokenPlaintext,
	})
	const upstreamUrl = `${stripTrailingSlash(input.target.remote)}/git-upload-pack`

	const headers = new Headers(artifactsAuthHeaders(input.target.tokenPlaintext))
	const contentType = input.request.headers.get('Content-Type')
	if (contentType) headers.set('Content-Type', contentType)
	const accept = input.request.headers.get('Accept')
	if (accept) headers.set('Accept', accept)
	// Advertisement is always protocol v1; never forward a client version=2
	// header that would make Artifacts mis-parse the want body.
	headers.set('Git-Protocol', 'version=1')

	const maxBodyBytes = input.target.snapshotCommit
		? publicGitUploadPackMaxBodyBytes
		: authenticatedGitUploadPackMaxBodyBytes
	const bodyResult = await readUploadPackRequestBody(
		input.request,
		maxBodyBytes,
	)
	if (!bodyResult.ok) return bodyResult.response

	if (input.target.snapshotCommit) {
		if (
			!uploadPackWantsOnlySnapshot({
				body: bodyResult.body,
				snapshotCommit: input.target.snapshotCommit,
			})
		) {
			return wantRejectedResponse()
		}
	}

	const upstream = await fetch(upstreamUrl, {
		method: 'POST',
		headers,
		body: Uint8Array.from(bodyResult.body),
		signal: AbortSignal.timeout(60_000),
	})

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: filterProxiedResponseHeaders(upstream.headers),
	})
}

async function proxyArtifactsReceivePack(input: {
	target: ProxiedGitTarget
	request: Request
}): Promise<Response> {
	buildAuthenticatedArtifactsRemote({
		remote: input.target.remote,
		token: input.target.tokenPlaintext,
	})
	const upstreamUrl = `${stripTrailingSlash(input.target.remote)}/git-receive-pack`
	const headers = new Headers(artifactsAuthHeaders(input.target.tokenPlaintext))
	const contentType = input.request.headers.get('Content-Type')
	if (contentType) headers.set('Content-Type', contentType)
	const accept = input.request.headers.get('Accept')
	if (accept) headers.set('Accept', accept)
	headers.set('Git-Protocol', 'version=1')

	const upstream = await fetch(upstreamUrl, {
		method: 'POST',
		headers,
		body: input.request.body,
		duplex: 'half',
		signal: AbortSignal.timeout(120_000),
	} as RequestInit & { duplex: 'half' })

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: filterProxiedResponseHeaders(upstream.headers),
	})
}

async function proxyArtifactsInfoRefs(input: {
	target: ProxiedGitTarget
	service: typeof gitUploadPackService | typeof gitReceivePackService
}) {
	buildAuthenticatedArtifactsRemote({
		remote: input.target.remote,
		token: input.target.tokenPlaintext,
	})
	const upstreamUrl = `${stripTrailingSlash(input.target.remote)}/info/refs?service=${input.service}`
	const headers = new Headers({
		...artifactsAuthHeaders(input.target.tokenPlaintext),
		Accept:
			input.service === gitReceivePackService
				? 'application/x-git-receive-pack-advertisement'
				: 'application/x-git-upload-pack-advertisement',
		'Git-Protocol': 'version=1',
	})

	if (!input.target.snapshotCommit || input.service === gitReceivePackService) {
		try {
			const upstream = await fetch(upstreamUrl, {
				method: 'GET',
				headers,
				signal: AbortSignal.timeout(15_000),
			})
			if (upstream.ok) {
				const contentType =
					input.service === gitReceivePackService
						? 'application/x-git-receive-pack-advertisement'
						: 'application/x-git-upload-pack-advertisement'
				return new Response(upstream.body, {
					status: 200,
					headers: {
						'Content-Type': contentType,
						'Cache-Control': 'no-store',
					},
				})
			}
		} catch {
			// Fall through to 503 via caller.
		}
		return serviceUnavailableResponse(
			'Failed to advertise refs for the artifact repository.',
		)
	}

	const localAdvertisement = () =>
		buildUploadPackAdvertisement({
			commit: input.target.snapshotCommit!,
			defaultBranch: input.target.defaultBranch,
			agent: input.target.agent,
		})

	try {
		const upstream = await fetch(upstreamUrl, {
			method: 'GET',
			headers,
			signal: AbortSignal.timeout(15_000),
		})
		if (upstream.ok) {
			const upstreamBody = new Uint8Array(await upstream.arrayBuffer())
			const advertisement = rewriteUploadPackAdvertisement({
				upstreamBody,
				commit: input.target.snapshotCommit,
				defaultBranch: input.target.defaultBranch,
				agent: input.target.agent,
			})
			return new Response(Uint8Array.from(advertisement), {
				status: 200,
				headers: {
					'Content-Type': 'application/x-git-upload-pack-advertisement',
					'Cache-Control': 'no-store',
				},
			})
		}
	} catch {
		// Fall through to a locally generated advertisement. Upload-pack still
		// needs Artifacts; advertising the published snapshot lets clients try.
	}

	return new Response(Uint8Array.from(localAdvertisement()), {
		status: 200,
		headers: {
			'Content-Type': 'application/x-git-upload-pack-advertisement',
			'Cache-Control': 'no-store',
		},
	})
}

/**
 * Read a long-lived `kody_at_…` password from Basic or Bearer Authorization.
 * Returns null when the header is absent (anonymous). Invalid present
 * credentials are distinguished via `{ kind: 'invalid' }`.
 */
export function readGitHttpCredential(
	authorization: string | null,
):
	| { kind: 'absent' }
	| { kind: 'invalid' }
	| { kind: 'api_token'; token: string } {
	if (!authorization?.trim()) return { kind: 'absent' }
	const bearer = readBearerApiToken(authorization)
	if (bearer) {
		if (parseApiToken(bearer)) {
			return { kind: 'api_token', token: bearer }
		}
		return { kind: 'invalid' }
	}
	const basic = /^Basic\s+(\S+)\s*$/i.exec(authorization)
	if (!basic?.[1]) return { kind: 'invalid' }
	try {
		const decoded = atob(basic[1])
		const colon = decoded.indexOf(':')
		const password = colon >= 0 ? decoded.slice(colon + 1) : decoded
		if (parseApiToken(password)) {
			return { kind: 'api_token', token: password }
		}
		return { kind: 'invalid' }
	} catch {
		return { kind: 'invalid' }
	}
}

async function resolveAuthenticatedGitTarget(input: {
	env: Env
	username: string
	kodyId: string
	apiToken: string
	needWrite: boolean
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<
	| { kind: 'ok'; target: ProxiedGitTarget }
	| { kind: 'not_found' }
	| { kind: 'unauthorized'; message?: string }
	| { kind: 'forbidden'; message: string }
	| { kind: 'unavailable'; message: string }
> {
	const authentication = await authenticateApiToken({
		db: input.env.APP_DB,
		token: input.apiToken,
	})
	if (!authentication.ok) {
		return {
			kind: 'unauthorized',
			message:
				authentication.reason === 'expired'
					? 'API token expired. Run `kody auth setup-git` again or mint a new token.'
					: authentication.reason === 'revoked'
						? 'API token was revoked. Run `kody auth setup-git` again or mint a new token.'
						: 'Invalid API token.',
		}
	}
	const { record } = authentication
	const authContext = await buildMcpUserContextFromGrantProps(input.env, {
		userId: record.user_id,
	})
	if (!authContext?.user) {
		return { kind: 'unauthorized', message: 'Invalid API token.' }
	}
	if (!authContext.emailVerified) {
		return {
			kind: 'forbidden',
			message:
				'Your account email address is not verified, so git access is disabled. Verify it from your account settings.',
		}
	}
	if (authContext.suspended) {
		return {
			kind: 'forbidden',
			message:
				'This account is suspended, so git access is disabled. Contact the operator of this Kody deployment to appeal.',
		}
	}
	if (
		isCredentialInvalidatedByStoredPasswordChange({
			issuedAtMs: getApiTokenIssuedAtMs(record),
			storedPasswordChangedAt: authContext.passwordChangedAt,
		})
	) {
		return {
			kind: 'unauthorized',
			message:
				'API token predates a password change. Mint a new one and run `kody auth setup-git` again.',
		}
	}

	const slid = slideApiTokenExpiry(record, new Date())
	if (slid) {
		const touch = touchApiToken({
			db: input.env.APP_DB,
			record: slid,
		}).catch(() => {})
		if (input.waitUntil) input.waitUntil(touch)
		else void touch
	}

	const access = await resolveGitHttpTargetAccess({
		env: input.env,
		viewer: authContext.user,
		ownerHandle: input.username,
		repoName: input.kodyId,
		scopes: record.scopes,
	})
	if (!access) {
		return { kind: 'not_found' }
	}
	if (input.needWrite && !access.canWrite) {
		return {
			kind: 'forbidden',
			message:
				access.resourceKind === 'package'
					? 'You can clone this package but not push. Need package:write on the package (token scope and org permission). Pushing a package moves live HEAD only; it does not publish.'
					: 'You can clone this repository but not push. Need package:write on the repo (token scope and org permission).',
		}
	}

	const repo = await resolveExistingArtifactSourceRepo(input.env, access.repoId)
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

	const artifactsScope = access.canWrite ? 'write' : 'read'
	let token: Awaited<ReturnType<typeof repo.createToken>>
	try {
		token = await repo.createToken(
			artifactsScope,
			authenticatedGitTokenTtlSeconds,
		)
	} catch {
		return {
			kind: 'unavailable',
			message: `Failed to mint a ${artifactsScope} token for the artifact repository.`,
		}
	}
	if (typeof token.plaintext !== 'string' || token.plaintext.length === 0) {
		return {
			kind: 'unavailable',
			message: 'Artifact access token was empty.',
		}
	}

	return {
		kind: 'ok',
		target: {
			username: access.ownerHandle,
			kodyId: access.repoName,
			defaultBranch: info.defaultBranch?.trim() || 'main',
			remote: info.remote,
			tokenPlaintext: token.plaintext,
			snapshotCommit: null,
			agent: authenticatedGitProxyAgent,
			canWrite: access.canWrite,
			resourceKind: access.resourceKind,
		},
	}
}

async function resolveGitHttpProxyTarget(input: {
	env: Env
	username: string
	kodyId: string
	authorization: string | null
	needWrite: boolean
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<
	| { kind: 'ok'; target: ProxiedGitTarget }
	| { kind: 'not_found' }
	| { kind: 'redirect'; to: string }
	| { kind: 'auth_required' }
	| { kind: 'unauthorized'; message?: string }
	| { kind: 'forbidden'; message: string }
	| { kind: 'unavailable'; message: string }
> {
	const credential = readGitHttpCredential(input.authorization)

	// Credentials present → access-based live HEAD (even for public listings).
	if (credential.kind === 'api_token') {
		return resolveAuthenticatedGitTarget({
			env: input.env,
			username: input.username,
			kodyId: input.kodyId,
			apiToken: credential.token,
			needWrite: input.needWrite,
			waitUntil: input.waitUntil,
		})
	}
	if (credential.kind === 'invalid') {
		return { kind: 'unauthorized', message: 'Invalid API token.' }
	}

	// Anonymous: write always challenges; read uses public snapshot when listed.
	if (input.needWrite) return { kind: 'auth_required' }

	const publicResolved = await resolvePublicGitTarget({
		env: input.env,
		username: input.username,
		kodyId: input.kodyId,
	})
	if (publicResolved.kind === 'ok') {
		return {
			kind: 'ok',
			target: toProxiedPublicTarget(publicResolved.target),
		}
	}
	if (publicResolved.kind === 'redirect') return publicResolved
	if (publicResolved.kind === 'unavailable') return publicResolved
	return { kind: 'auth_required' }
}

function stripTrailingSlash(value: string) {
	return value.endsWith('/') ? value.slice(0, -1) : value
}

function responseForGitResolve(
	resolved: Awaited<ReturnType<typeof resolveGitHttpProxyTarget>>,
) {
	switch (resolved.kind) {
		case 'ok':
			return null
		case 'redirect':
			return null
		case 'not_found':
			return notFoundResponse()
		case 'auth_required':
			return authRequiredResponse()
		case 'unauthorized':
			return authRequiredResponse(resolved.message ?? 'Authentication required')
		case 'forbidden':
			return forbiddenResponse(resolved.message)
		case 'unavailable':
			return serviceUnavailableResponse(resolved.message)
		default: {
			const exhaustive: never = resolved
			throw new Error(`Unexpected git resolve: ${String(exhaustive)}`)
		}
	}
}

/**
 * Smart HTTP Git proxy for `kody.codes/@owner/name.git`.
 * Anonymous clients get public community package listings (published snapshot).
 * Authenticated `kody_at_…` (Basic or Bearer) uses live HEAD with access-based
 * read/write: write Artifacts tokens when the caller can write, else read.
 * Push is allowed when the caller has `package:write`; package pushes move HEAD
 * only (no auto-publish). Existing Artifacts remotes are unchanged.
 */
export async function handlePublicPackageGitHttpRequest(
	request: Request,
	env: Env,
	waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response | null> {
	const url = new URL(request.url)
	const parsed = parsePublicPackageGitHttpPath(url.pathname)
	if (!parsed) return null

	const rate = await enforcePublicGitRateLimit({ env, request })
	if (!rate.allowed) {
		return rateLimitedResponse(
			rate.retryAfterSeconds ?? publicGitRateLimit.windowSeconds,
		)
	}

	if (parsed.kind === 'receive-pack') {
		if (request.method !== 'POST') {
			return methodNotAllowedResponse('POST')
		}
		const resolved = await resolveGitHttpProxyTarget({
			env,
			username: parsed.username,
			kodyId: parsed.kodyId,
			authorization: request.headers.get('Authorization'),
			needWrite: true,
			waitUntil,
		})
		if (resolved.kind === 'redirect') {
			const location = new URL(resolved.to, url.origin)
			location.pathname = `${location.pathname}/git-receive-pack`
			return Response.redirect(location.toString(), 301)
		}
		const early = responseForGitResolve(resolved)
		if (early) return early
		if (resolved.kind !== 'ok') return notFoundResponse()
		try {
			return await proxyArtifactsReceivePack({
				target: resolved.target,
				request,
			})
		} catch {
			return serviceUnavailableResponse(
				'Failed to proxy git-receive-pack to the artifact repository.',
			)
		}
	}

	if (parsed.kind === 'info-refs') {
		const service = url.searchParams.get('service')
		const needWrite = service === gitReceivePackService
		if (service !== gitUploadPackService && service !== gitReceivePackService) {
			return forbiddenResponse(
				'Smart HTTP only. Use ?service=git-upload-pack or ?service=git-receive-pack.',
			)
		}
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return methodNotAllowedResponse('GET, HEAD')
		}

		const resolved = await resolveGitHttpProxyTarget({
			env,
			username: parsed.username,
			kodyId: parsed.kodyId,
			authorization: request.headers.get('Authorization'),
			needWrite,
			waitUntil,
		})
		if (resolved.kind === 'redirect') {
			const location = new URL(resolved.to, url.origin)
			location.pathname = `${location.pathname}/info/refs`
			location.search = url.search
			return Response.redirect(location.toString(), 301)
		}
		const early = responseForGitResolve(resolved)
		if (early) return early
		if (resolved.kind !== 'ok') return notFoundResponse()

		const contentType =
			service === gitReceivePackService
				? 'application/x-git-receive-pack-advertisement'
				: 'application/x-git-upload-pack-advertisement'

		if (request.method === 'HEAD') {
			return new Response(null, {
				status: 200,
				headers: {
					'Content-Type': contentType,
					'Cache-Control': 'no-store',
				},
			})
		}

		try {
			return await proxyArtifactsInfoRefs({
				target: resolved.target,
				service:
					service === gitReceivePackService
						? gitReceivePackService
						: gitUploadPackService,
			})
		} catch {
			if (!resolved.target.snapshotCommit || needWrite) {
				return serviceUnavailableResponse(
					'Failed to advertise refs for the artifact repository.',
				)
			}
			const advertisement = buildUploadPackAdvertisement({
				commit: resolved.target.snapshotCommit,
				defaultBranch: resolved.target.defaultBranch,
				agent: resolved.target.agent,
			})
			return new Response(Uint8Array.from(advertisement), {
				status: 200,
				headers: {
					'Content-Type': 'application/x-git-upload-pack-advertisement',
					'Cache-Control': 'no-store',
				},
			})
		}
	}

	if (parsed.kind === 'upload-pack') {
		if (request.method !== 'POST') {
			return methodNotAllowedResponse('POST')
		}
		const resolved = await resolveGitHttpProxyTarget({
			env,
			username: parsed.username,
			kodyId: parsed.kodyId,
			authorization: request.headers.get('Authorization'),
			needWrite: false,
		})
		if (resolved.kind === 'redirect') {
			const location = new URL(resolved.to, url.origin)
			location.pathname = `${location.pathname}/git-upload-pack`
			return Response.redirect(location.toString(), 301)
		}
		const early = responseForGitResolve(resolved)
		if (early) return early
		if (resolved.kind !== 'ok') return notFoundResponse()
		try {
			return await proxyArtifactsUploadPack({
				target: resolved.target,
				request,
			})
		} catch {
			return serviceUnavailableResponse(
				'Failed to proxy git-upload-pack to the artifact repository.',
			)
		}
	}

	if (parsed.kind === 'repo-root') {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return methodNotAllowedResponse('GET, HEAD')
		}
		const resolved = await resolveGitHttpProxyTarget({
			env,
			username: parsed.username,
			kodyId: parsed.kodyId,
			authorization: request.headers.get('Authorization'),
			needWrite: false,
			waitUntil,
		})
		if (resolved.kind === 'redirect') {
			return Response.redirect(new URL(resolved.to, url.origin).toString(), 301)
		}
		const early = responseForGitResolve(resolved)
		if (early) return early
		if (resolved.kind !== 'ok') return notFoundResponse()
		const cloneUrl = `${url.origin}${getCommunityPackageGitHref({
			username: resolved.target.username,
			kodyId: resolved.target.kodyId,
		})}`
		const pushHint = resolved.target.canWrite
			? `Push with: git push ${cloneUrl}\n`
			: resolved.target.resourceKind === 'public'
				? 'Anonymous remotes are read-only (published snapshot). Authenticate with a kody_at_… token to use live HEAD; push requires package:write.\n'
				: 'This credential can clone but not push (needs package:write).\n'
		const body = `This is a Kody git repository.\nClone with: git clone ${cloneUrl}\n${pushHint}`
		return new Response(request.method === 'HEAD' ? null : body, {
			status: 200,
			headers: {
				'Cache-Control': 'no-store',
				'Content-Type': 'text/plain; charset=utf-8',
			},
		})
	}

	return notFoundResponse()
}
