import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { handleAccountPackageDeleteAction } from '#app/account-package-delete.ts'
import { handleAccountPackagePublishLockAction } from '#app/account-package-publish-lock.ts'
import { handleAccountPackageTokenAction } from '#app/account-package-tokens.ts'
import { handleAccountPackageVisibilityAction } from '#app/account-package-visibility.ts'
import { loadAccountPackagesData } from '#app/account-packages-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { CommunityActionError } from '#worker/community/errors.ts'
import { absorbCommunityForkUpstream } from '#worker/community/service.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { routes } from '#universal/routes.ts'

export function createAccountPackagesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const pathPackageId =
				typeof params === 'object' &&
				params !== null &&
				'packageId' in params &&
				typeof params.packageId === 'string'
					? params.packageId
					: undefined
			const url = new URL(request.url)
			if (pathPackageId) {
				const savedPackage = await getSavedPackageById(env.APP_DB, {
					userId: user.mcpUser.userId,
					packageId: pathPackageId,
				})
				if (!savedPackage) {
					return renderAppPage({
						request,
						env,
						title: 'Package not found',
						notFound: true,
						status: 404,
					})
				}
				const destination = new URL(
					routes.communityPackage.href({
						username: user.username,
						kodyId: savedPackage.kodyId,
					}),
					url,
				)
				destination.search = url.search
				return new Response(null, {
					status: 302,
					headers: { location: destination.toString() },
				})
			}

			const destination = new URL(
				routes.profile.href({ username: user.username }),
				url,
			)
			destination.search = url.search
			return new Response(null, {
				status: 302,
				headers: { location: destination.toString() },
			})
		},
	} satisfies Action<
		typeof routes.accountPackages | typeof routes.accountPackageDetail
	>
}

export function createAccountPackagesApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(
					await loadAccountPackagesData({ env, request, user }),
				)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object' || Array.isArray(body)) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const tokenResponse = await handleAccountPackageTokenAction({
				env,
				request,
				user,
				body,
			})
			if (tokenResponse) return tokenResponse

			const publishLockResponse = await handleAccountPackagePublishLockAction({
				env,
				request,
				user,
				body,
			})
			if (publishLockResponse) return publishLockResponse

			const visibilityResponse = await handleAccountPackageVisibilityAction({
				env,
				request,
				user,
				body,
			})
			if (visibilityResponse) return visibilityResponse

			const deleteResponse = await handleAccountPackageDeleteAction({
				env,
				user,
				body,
			})
			if (deleteResponse) return deleteResponse

			const action = readTrimmedStringOrEmpty(body, 'action')
			if (action === 'absorb-listing') {
				const packageId = readTrimmedStringOrEmpty(body, 'packageId')
				if (!packageId) {
					return jsonResponse(
						{ ok: false, error: 'Package id is required.' },
						400,
					)
				}
				try {
					await absorbCommunityForkUpstream({
						env,
						userId: user.mcpUser.userId,
						packageId,
					})
				} catch (error) {
					if (error instanceof CommunityActionError) {
						return jsonResponse({ ok: false, error: error.message }, 400)
					}
					throw error
				}
				return jsonResponse(
					await loadAccountPackagesData({ env, request, user }),
				)
			}

			return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
		},
	} satisfies Action<
		typeof routes.accountPackagesApi | typeof routes.accountPackagesApiPost
	>
}
