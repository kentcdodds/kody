import { jsonResponse as buildJsonResponse } from '#worker/json-response.ts'
import { z } from 'zod'
import { type Action } from 'remix/router'
import { toPublicCommunityListing } from '#app/community-public.ts'
import { loadCommunityDetailData } from '#app/community-data.ts'
import {
	resolveCanonicalListingPath,
	resolveCommunityListingRoute,
} from '#app/community-package-route.ts'
import {
	getCommunityPackageHref,
	resolveCommunityPackageUrl,
} from '#worker/community/package-url.ts'
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
import {
	getCommunityListingWithAggregates,
	reportCommunityListing,
} from '#worker/community/service.ts'
import { type CommunityListingRecord } from '#worker/community/types.ts'
import { parseOgTheme } from '#worker/og/palette.ts'

const reportReasonSchema = z
	.string()
	.trim()
	.min(1, 'Report reason is required.')
	.max(2000, 'Report reason must be at most 2000 characters.')

/**
 * A moved package keeps whatever the link carried: `followError` and friends
 * ride in the query string, and a redirect that drops them gets cached.
 *
 * `301` states which URL is canonical, but the destination is not permanent --
 * a username can be released and reclaimed by someone else -- so it is cached
 * for an hour rather than forever, and only for requests shaped like this one:
 * the same URL serves frame HTML when the target header is present.
 */
function redirectToCanonicalPath(input: { path: string; url: URL }) {
	const destination = new URL(input.path, input.url)
	destination.search = input.url.search
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
	if (!input.listingId || !detail) {
		return renderAppPage({
			request: input.request,
			env: input.env,
			title: 'Community package not found',
			notFound: true,
			status: 404,
		})
	}

	return renderAppPage({
		request: input.request,
		env: input.env,
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
				starCount: detail.listing.starCount,
				starredByViewer: detail.starredByViewer,
				viewerInstall: detail.viewerInstall,
			},
		},
	})
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
			const canonicalPath = detail
				? await resolveCanonicalListingPath({
						env,
						listingId,
						ownerUsername: detail.listing.ownerUsername,
						kodyId: detail.listing.kodyId,
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
		async handler({ request }) {
			const url = new URL(request.url)
			const frameResponse = await handleFrameRequest(request, env, url.pathname)
			if (frameResponse) return frameResponse

			const target = await resolveCommunityListingRoute({ env, url })
			if (target?.kind === 'redirect') {
				return redirectToCanonicalPath({ path: target.to, url })
			}

			return renderCommunityListingPage({
				request,
				env,
				listingId: target?.listingId ?? null,
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
			if (!detail) {
				return jsonResponse(
					request,
					{ ok: false, error: 'Community listing not found.' },
					404,
				)
			}

			return jsonResponse(request, detail)
		},
	} satisfies Action<typeof routes.communityDetailApi>
}

export function createCommunityPackageApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const target = await resolveCommunityPackageUrl({
				db: env.APP_DB,
				username: params.username,
				kodyId: params.kodyId,
			})
			// A stale pair reports where the package lives now instead of its data:
			// the client turns that into a document navigation so the visitor's URL
			// is corrected rather than kept on a name that no longer exists.
			if (target?.kind === 'redirect') {
				return jsonResponse(
					request,
					{
						ok: false,
						error: 'Community package moved.',
						redirectTo: getCommunityPackageHref(target),
					},
					404,
				)
			}

			const detail = target
				? await loadCommunityDetailData(env, request, target.listingId)
				: null
			if (!detail) {
				return jsonResponse(
					request,
					{ ok: false, error: 'Community listing not found.' },
					404,
				)
			}

			return jsonResponse(request, detail)
		},
	} satisfies Action<typeof routes.communityPackageApi>
}

/**
 * Resolve a satori-safe data URI for the package community icon. PNG and JPEG
 * bytes embed directly; WebP (unsupported by satori) and load failures fall
 * back to the same generated mark the public icon route uses.
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
		if (
			descriptor.contentType === 'image/png' ||
			descriptor.contentType === 'image/jpeg'
		) {
			const bytes = new Uint8Array(await object.arrayBuffer())
			return `data:${descriptor.contentType};base64,${bytesToBase64(bytes)}`
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
				starCount: publicListing.starCount,
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
) {
	const cacheLookup = getRequestDataCacheLookup(request)
	return buildJsonResponse(body, {
		status,
		headers: cacheLookup ? { 'X-Kody-Cache': cacheLookup } : undefined,
	})
}
