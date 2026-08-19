// remix-skill: HTML + JSON /files controllers for community and account
// snapshots. Pages SSR the explorer; JSON companions use `?path=`.
import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { getOwnerUsernameFromListingName } from '#worker/community/public-urls.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
import { resolveCommunityPackageUrl } from '#worker/community/package-url.ts'
import {
	resolveCanonicalFilesPath,
	resolveCommunityFilesRoute,
} from '#app/community-package-route.ts'
import {
	loadAccountPackageFilesData,
	loadCommunityPackageFilesData,
	readPackageFilesSelectedPath,
} from '#app/package-files-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import {
	getCommunityPackageFilesHref,
	normalizePackageFilesPath,
} from '#universal/package-files.ts'
import { type routes } from '#universal/routes.ts'

function redirectToCanonicalPath(input: { path: string; url: URL }) {
	const destination = new URL(input.path, input.url)
	destination.search = input.url.search
	return new Response(null, {
		status: 301,
		headers: {
			location: destination.toString(),
			'cache-control': 'public, max-age=3600',
		},
	})
}

async function renderCommunityFilesPage(input: {
	request: Request
	env: Env
	listingId: string | null
	selectedPath: string
}) {
	const data = input.listingId
		? await loadCommunityPackageFilesData({
				env: input.env,
				listingId: input.listingId,
				selectedPath: input.selectedPath,
			})
		: null
	if (!data) {
		return renderAppPage({
			request: input.request,
			env: input.env,
			title: 'Package files not found',
			notFound: true,
			status: 404,
		})
	}
	return renderAppPage({
		request: input.request,
		env: input.env,
		title: `${data.title} files`,
		loaderData: { packageFiles: data },
	})
}

export function createCommunityPackageFilesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const url = new URL(request.url)
			const target = await resolveCommunityFilesRoute({ env, url })
			if (target?.kind === 'invalid-path') {
				return renderCommunityFilesPage({
					request,
					env,
					listingId: null,
					selectedPath: '',
				})
			}
			if (target?.kind === 'redirect') {
				return redirectToCanonicalPath({ path: target.to, url })
			}
			return renderCommunityFilesPage({
				request,
				env,
				listingId: target?.listingId ?? null,
				selectedPath: target?.selectedPath ?? '',
			})
		},
	} satisfies Action<typeof routes.communityPackageFiles>
}

export function createCommunityDetailFilesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const url = new URL(request.url)
			const target = await resolveCommunityFilesRoute({ env, url })
			if (target?.kind === 'invalid-path' || !target) {
				return renderCommunityFilesPage({
					request,
					env,
					listingId: null,
					selectedPath: '',
				})
			}
			if (target.kind === 'redirect') {
				return redirectToCanonicalPath({ path: target.to, url })
			}

			const listing = await getCommunityListingById(env.APP_DB, {
				listingId: target.listingId,
				includeDelisted: false,
			})
			const ownerUsername = listing
				? getOwnerUsernameFromListingName(listing.name)
				: null
			const canonicalPath =
				listing && ownerUsername
					? await resolveCanonicalFilesPath({
							env,
							listingId: listing.id,
							ownerUsername,
							kodyId: listing.kodyId,
							selectedPath: target.selectedPath,
						})
					: null
			if (canonicalPath && canonicalPath !== url.pathname) {
				return redirectToCanonicalPath({ path: canonicalPath, url })
			}

			return renderCommunityFilesPage({
				request,
				env,
				listingId: target.listingId,
				selectedPath: target.selectedPath,
			})
		},
	} satisfies Action<typeof routes.communityDetailFiles>
}

export function createCommunityPackageFilesApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const selectedPath = readPackageFilesSelectedPath(request.url)
			if (selectedPath == null) {
				return jsonResponse(
					{ ok: false, error: 'Package file path was invalid.' },
					400,
				)
			}
			const target = await resolveCommunityPackageUrl({
				db: env.APP_DB,
				username: params.username,
				kodyId: params.kodyId,
			})
			if (target?.kind === 'redirect') {
				return jsonResponse(
					{
						ok: false,
						error: 'Community package moved.',
						redirectTo: getCommunityPackageFilesHref({
							listingId: target.listingId,
							ownerUsername: target.username,
							kodyId: target.kodyId,
							relativePath: selectedPath,
						}),
					},
					404,
				)
			}
			const data = target
				? await loadCommunityPackageFilesData({
						env,
						listingId: target.listingId,
						selectedPath,
					})
				: null
			if (!data) {
				return jsonResponse(
					{ ok: false, error: 'Community package files not found.' },
					404,
				)
			}
			return jsonResponse(data)
		},
	} satisfies Action<typeof routes.communityPackageFilesApi>
}

export function createCommunityDetailFilesApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const selectedPath = readPackageFilesSelectedPath(request.url)
			if (selectedPath == null) {
				return jsonResponse(
					{ ok: false, error: 'Package file path was invalid.' },
					400,
				)
			}
			const data = await loadCommunityPackageFilesData({
				env,
				listingId: params.listingId,
				selectedPath,
			})
			if (!data) {
				return jsonResponse(
					{ ok: false, error: 'Community package files not found.' },
					404,
				)
			}
			return jsonResponse(data)
		},
	} satisfies Action<typeof routes.communityDetailFilesApi>
}

export function createAccountPackageFilesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) return user

			const selectedPath = normalizePackageFilesPath(
				typeof params.relativePath === 'string' ? params.relativePath : '',
			)
			if (selectedPath == null) {
				return renderAppPage({
					request,
					env,
					title: 'Package files not found',
					notFound: true,
					status: 404,
				})
			}

			const data = await loadAccountPackageFilesData({
				env,
				request,
				userId: user.mcpUser.userId,
				packageId: params.packageId,
				selectedPath,
			})
			if (!data) {
				return renderAppPage({
					request,
					env,
					title: 'Package files not found',
					notFound: true,
					status: 404,
				})
			}
			return renderAppPage({
				request,
				env,
				title: `${data.title} files`,
				loaderData: { packageFiles: data },
			})
		},
	} satisfies Action<typeof routes.accountPackageFiles>
}

export function createAccountPackageFilesApiHandler(env: Env) {
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
			const selectedPath = readPackageFilesSelectedPath(request.url)
			if (selectedPath == null) {
				return jsonResponse(
					{ ok: false, error: 'Package file path was invalid.' },
					400,
				)
			}
			const data = await loadAccountPackageFilesData({
				env,
				request,
				userId: user.mcpUser.userId,
				packageId: params.packageId,
				selectedPath,
			})
			if (!data) {
				return jsonResponse(
					{ ok: false, error: 'Package files not found.' },
					404,
				)
			}
			return jsonResponse(data)
		},
	} satisfies Action<typeof routes.accountPackageFilesApi>
}
