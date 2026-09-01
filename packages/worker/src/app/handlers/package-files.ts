// remix-skill: HTML + JSON /files controllers. Pages SSR the explorer;
// JSON companions use `?path=`. Public and private packages share this
// path; visibility is enforced by loadPackagePage.
import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { getOwnerUsernameFromListingName } from '#worker/community/public-urls.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	resolveCanonicalFilesPath,
	resolveCommunityFilesRoute,
	treeHrefFromPackageHome,
} from '#app/community-package-route.ts'
import { loadPackagePage } from '#app/package-page.ts'
import {
	loadAccessiblePackageFilesData,
	loadCommunityPackageFilesData,
	readPackageFilesSelectedPath,
} from '#app/package-files-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import {
	getPackageTreeHref,
	normalizePackageFilesPath,
} from '#universal/package-files.ts'
import { type routes } from '#universal/routes.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'

function redirectToCanonicalPath(input: {
	path: string
	url: URL
	cache?: 'public' | 'private'
}) {
	const destination = new URL(input.path, input.url)
	destination.search = input.url.search
	if (input.cache === 'private') {
		return new Response(null, {
			status: 302,
			headers: {
				location: destination.toString(),
				'cache-control': 'private, no-store',
			},
		})
	}
	return new Response(null, {
		status: 301,
		headers: {
			location: destination.toString(),
			'cache-control': 'public, max-age=3600',
		},
	})
}

function renderFilesNotFound(input: {
	request: Request
	env: Env
	serverTiming?: Array<ServerTimingEntry>
}) {
	return renderAppPage({
		request: input.request,
		env: input.env,
		title: 'Package files not found',
		notFound: true,
		status: 404,
		serverTiming: input.serverTiming,
	})
}

function renderFilesUnauthorized(input: { request: Request; env: Env }) {
	return renderAppPage({
		request: input.request,
		env: input.env,
		title: 'Unauthorized',
		unauthorized: true,
		status: 401,
	})
}

async function renderListingFilesPage(input: {
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
				request: input.request,
				listingId: input.listingId,
				selectedPath: input.selectedPath,
				ref: input.ref,
				serverTiming,
			})
		: null
	if (!data) {
		return renderFilesNotFound({
			request: input.request,
			env: input.env,
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

async function renderPackageFilesPage(input: {
	request: Request
	env: Env
	username: string
	kodyId: string
	selectedPath: string
	ref?: string
}) {
	const serverTiming: Array<ServerTimingEntry> = []
	const data = await loadAccessiblePackageFilesData({
		env: input.env,
		request: input.request,
		username: input.username,
		kodyId: input.kodyId,
		selectedPath: input.selectedPath,
		ref: input.ref,
		serverTiming,
	})
	if (!data) {
		return renderFilesNotFound({
			request: input.request,
			env: input.env,
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

async function renderResolvedFilesPage(input: {
	request: Request
	env: Env
	url: URL
}) {
	const target = await resolveCommunityFilesRoute({
		env: input.env,
		url: input.url,
		request: input.request,
	})
	if (target?.kind === 'invalid-path' || !target) {
		return renderFilesNotFound({ request: input.request, env: input.env })
	}
	if (target.kind === 'unauthorized') {
		return renderFilesUnauthorized({ request: input.request, env: input.env })
	}
	if (target.kind === 'redirect') {
		return redirectToCanonicalPath({
			path: target.to,
			url: input.url,
			cache: target.shared ? 'public' : 'private',
		})
	}
	if (target.kind === 'package') {
		return renderPackageFilesPage({
			request: input.request,
			env: input.env,
			username: target.username,
			kodyId: target.kodyId,
			selectedPath: target.selectedPath,
			ref: target.ref,
		})
	}
	return renderListingFilesPage({
		request: input.request,
		env: input.env,
		listingId: target.listingId,
		selectedPath: target.selectedPath,
		ref: target.ref,
	})
}

export function createCommunityPackageFilesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return renderResolvedFilesPage({
				request,
				env,
				url: new URL(request.url),
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
			const target = await resolveCommunityFilesRoute({
				env,
				url,
				request,
			})
			if (target?.kind === 'invalid-path' || !target) {
				return renderFilesNotFound({ request, env })
			}
			if (target.kind === 'unauthorized') {
				return renderFilesUnauthorized({ request, env })
			}
			if (target.kind === 'redirect') {
				return redirectToCanonicalPath({
					path: target.to,
					url,
					cache: target.shared ? 'public' : 'private',
				})
			}
			if (target.kind === 'package') {
				return renderPackageFilesPage({
					request,
					env,
					username: target.username,
					kodyId: target.kodyId,
					selectedPath: target.selectedPath,
					ref: target.ref,
				})
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

			return renderListingFilesPage({
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
			const treeRef = url.searchParams.get('ref')?.trim() || ''
			const page = await loadPackagePage({
				env,
				request,
				username: params.username,
				kodyId: params.kodyId,
			})
			if (page.kind === 'redirect') {
				return jsonResponse(
					{
						ok: false,
						error: 'Package moved.',
						redirectTo: treeHrefFromPackageHome(page.to, {
							relativePath: selectedPath,
							ref: treeRef,
						}),
					},
					404,
				)
			}
			if (page.kind === 'unauthorized') {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			if (page.kind !== 'page') {
				return jsonResponse(
					{ ok: false, error: 'Package files not found.' },
					404,
				)
			}
			const serverTiming: Array<ServerTimingEntry> = []
			const data = await loadAccessiblePackageFilesData({
				env,
				request,
				username: page.username,
				kodyId: page.kodyId,
				selectedPath,
				ref: treeRef,
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
			const treeRef = new URL(request.url).searchParams.get('ref')?.trim() || ''
			const serverTiming: Array<ServerTimingEntry> = []
			const data = await loadCommunityPackageFilesData({
				env,
				request,
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
				return renderFilesNotFound({ request, env })
			}

			const record = await getSavedPackageById(env.APP_DB, {
				userId: user.mcpUser.userId,
				packageId: params.packageId,
			})
			if (!record) {
				return renderFilesNotFound({ request, env })
			}
			return redirectToCanonicalPath({
				path: getPackageTreeHref({
					username: user.username,
					kodyId: record.kodyId,
					relativePath: selectedPath,
				}),
				url: new URL(request.url),
				cache: 'private',
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
			const record = await getSavedPackageById(env.APP_DB, {
				userId: user.mcpUser.userId,
				packageId: params.packageId,
			})
			if (!record) {
				return jsonResponse(
					{ ok: false, error: 'Package files not found.' },
					404,
				)
			}
			return jsonResponse(
				{
					ok: false,
					error: 'Package files moved.',
					redirectTo: getPackageTreeHref({
						username: user.username,
						kodyId: record.kodyId,
						relativePath: selectedPath,
					}),
				},
				404,
			)
		},
	} satisfies Action<typeof routes.accountPackageFilesApi>
}
