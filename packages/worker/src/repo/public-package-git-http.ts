import { checkRateLimit } from '#app/rate-limit.ts'
import { getRequestIp } from '#worker/audit-log.ts'
import { getCommunityPackageGitHref } from '#universal/community-links.ts'
import { resolveCommunityPackageUrl } from '#worker/community/package-url.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
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
} from '#worker/repo/git-pkt-line.ts'

const gitUploadPackService = 'git-upload-pack'
const gitReceivePackService = 'git-receive-pack'
const publicGitProxyAgent = 'kody-public-git'
const publicGitTokenTtlSeconds = 300
const publicGitRateLimit = { maxRequests: 120, windowSeconds: 60 } as const

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

function pushRejectedResponse() {
	return new Response(
		'Public package git remotes are read-only. Push (git-receive-pack) is not allowed.',
		{
			status: 403,
			headers: {
				'Cache-Control': 'no-store',
				'Content-Type': 'text/plain; charset=utf-8',
			},
		},
	)
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

async function proxyArtifactsUploadPack(input: {
	target: ResolvedPublicGitTarget
	request: Request
	fetchImpl?: typeof fetch
}) {
	const fetchImpl = input.fetchImpl ?? fetch
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
	headers.set(
		'Git-Protocol',
		input.request.headers.get('Git-Protocol') ?? 'version=1',
	)

	// Buffer the client body. Streaming duplex request bodies are awkward in
	// Workers typings and package packs are small enough to hold briefly.
	const body = await input.request.arrayBuffer()
	const upstream = await fetchImpl(upstreamUrl, {
		method: 'POST',
		headers,
		body,
		signal: AbortSignal.timeout(60_000),
	})

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: filterProxiedResponseHeaders(upstream.headers),
	})
}

async function proxyArtifactsInfoRefs(input: {
	target: ResolvedPublicGitTarget
	fetchImpl?: typeof fetch
}) {
	const fetchImpl = input.fetchImpl ?? fetch
	buildAuthenticatedArtifactsRemote({
		remote: input.target.remote,
		token: input.target.tokenPlaintext,
	})
	const upstreamUrl = `${stripTrailingSlash(input.target.remote)}/info/refs?service=${gitUploadPackService}`
	const headers = new Headers({
		...artifactsAuthHeaders(input.target.tokenPlaintext),
		Accept: 'application/x-git-upload-pack-advertisement',
		'Git-Protocol': 'version=1',
	})

	const localAdvertisement = () =>
		buildUploadPackAdvertisement({
			commit: input.target.snapshotCommit,
			defaultBranch: input.target.defaultBranch,
			agent: publicGitProxyAgent,
		})

	try {
		const upstream = await fetchImpl(upstreamUrl, {
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
				agent: publicGitProxyAgent,
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

function stripTrailingSlash(value: string) {
	return value.endsWith('/') ? value.slice(0, -1) : value
}

/**
 * Read-only smart HTTP Git proxy for public community package listings.
 * Private packages 404. Push (receive-pack) is rejected with 403.
 */
export async function handlePublicPackageGitHttpRequest(
	request: Request,
	env: Env,
	options?: { fetchImpl?: typeof fetch },
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
		return pushRejectedResponse()
	}

	if (parsed.kind === 'info-refs') {
		const service = url.searchParams.get('service')
		if (service === gitReceivePackService) {
			return pushRejectedResponse()
		}
		if (service !== gitUploadPackService) {
			return new Response(
				'Smart HTTP only. Use ?service=git-upload-pack (read-only).',
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

		const resolved = await resolvePublicGitTarget({
			env,
			username: parsed.username,
			kodyId: parsed.kodyId,
		})
		if (resolved.kind === 'not_found') return notFoundResponse()
		if (resolved.kind === 'redirect') {
			const location = new URL(resolved.to, url.origin)
			location.pathname = `${location.pathname}/info/refs`
			location.search = url.search
			return Response.redirect(location.toString(), 301)
		}
		if (resolved.kind === 'unavailable') {
			return serviceUnavailableResponse(resolved.message)
		}

		if (request.method === 'HEAD') {
			return new Response(null, {
				status: 200,
				headers: {
					'Content-Type': 'application/x-git-upload-pack-advertisement',
					'Cache-Control': 'no-store',
				},
			})
		}

		try {
			return await proxyArtifactsInfoRefs({
				target: resolved.target,
				fetchImpl: options?.fetchImpl,
			})
		} catch {
			const advertisement = buildUploadPackAdvertisement({
				commit: resolved.target.snapshotCommit,
				defaultBranch: resolved.target.defaultBranch,
				agent: publicGitProxyAgent,
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
		const resolved = await resolvePublicGitTarget({
			env,
			username: parsed.username,
			kodyId: parsed.kodyId,
		})
		if (resolved.kind === 'not_found') return notFoundResponse()
		if (resolved.kind === 'redirect') {
			const location = new URL(resolved.to, url.origin)
			location.pathname = `${location.pathname}/git-upload-pack`
			return Response.redirect(location.toString(), 301)
		}
		if (resolved.kind === 'unavailable') {
			return serviceUnavailableResponse(resolved.message)
		}
		try {
			return await proxyArtifactsUploadPack({
				target: resolved.target,
				request,
				fetchImpl: options?.fetchImpl,
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
		const resolved = await resolvePublicGitTarget({
			env,
			username: parsed.username,
			kodyId: parsed.kodyId,
		})
		if (resolved.kind === 'not_found') return notFoundResponse()
		if (resolved.kind === 'redirect') {
			return Response.redirect(new URL(resolved.to, url.origin).toString(), 301)
		}
		const cloneUrl = `${url.origin}${getCommunityPackageGitHref({
			username:
				resolved.kind === 'ok' ? resolved.target.username : parsed.username,
			kodyId: resolved.kind === 'ok' ? resolved.target.kodyId : parsed.kodyId,
		})}`
		const body = `This is a read-only public Kody package git repository.\nClone with: git clone ${cloneUrl}\n`
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
