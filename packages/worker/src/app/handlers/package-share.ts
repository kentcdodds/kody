import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { applyPackageShareMutation } from '#app/package-share-actions.ts'
import { loadPackagePage } from '#app/package-page.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	hydratePackageShareGrantViews,
	listPackageShareGrantsByPackageId,
	toPackageShareGrantLoaderView,
} from '#worker/package-registry/share-grants.ts'
import { isPackageShareGrantsEnabled } from '#worker/package-registry/share-flag.ts'
import { type routes } from '#universal/routes.ts'

export function createCommunityPackageShareApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			if (
				!(await isPackageShareGrantsEnabled({
					db: env.APP_DB,
					userId: user.userId,
				}))
			) {
				return jsonResponse({ ok: false, error: 'Not found.' }, 404)
			}

			const page = await loadPackagePage({
				env,
				request,
				username: params.username,
				kodyId: params.kodyId,
			})
			if (page.kind === 'redirect') {
				return jsonResponse(
					{ ok: false, error: 'Public package moved.', redirectTo: page.to },
					404,
				)
			}
			if (page.kind === 'not_found') {
				return jsonResponse({ ok: false, error: 'Package not found.' }, 404)
			}
			if (page.kind === 'unauthorized') {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			const packageId =
				page.ownerPackage?.id ?? page.shareGrant?.packageId ?? null

			if (request.method === 'GET') {
				if (page.viewerIsOwner && packageId) {
					const grants = await listPackageShareGrantsByPackageId(
						env.APP_DB,
						packageId,
					)
					const views = await hydratePackageShareGrantViews(env.APP_DB, grants)
					return jsonResponse({
						ok: true,
						grants: views.map(toPackageShareGrantLoaderView),
						shareGrant: null,
					})
				}
				return jsonResponse({
					ok: true,
					grants: page.shareGrant ? [page.shareGrant] : [],
					shareGrant: page.shareGrant,
				})
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			const result = await applyPackageShareMutation({
				env,
				user,
				body,
				packageId: packageId ?? undefined,
				requestUrl: request.url,
			})
			if (!result.ok) {
				return jsonResponse(result, result.status)
			}
			return jsonResponse({ ok: true, grant: result.grant })
		},
	} satisfies Action<typeof routes.communityPackageShareApi>
}
