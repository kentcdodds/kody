import { jsonResponse as buildJsonResponse } from '#worker/json-response.ts'
import { z } from 'zod'
import { type Action } from 'remix/router'
import { toPublicCommunityListing } from '#app/community-public.ts'
import { loadCommunityDetailData } from '#app/community-data.ts'
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

export function createCommunityDetailHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const listingId = params.listingId
			const frameResponse = await handleFrameRequest(
				request,
				env,
				new URL(request.url).pathname,
			)
			if (frameResponse) return frameResponse

			const detail = await loadCommunityDetailData(env, request, listingId)
			if (!detail) {
				return renderAppPage({
					request,
					env,
					title: 'Community package not found',
					notFound: true,
					status: 404,
				})
			}

			return renderAppPage({
				request,
				env,
				loaderData: {
					communityDetailShell: {
						ok: true,
						listingId,
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
		},
	} satisfies Action<typeof routes.communityDetail>
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
