/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type RemixNode } from 'remix/ui'
import { z } from 'zod'
import { type Action } from 'remix/router'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import {
	buildForkPrompt,
	toPublicCommunityListing,
	truncateCommunityText,
} from '#app/community-public.ts'
import { loadCommunityDetailData } from '#app/community-data.ts'
import { CommunityDetailOgHead } from '#app/ssr-document.tsx'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { renderCommunityOgImage } from '#worker/community/og-image.ts'
import { getCommunityListingWithAggregates } from '#worker/community/service.ts'
import { reportCommunityListing } from '#worker/community/service.ts'

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

			const origin = getAppBaseUrl({ env, requestUrl: request.url })
			const canonicalUrl = `${origin}/community/${listingId}`
			const ogImageUrl = `${canonicalUrl}/og.png`
			const pageTitle = `${detail.listing.name} — Kody community package`
			const ogDescription = truncateCommunityText(
				detail.listing.description,
				200,
			)

			return renderAppPage({
				request,
				env,
				title: pageTitle,
				extraHead: (
					<CommunityDetailOgHead
						title={pageTitle}
						description={ogDescription}
						canonicalUrl={canonicalUrl}
						ogImageUrl={ogImageUrl}
					/>
				) as RemixNode,
				loaderData: { communityDetail: detail },
			})
		},
	} satisfies Action<typeof routes.communityDetail>
}

export function createCommunityDetailApiHandler(env: Env) {
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
				return jsonResponse(
					{ ok: false, error: 'Community listing not found.' },
					404,
				)
			}

			const user = await readAuthenticatedAppUser(request, env)
			return jsonResponse({
				ok: true,
				listing: toPublicCommunityListing(listing),
				loggedIn: Boolean(user),
				forkPrompt: buildForkPrompt({
					name: listing.name,
					listingId: listing.id,
				}),
			})
		},
	} satisfies Action<typeof routes.communityDetailApi>
}

export function createCommunityDetailOgImageHandler(env: Env) {
	return {
		middleware: [],
		async handler({ params }) {
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
			const png = await renderCommunityOgImage({
				name: publicListing.name,
				description: publicListing.description,
				ownerUsername: publicListing.ownerUsername,
				averageStars: publicListing.averageStars,
				ratingCount: publicListing.ratingCount,
				forkCount: publicListing.forkCount,
			})

			return new Response(png.buffer as ArrayBuffer, {
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
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object') {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const parsedReason = reportReasonSchema.safeParse(
				(body as Record<string, unknown>).reason,
			)
			if (!parsedReason.success) {
				return jsonResponse(
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
				return jsonResponse({ ok: true })
			} catch (error) {
				if (error instanceof CommunityActionError) {
					return jsonResponse({ ok: false, error: error.message }, 400)
				}
				console.error('Community report submission failed:', error)
				return jsonResponse(
					{ ok: false, error: 'Unable to submit report.' },
					500,
				)
			}
		},
	} satisfies Action<typeof routes.communityReportApiPost>
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'application/json; charset=utf-8',
		},
	})
}
