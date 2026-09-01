import { jsonResponse as buildJsonResponse } from '#worker/json-response.ts'
import { z } from 'zod'
import { type Action } from 'remix/router'
import { toPublicCommunityListing } from '#app/community-public.ts'
import { loadCommunityDetailData } from '#app/community-data.ts'
import { loadPackagePage } from '#app/package-page.ts'
import { resolveCanonicalListingPath } from '#app/community-package-route.ts'
import { REMIX_FRAME_TARGET_HEADER } from '#universal/frame-constants.ts'
import { handleFrameRequest } from '#app/frame-registry.ts'
import '#app/frame-registrations.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'
import { getRequestDataCacheLookup } from '#app/request-cache.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import {
	getCommunityIconObject,
	renderCommunityIconFallbackPng,
} from '#worker/community/community-icon.ts'
import { convertIconRasterToPng } from '#worker/community/icon-fit.ts'
import {
	getCommunityListingWithAggregates,
	reportCommunityListing,
} from '#worker/community/service.ts'
import { type CommunityListingRecord } from '#worker/community/types.ts'
import { parseOgTheme } from '#worker/og/palette.ts'
import { highlightMarkdownFences } from '#app/highlight-code.ts'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'

const reportReasonSchema = z
	.string()
	.trim()
	.min(1, 'Report reason is required.')
	.max(2000, 'Report reason must be at most 2000 characters.')

/**
 * A moved package keeps whatever the link carried: query params ride along,
 * and a redirect that drops them gets cached.
 *
 * `301` states which URL is canonical, but the destination is not permanent --
 * a username can be released and reclaimed by someone else -- so it is cached
 * for an hour rather than forever, and only for requests shaped like this one:
 * the same URL serves frame HTML when the target header is present.
 */
function redirectToCanonicalPath(input: {
	path: string
	url: URL
	cache?: 'public' | 'private'
}) {
	const destination = new URL(input.path, input.url)
	destination.search = input.url.search
	const cache = input.cache ?? 'public'
	if (cache === 'private') {
		return new Response(null, {
			status: 302,
			headers: {
				location: destination.toString(),
				'cache-control': 'private, no-store',
				vary: `${REMIX_FRAME_TARGET_HEADER}, Cookie`,
			},
		})
	}
	return new Response(null, {
		status: 301,
		headers: {
			location: destination.toString(),
			'cache-control': 'public, max-age=3600',
			vary: REMIX_FRAME_TARGET_HEADER,
		},
	})
}

async function renderCommunityListingPage(input: {
	request: Request
	env: Env
	listingId: string | null
}) {
	const detail = input.listingId
		? await loadCommunityDetailData(input.env, input.request, input.listingId)
		: null
	if (!input.listingId || !detail?.listing) {
		return renderPackageNotFoundPage(input)
	}

	const serverTiming: Array<ServerTimingEntry> = []
	const readmeFences = await highlightReadmeFences(
		input.env,
		detail.listing.readmeContent,
		serverTiming,
	)

	return renderAppPage({
		request: input.request,
		env: input.env,
		serverTiming,
		loaderData: {
			communityDetailShell: {
				ok: true,
				listingId: input.listingId,
				name: detail.listing.name,
				description: detail.listing.description,
				forkPrompt: detail.forkPrompt,
				loggedIn: detail.loggedIn,
				viewerIsAdmin: detail.viewerIsAdmin,
				trusted: detail.listing.trusted,
				featured: detail.listing.featured,
				readmeContent: detail.listing.readmeContent,
				readmeFences,
				viewerInstall: detail.viewerInstall,
				ownerPackage: detail.ownerPackage,
				username: detail.username,
				invocationUrlOrigin: detail.invocationUrlOrigin,
			},
		},
	})
}

function renderPackageNotFoundPage(input: { request: Request; env: Env }) {
	return renderAppPage({
		request: input.request,
		env: input.env,
		title: 'Public package not found',
		notFound: true,
		status: 404,
	})
}

function renderPackageUnauthorizedPage(input: { request: Request; env: Env }) {
	return renderAppPage({
		request: input.request,
		env: input.env,
		title: 'Unauthorized',
		unauthorized: true,
		status: 401,
	})
}

async function highlightReadmeFences(
	env: Env,
	readmeContent: string | null,
	serverTiming?: Array<ServerTimingEntry>,
): Promise<Array<HighlightedCode>> {
	if (!readmeContent) return []
	return highlightMarkdownFences(env, readmeContent, { serverTiming })
}

/**
 * The listing-uuid URL predates the canonical `/@owner/kody-id` one and stays
 * addressable for every link already shared. Documents move to the canonical
 * URL; the JSON companion and the frame do not, so the client keeps working
 * for a visitor who is already on this path.
 */
