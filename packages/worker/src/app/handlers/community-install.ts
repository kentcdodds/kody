import { z } from 'zod'
import { type Action } from 'remix/router'
import { waitUntil } from 'cloudflare:workers'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	buildInstallAdaptPrompt,
	buildInstallSuccessPrompt,
} from '#app/community-public.ts'
import { isOfficialCommunityListing } from '#universal/community-links.ts'
import { type routes } from '#universal/routes.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { installCommunityListing } from '#worker/community/install.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
import { EntitlementLimitError } from '#worker/entitlements/errors.ts'
import { getMcpUserPackageScope } from '#worker/package-registry/user-scope.ts'
import { resolveArtifactSourceHead } from '#worker/repo/artifacts.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { jsonResponse } from '#worker/json-response.ts'

const communityInstallPostSchema = z.object({
	acknowledged: z.boolean().optional(),
	kody_id: z.string().trim().min(1).optional(),
})

const thirdPartyInstallConfirmError =
	'This listing is from another account. Confirm to install it.'

export function createCommunityInstallApiPostHandler(env: Env) {
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
			const parsed = communityInstallPostSchema.safeParse(body)
			if (!parsed.success) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const listing = await getCommunityListingById(env.APP_DB, {
				listingId: params.listingId,
				includeDelisted: false,
			})
			if (!listing) {
				return jsonResponse(
					{ ok: false, error: 'Community listing not found.' },
					404,
				)
			}
			// Official `@kody/*` listings are first-party and skip confirm.
			// Third-party listings still need the explicit acknowledgement
			// the UI shows before calling this endpoint.
			const official = isOfficialCommunityListing({ name: listing.name })
			if (!official && parsed.data.acknowledged !== true) {
				return jsonResponse(
					{
						ok: false,
						requiresAcknowledgement: true,
						error: thirdPartyInstallConfirmError,
					},
					409,
				)
			}

			try {
				const expectedPackageScope = await getMcpUserPackageScope(
					env.APP_DB,
					user.mcpUser,
				)
				let expectedPinnedCommit = listing.pinnedCommit
				if (listing.sourceId) {
					const source = await getEntitySourceById(env.APP_DB, listing.sourceId)
					if (source?.repo_id) {
						try {
							const head = await resolveArtifactSourceHead(env, source.repo_id)
							if (head.commit) expectedPinnedCommit = head.commit
						} catch {
							// Fall back to the listing pin when HEAD cannot be read.
						}
					}
				}
				const result = await installCommunityListing({
					env,
					baseUrl: getAppBaseUrl({ env, requestUrl: request.url }),
					userId: user.mcpUser.userId,
					userEmail: user.email,
					expectedPackageScope,
					listingId: listing.id,
					kodyId: parsed.data.kody_id,
					// Bind the install to origin HEAD (the commit the fork copies)
					// so a concurrent push cannot activate content the user never saw.
					expectedPinnedCommit,
					// Projection already supports deferred search-index upsert and
					// retriever-cache refresh; without waitUntil those await on the
					// install response and stretch one-click / onboarding latency.
					waitUntil,
				})
				if (result.status === 'adaptation_required') {
					return jsonResponse({
						ok: true,
						status: result.status,
						packageId: result.packageId,
						sourceId: result.sourceId,
						targetName: result.targetName,
						failedChecks: result.failedChecks.map((check) => ({
							kind: check.kind,
							message: check.message,
						})),
						agentPrompt: buildInstallAdaptPrompt({
							targetName: result.targetName,
							sourceId: result.sourceId,
						}),
					})
				}
				return jsonResponse({
					ok: true,
					status: result.status,
					packageId: result.packageId,
					sourceId: result.sourceId,
					targetName: result.targetName,
					agentPrompt: buildInstallSuccessPrompt({
						targetName: result.targetName,
					}),
				})
			} catch (error) {
				if (
					error instanceof CommunityActionError ||
					error instanceof EntitlementLimitError
				) {
					return jsonResponse({ ok: false, error: error.message }, 400)
				}
				console.error('Community install failed:', error)
				return jsonResponse(
					{ ok: false, error: 'Unable to install this public package.' },
					500,
				)
			}
		},
	} satisfies Action<typeof routes.communityInstallApiPost>
}
