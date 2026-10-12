import { viewerCanManageSavedPackage } from '#app/package-viewer-access.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { createMatcher } from 'remix/route-pattern/match'
import {
	handleAccountPackageInternetVisibleAction,
	loadAccountPackageApproveCapabilitiesData,
} from '#app/account-package-capability-approval.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadPackagePage } from '#app/package-page.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { routes } from '#universal/routes.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'

const communityPackageMatcher = createMatcher(routes.communityPackage.pattern)

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
		routes.communityPackageApproveCapabilities.href({
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

function redirectToCanonicalApprovalApi(input: {
	request: Request
	packageHref: string
}) {
	const match = communityPackageMatcher.match(
		new URL(input.packageHref, input.request.url),
	)
	if (!match) return null
	const requestUrl = new URL(input.request.url)
	const destination = new URL(
		routes.communityPackageApproveCapabilitiesApi.href({
			username: match.params.username,
			kodyId: match.params.kodyId,
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

export function createAccountPackageApproveCapabilitiesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const packageId = readPackageId(params)
			if (packageId) {
				const savedPackage = await getSavedPackageByIdInAnyOrg(
					env.APP_DB,
					packageId,
				)
				if (
					!savedPackage ||
					!(await viewerCanManageSavedPackage({
						env,
						viewer: user.mcpUser,
						ownerId: savedPackage.userId,
						packageId: savedPackage.id,
					}))
				) {
					return renderAppPage({
						request,
						env,
						title: 'Package not found',
						notFound: true,
						status: 404,
					})
				}
				const binding = await loadOrgBindingForOrg(
					env.APP_DB,
					user.mcpUser.userId,
					savedPackage.userId,
				)
				return redirectToCanonicalApproval({
					request,
					username: binding?.org.slug ?? user.username,
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
				const destination = new URL(
					`${page.to}/approve-capabilities`,
					request.url,
				)
				destination.search = new URL(request.url).search
				return new Response(null, {
					status: 302,
					headers: {
						location: destination.toString(),
						'cache-control': 'private, no-store',
					},
				})
			}
			if (page.kind !== 'page' || !page.viewerCanManage || !page.ownerPackage) {
				return renderAppPage({
					request,
					env,
					title: 'Package not found',
					notFound: true,
					status: 404,
				})
			}
			const accountPackageApproveCapabilities =
				await loadAccountPackageApproveCapabilitiesData({
					env,
					request,
					user,
					packageId: page.ownerPackage.id,
				})
			if (!accountPackageApproveCapabilities.ok) {
				return new Response(accountPackageApproveCapabilities.error, {
					status: 404,
				})
			}
			return renderAppPage({
				request,
				env,
				title: 'Approve internet-visible capabilities',
				loaderData: { accountPackageApproveCapabilities },
			})
		},
	} satisfies Action<
		| typeof routes.accountPackageApproveCapabilities
		| typeof routes.communityPackageApproveCapabilities
	>
}

export function createAccountPackageApproveCapabilitiesApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'POST') {
				const body = await request.json().catch(() => null)
				if (!body || typeof body !== 'object' || Array.isArray(body)) {
					return jsonResponse(
						{ ok: false, error: 'Invalid request body.' },
						400,
					)
				}
				const response = await handleAccountPackageInternetVisibleAction({
					env,
					request,
					user,
					body: {
						...body,
						action: 'approve-capabilities',
					},
				})
				return (
					response ??
					jsonResponse({ ok: false, error: 'Unsupported action.' }, 400)
				)
			}

			if (request.method !== 'GET') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			let packageId = readPackageId(params)
			const canonicalParams = readCanonicalPackageParams(params)
			if (!packageId && canonicalParams) {
				const page = await loadPackagePage({
					env,
					request,
					username: canonicalParams.username,
					kodyId: canonicalParams.kodyId,
				})
				if (page.kind === 'redirect') {
					const redirect = redirectToCanonicalApprovalApi({
						request,
						packageHref: page.to,
					})
					if (redirect) return redirect
				}
				if (page.kind === 'page' && page.viewerCanManage && page.ownerPackage) {
					packageId = page.ownerPackage.id
				}
			}
			if (!packageId) {
				return jsonResponse(
					{ ok: false, error: 'Package id is required.' },
					400,
				)
			}
			const payload = await loadAccountPackageApproveCapabilitiesData({
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
		| typeof routes.accountPackageApproveCapabilitiesApi
		| typeof routes.communityPackageApproveCapabilitiesApi
	>
}