export function createCommunityDetailHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const listingId = params.listingId
			const url = new URL(request.url)
			const frameResponse = await handleFrameRequest(request, env, url.pathname)
			if (frameResponse) return frameResponse

			const detail = await loadCommunityDetailData(env, request, listingId)
			const listing = detail?.listing
			const canonicalPath = listing
				? await resolveCanonicalListingPath({
						env,
						listingId,
						ownerUsername: listing.ownerUsername,
						kodyId: listing.kodyId,
					})
				: null
			// A listing whose canonical pair no longer resolves stays served here
			// rather than redirecting permanently at a dead URL.
			if (canonicalPath) {
				return redirectToCanonicalPath({ path: canonicalPath, url })
			}

			return renderCommunityListingPage({ request, env, listingId })
		},
	} satisfies Action<typeof routes.communityDetail>
}

export function createCommunityPackageHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const url = new URL(request.url)
			const frameResponse = await handleFrameRequest(request, env, url.pathname)
			if (frameResponse) return frameResponse

			const page = await loadPackagePage({
				env,
				request,
				username: params.username,
				kodyId: params.kodyId,
			})
			if (page.kind === 'redirect') {
				return redirectToCanonicalPath({
					path: page.to,
					url,
					cache: page.shared ? 'public' : 'private',
				})
			}
			if (page.kind === 'not_found') {
				return renderPackageNotFoundPage({ request, env })
			}
			if (page.kind === 'unauthorized') {
				return renderPackageUnauthorizedPage({ request, env })
			}

			if (page.listing?.listing) {
				const serverTiming: Array<ServerTimingEntry> = []
				const readmeFences = await highlightReadmeFences(
					env,
					page.listing.listing.readmeContent,
					serverTiming,
				)
				return renderAppPage({
					request,
					env,
					serverTiming,
					loaderData: {
						communityDetailShell: {
							ok: true,
							listingId: page.listing.listing.id,
							name: page.listing.listing.name,
							description: page.listing.listing.description,
							forkPrompt: page.listing.forkPrompt,
							loggedIn: page.listing.loggedIn,
							viewerIsAdmin: page.listing.viewerIsAdmin,
							trusted: page.listing.listing.trusted,
							featured: page.listing.listing.featured,
							readmeContent: page.listing.listing.readmeContent,
							readmeFences,
							viewerInstall: page.listing.viewerInstall,
							ownerPackage: page.ownerPackage,
							username: page.username,
							invocationUrlOrigin: page.invocationUrlOrigin,
						},
					},
				})
			}

			if (!page.ownerPackage) {
				return renderPackageNotFoundPage({ request, env })
			}

			return renderAppPage({
				request,
				env,
				title: page.ownerPackage.name,
				loaderData: {
					communityDetailShell: {
						ok: true,
						listingId: null,
						name: page.ownerPackage.name,
						description: page.ownerPackage.description,
						forkPrompt: '',
						loggedIn: page.loggedIn,
						viewerIsAdmin: false,
						trusted: false,
						featured: false,
						readmeContent: null,
						viewerInstall: null,
						ownerPackage: page.ownerPackage,
						username: page.username,
						invocationUrlOrigin: page.invocationUrlOrigin,
					},
				},
			})
		},
	} satisfies Action<typeof routes.communityPackage>
}

export function createCommunityDetailApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const listingId = params.listingId
			const detail = await loadCommunityDetailData(env, request, listingId)
			if (!detail?.listing) {
				return jsonResponse(
					request,
					{ ok: false, error: 'Community listing not found.' },
					404,
				)
			}

			const serverTiming: Array<ServerTimingEntry> = []
			return jsonResponse(
				request,
				{
					...detail,
					readmeFences: await highlightReadmeFences(
						env,
						detail.listing.readmeContent,
						serverTiming,
					),
				},
				200,
				serverTiming,
			)
		},
	} satisfies Action<typeof routes.communityDetailApi>
}

export function createCommunityPackageApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const page = await loadPackagePage({
				env,
				request,
				username: params.username,
				kodyId: params.kodyId,
			})
			if (page.kind === 'redirect') {
				return jsonResponse(
					request,
					{
						ok: false,
						error: 'Public package moved.',
						redirectTo: page.to,
					},
					404,
				)
			}
			if (page.kind === 'not_found') {
				return jsonResponse(
					request,
					{ ok: false, error: 'Community listing not found.' },
					404,
				)
			}
			if (page.kind === 'unauthorized') {
				return jsonResponse(request, { ok: false, error: 'Unauthorized.' }, 401)
			}

			const serverTiming: Array<ServerTimingEntry> = []
			const readmeFences = page.listing?.listing?.readmeContent
				? await highlightReadmeFences(
						env,
						page.listing.listing.readmeContent,
						serverTiming,
					)
				: []
			return jsonResponse(
				request,
				{
					ok: true,
					listing: page.listing?.listing ?? null,
					ownerProfilePublic: page.listing?.ownerProfilePublic ?? false,
					viewerIsOwner: page.viewerIsOwner,
					loggedIn: page.loggedIn,
					viewerIsAdmin: page.listing?.viewerIsAdmin ?? false,
					forkPrompt: page.listing?.forkPrompt ?? '',
					viewerInstall: page.listing?.viewerInstall ?? null,
					readmeFences,
					ownerPackage: page.ownerPackage,
					username: page.username,
					invocationUrlOrigin: page.invocationUrlOrigin,
				},
				200,
				serverTiming,
			)
		},
	} satisfies Action<typeof routes.communityPackageApi>
}

