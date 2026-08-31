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
import { type ServerTimingEntry } from '#worker/server-timing.ts'

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
	ref?: string
}) {
	const serverTiming: Array<ServerTimingEntry> = []
	const data = input.listingId
		? await loadCommunityPackageFilesData({
				env: input.env,
				listingId: input.listingId,
				selectedPath: input.selectedPath,
				ref: input.ref,
				serverTiming,
			})
		: null
	if (!data) {
		return renderAppPage({
			request: input.request,
			env: input.env,
			title: 'Package files not found',
			notFound: true,
			status: 404,
			serverTiming,
		})
	}
	return renderAppPage({
		request: input.request,
		env: input.env,
		title: `${data.title} files`,
		loaderData: { packageFiles: data },
		serverTiming,
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
				ref: target?.kind === 'listing' ? target.ref : undefined,
			})
		},
	} satisfies Action<typeof routes.communityPackageFiles>
}

export function createCommunityPackageTreeHandler(env: Env) {
	return createCommunityPackageFilesHandler(env) as unknown as Action<
		typeof routes.communityPackageTree
	>
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
							ref: target.ref,
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
				ref: target.ref,
			})
		},
	} satisfies Action<typeof routes.communityDetailFiles>
}

export function createCommunityPackageFilesApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const url = new URL(request.url)
			const selectedPath = readPackageFilesSelectedPath(request.url)
			if (selectedPath == null) {
				return jsonResponse(
					{ ok: false, error: 'Package file path was invalid.' },
					400,
				)
			}
			const treeRef = url.searchParams.get('ref')?.trim() || 'HEAD'
			const target = await resolveCommunityPackageUrl({
				db: env.APP_DB,
				username: params.username,
				kodyId: params.kodyId,
			})
			if (target?.kind === 'redirect') {
				return jsonResponse(
					{
						ok: false,
						error: 'Public package moved.',
						redirectTo: getCommunityPackageFilesHref({
							listingId: target.listingId,
							ownerUsername: target.username,
							kodyId: target.kodyId,
							relativePath: selectedPath,
							ref: treeRef,
						}),
					},
					404,
				)
			}
			const serverTiming: Array<ServerTimingEntry> = []
			const data = target
				? await loadCommunityPackageFilesData({
						env,
						listingId: target.listingId,
						selectedPath,
						ref: treeRef,
						serverTiming,
					})
				: null
			if (!data) {
				return jsonResponse(
					{ ok: false, error: 'Public package files not found.' },
					404,
				)
			}
			return jsonResponse(data, { serverTiming })
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
			const treeRef =
				new URL(request.url).searchParams.get('ref')?.trim() || 'HEAD'
			const serverTiming: Array<ServerTimingEntry> = []
			const data = await loadCommunityPackageFilesData({
				env,
				listingId: params.listingId,
				selectedPath,
				ref: treeRef,
				serverTiming,
			})
			if (!data) {
				return jsonResponse(
					{ ok: false, error: 'Public package files not found.' },
					404,
				)
			}
			return jsonResponse(data, { serverTiming })
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

			const serverTiming: Array<ServerTimingEntry> = []
			const data = await loadAccountPackageFilesData({
				env,
				request,
				userId: user.mcpUser.userId,
				username: user.username,
				packageId: params.packageId,
				selectedPath,
				serverTiming,
			})
			if (!data) {
				return renderAppPage({
					request,
					env,
					title: 'Package files not found',
					notFound: true,
					status: 404,
					serverTiming,
				})
			}
			return renderAppPage({
				request,
				env,
				title: `${data.title} files`,
				loaderData: { packageFiles: data },
				serverTiming,
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
			const serverTiming: Array<ServerTimingEntry> = []
			const data = await loadAccountPackageFilesData({
				env,
				request,
				userId: user.mcpUser.userId,
				username: user.username,
				packageId: params.packageId,
				selectedPath,
				serverTiming,
			})
			if (!data) {
				return jsonResponse(
					{ ok: false, error: 'Package files not found.' },
					404,
				)
			}
			return jsonResponse(data, { serverTiming })
		},
	} satisfies Action<typeof routes.accountPackageFilesApi>
}
