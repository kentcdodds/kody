import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { applyPackageShareMutation } from '#app/package-share-actions.ts'
import { loadPackageShareApproveChangesData } from '#app/package-share-approve-changes-data.ts'
import { loadPackagePage } from '#app/package-page.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { pinAcknowledgeBlockedByTruncatedReview } from '#worker/package-registry/share-diff.ts'
import {
	PackageShareAccessError,
	packageShareAccessErrorMessage,
} from '#worker/package-registry/share-grants.ts'
import { isPackageShareGrantsEnabled } from '#worker/package-registry/share-flag.ts'
import { type routes } from '#universal/routes.ts'

async function loadApproveChangesForPage(input: {
	env: Env
	request: Request
	username: string
	kodyId: string
	userId: string
}) {
	const page = await loadPackagePage({
		env: input.env,
		request: input.request,
		username: input.username,
		kodyId: input.kodyId,
	})
	if (page.kind !== 'page' || !page.shareGrant) {
		return null
	}
	return await loadPackageShareApproveChangesData({
		env: input.env,
		granteeUserId: input.userId,
		grantId: page.shareGrant.id,
		packageId: page.shareGrant.packageId,
	})
}

export function createCommunityPackageApproveChangesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}
			if (
				!(await isPackageShareGrantsEnabled({
					db: env.APP_DB,
					userId: user.userId,
				}))
			) {
				return renderAppPage({
					request,
					env,
					title: 'Approve shared package changes',
					notFound: true,
					status: 404,
				})
			}
			try {
				const packageShareApproveChanges = await loadApproveChangesForPage({
					env,
					request,
					username: params.username,
					kodyId: params.kodyId,
					userId: user.mcpUser.userId,
				})
				if (!packageShareApproveChanges) {
					return renderAppPage({
						request,
						env,
						title: 'Approve shared package changes',
						notFound: true,
						status: 404,
					})
				}
				return renderAppPage({
					request,
					env,
					title: 'Approve shared package changes',
					loaderData: { packageShareApproveChanges },
				})
			} catch {
				return renderAppPage({
					request,
					env,
					title: 'Approve shared package changes',
					notFound: true,
					status: 404,
					loaderData: {
						packageShareApproveChanges: undefined,
					},
				})
			}
		},
	} satisfies Action<typeof routes.communityPackageApproveChanges>
}

export function createCommunityPackageApproveChangesApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				try {
					const payload = await loadApproveChangesForPage({
						env,
						request,
						username: params.username,
						kodyId: params.kodyId,
						userId: user.mcpUser.userId,
					})
					if (!payload) {
						return jsonResponse({ ok: false, error: 'Not found.' }, 404)
					}
					return jsonResponse(payload)
				} catch (error) {
					if (!(error instanceof PackageShareAccessError)) {
						return jsonResponse(
							{ ok: false, error: 'Unable to load package changes.' },
							500,
						)
					}
					return jsonResponse(
						{ ok: false, error: packageShareAccessErrorMessage(error) },
						400,
					)
				}
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const page = await loadPackagePage({
				env,
				request,
				username: params.username,
				kodyId: params.kodyId,
			})
			if (page.kind !== 'page' || !page.shareGrant) {
				return jsonResponse({ ok: false, error: 'Not found.' }, 404)
			}
			const body = await request.json().catch(() => null)
			const bodyRecord =
				body && typeof body === 'object' && !Array.isArray(body)
					? (body as Record<string, unknown>)
					: null
			const switchToFollow = bodyRecord?.switchToFollow === true
			try {
				const review = await loadPackageShareApproveChangesData({
					env,
					granteeUserId: user.mcpUser.userId,
					grantId: page.shareGrant.id,
					packageId: page.shareGrant.packageId,
				})
				if (
					pinAcknowledgeBlockedByTruncatedReview(review.files, switchToFollow)
				) {
					return jsonResponse(
						{
							ok: false,
							error:
								'Published source is truncated, so this pin cannot be approved without a complete review. Switch the grant to follow, or ask the owner to split the source.',
						},
						400,
					)
				}
				const result = await applyPackageShareMutation({
					env,
					user,
					body: bodyRecord
						? {
								...bodyRecord,
								intent: 'acknowledge',
								grantId: page.shareGrant.id,
								publishedCommit: review.currentCommit,
							}
						: {
								intent: 'acknowledge',
								grantId: page.shareGrant.id,
								publishedCommit: review.currentCommit,
							},
					requestUrl: request.url,
				})
				if (!result.ok) {
					return jsonResponse(result, result.status)
				}
				return jsonResponse({ ok: true, grant: result.grant })
			} catch (error) {
				return jsonResponse(
					{ ok: false, error: packageShareAccessErrorMessage(error) },
					400,
				)
			}
		},
	} satisfies Action<typeof routes.communityPackageApproveChangesApi>
}
