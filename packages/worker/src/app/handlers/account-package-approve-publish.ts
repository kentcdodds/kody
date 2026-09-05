import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAccountPackageApprovePublishData } from '#app/account-package-publish-lock.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadPackagePage } from '#app/package-page.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { routes } from '#universal/routes.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'

function readPackageId(params: unknown): string | null {
	if (
		typeof params === 'object' &&
		params !== null &&
		'packageId' in params &&
		typeof params.packageId === 'string' &&
		params.packageId.trim()
	) {
		return params.packageId.trim()
	}
	return null
}

function readCanonicalPackageParams(
	params: unknown,
): { username: string; kodyId: string } | null {
	if (
		typeof params !== 'object' ||
		params === null ||
		!('username' in params) ||
		typeof params.username !== 'string' ||
		!('kodyId' in params) ||
		typeof params.kodyId !== 'string'
	) {
		return null
	}
	return { username: params.username, kodyId: params.kodyId }
}

function redirectToCanonicalApproval(input: {
	request: Request
	username: string
	kodyId: string
}) {
	const requestUrl = new URL(input.request.url)
	const destination = new URL(
		routes.communityPackageApprovePublish.href({
			username: input.username,
			kodyId: input.kodyId,
		}),
		requestUrl,
	)
	destination.search = requestUrl.search
	return new Response(null, {
		status: 302,
		headers: {
			location: destination.toString(),
			'cache-control': 'private, no-store',
		},
	})
}

export function createAccountPackageApprovePublishHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const packageId = readPackageId(params)
			if (packageId) {
				const savedPackage = await getSavedPackageById(env.APP_DB, {
					userId: user.mcpUser.userId,
					packageId,
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
				return redirectToCanonicalApproval({
					request,
					username: user.username,
					kodyId: savedPackage.kodyId,
				})
			}

			const canonicalParams = readCanonicalPackageParams(params)
			if (!canonicalParams) {
				return new Response('Not found', { status: 404 })
			}
			const page = await loadPackagePage({
				env,
				request,
				username: canonicalParams.username,
				kodyId: canonicalParams.kodyId,
			})
			if (page.kind === 'redirect') {
				const destination = new URL(`${page.to}/approve-publish`, request.url)
				destination.search = new URL(request.url).search
				return new Response(null, {
					status: 302,
					headers: {
						location: destination.toString(),
						'cache-control': 'private, no-store',
					},
				})
			}
			if (page.kind !== 'page' || !page.viewerIsOwner || !page.ownerPackage) {
				return renderAppPage({
					request,
					env,
					title: 'Package not found',
					notFound: true,
					status: 404,
				})
			}
			const accountPackageApprovePublish =
				await loadAccountPackageApprovePublishData({
					env,
					request,
					user,
					packageId: page.ownerPackage.id,
				})
			if (!accountPackageApprovePublish.ok) {
				return new Response(accountPackageApprovePublish.error, { status: 404 })
			}
			return renderAppPage({
				request,
				env,
				title: 'Approve package publish',
				loaderData: { accountPackageApprovePublish },
			})
		},
	} satisfies Action<
		| typeof routes.accountPackageApprovePublish
		| typeof routes.communityPackageApprovePublish
	>
}

export function createAccountPackageApprovePublishApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			if (request.method !== 'GET') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}
			let packageId = readPackageId(params)
			const canonicalParams = readCanonicalPackageParams(params)
			if (
				!packageId &&
				canonicalParams &&
				canonicalParams.username === user.username
			) {
				const savedPackage = await getSavedPackageByKodyId(env.APP_DB, {
					userId: user.mcpUser.userId,
					kodyId: canonicalParams.kodyId,
				})
				packageId = savedPackage?.id ?? null
			}
			if (!packageId) {
				return jsonResponse(
					{ ok: false, error: 'Package id is required.' },
					400,
				)
			}
			const payload = await loadAccountPackageApprovePublishData({
				env,
				request,
				user,
				packageId,
			})
			if (!payload.ok) {
				return jsonResponse(payload, 404)
			}
			return jsonResponse(payload)
		},
	} satisfies Action<
		| typeof routes.accountPackageApprovePublishApi
		| typeof routes.communityPackageApprovePublishApi
	>
}