/**
 * Resolve a satori-safe data URI for the package community icon. PNG and JPEG
 * bytes embed directly; WebP is converted to PNG through Images because satori
 * cannot decode it. Load failures fall back to the generated mark.
 */
async function loadCommunityOgIconDataUri(input: {
	env: Env
	listing: CommunityListingRecord
}): Promise<string> {
	try {
		const { descriptor, object } = await getCommunityIconObject({
			env: input.env,
			listing: input.listing,
			iconCommit: input.listing.iconCommit,
		})
		const bytes = new Uint8Array(await object.arrayBuffer())
		if (
			descriptor.contentType === 'image/png' ||
			descriptor.contentType === 'image/jpeg'
		) {
			return `data:${descriptor.contentType};base64,${bytesToBase64(bytes)}`
		}
		if (descriptor.contentType === 'image/webp') {
			const png = await convertIconRasterToPng({
				images: input.env.IMAGES,
				bytes,
			})
			return `data:image/png;base64,${bytesToBase64(png)}`
		}
	} catch (error) {
		console.error('community-og-icon-load-failed', input.listing.id, error)
	}

	const fallback = await renderCommunityIconFallbackPng(input.listing.name)
	return `data:image/png;base64,${bytesToBase64(fallback)}`
}

export function createCommunityDetailOgImageHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const listingId = params.listingId
			const listing = await getCommunityListingWithAggregates({
				env,
				listingId,
				includeDelisted: false,
			})
			if (!listing) {
				return new Response('Not found', { status: 404 })
			}

			const publicListing = toPublicCommunityListing(listing)
			const iconDataUri = await loadCommunityOgIconDataUri({ env, listing })
			// `?theme=light` renders the pale variant; anything unrecognised
			// falls back to the default rather than erroring.
			const theme = parseOgTheme(new URL(request.url).searchParams.get('theme'))

			// Lazy import (sanctioned exception to the no-inline-imports rule):
			// the OG renderer pulls in satori and @resvg/resvg-wasm plus two wasm
			// binaries, which would otherwise bloat isolate cold starts for a
			// route that is only hit by social-media crawlers.
			const { renderCommunityOgImage } =
				await import('#worker/community/og-image.ts')
			const png = await renderCommunityOgImage({
				name: publicListing.name,
				description: publicListing.description,
				ownerUsername: publicListing.ownerUsername,
				averageStars: publicListing.averageStars,
				ratingCount: publicListing.ratingCount,
				forkCount: publicListing.forkCount,
				iconDataUri,
				theme,
				assets: env.ASSETS,
			})

			return new Response(png, {
				status: 200,
				headers: {
					'Cache-Control': 'public, max-age=3600',
					'Content-Type': 'image/png',
				},
			})
		},
	} satisfies Action<typeof routes.communityDetailOgImage>
}

export function createCommunityReportApiPostHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			if (request.method !== 'POST') {
				return jsonResponse(
					request,
					{ ok: false, error: 'Method not allowed.' },
					405,
				)
			}

			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse(request, { ok: false, error: 'Unauthorized.' }, 401)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object') {
				return jsonResponse(
					request,
					{ ok: false, error: 'Invalid request body.' },
					400,
				)
			}

			const parsedReason = reportReasonSchema.safeParse(
				(body as Record<string, unknown>).reason,
			)
			if (!parsedReason.success) {
				return jsonResponse(
					request,
					{
						ok: false,
						error:
							parsedReason.error.issues[0]?.message ?? 'Invalid report reason.',
					},
					400,
				)
			}

			try {
				await reportCommunityListing({
					env,
					userId: user.mcpUser.userId,
					listingId: params.listingId,
					reason: parsedReason.data,
				})
				return jsonResponse(request, { ok: true })
			} catch (error) {
				if (error instanceof CommunityActionError) {
					return jsonResponse(request, { ok: false, error: error.message }, 400)
				}
				console.error('Community report submission failed:', error)
				return jsonResponse(
					request,
					{ ok: false, error: 'Unable to submit report.' },
					500,
				)
			}
		},
	} satisfies Action<typeof routes.communityReportApiPost>
}

function jsonResponse(
	request: Request,
	body: Record<string, unknown>,
	status = 200,
	serverTiming?: Array<ServerTimingEntry>,
) {
	const cacheLookup = getRequestDataCacheLookup(request)
	return buildJsonResponse(body, {
		status,
		headers: cacheLookup ? { 'X-Kody-Cache': cacheLookup } : undefined,
		serverTiming,
	})
}
