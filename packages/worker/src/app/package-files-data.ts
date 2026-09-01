import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { getOwnerUsernameFromListingName } from '#worker/community/public-urls.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
import { readCommunitySnapshot } from '#worker/community/snapshot.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { readPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { getCommunityListingHref } from '#universal/community-links.ts'
import {
	buildPackageFilesView,
	fallbackDefaultBranchName,
	findDirectoryReadmePath,
	getCommunityPackageFilesHref,
	getPackageTreeHref,
	isPublicTreeDefaultRefAlias,
	normalizePackageFilesPath,
	type PackageFilesView,
} from '#universal/package-files.ts'
import { type PackageFilesLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { loadPackagePage } from '#app/package-page.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	highlightMarkdownFences,
	highlightSnippets,
} from '#app/highlight-code.ts'
import { plainHighlightedCode } from '#universal/highlighted-code.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'
import { resolveCachedArtifactSourceHead } from '#worker/repo/artifact-head-cache.ts'
import { readArtifactSourceSnapshot } from '#worker/repo/artifact-source-snapshot.ts'
import { recordServerTiming } from '#worker/request-context.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'

export function readPackageFilesSelectedPath(requestUrl: string) {
	const url = new URL(requestUrl, 'http://localhost')
	return normalizePackageFilesPath(url.searchParams.get('path'))
}

async function toLoaderData(input: {
	env: Env
	title: string
	backHref: string
	backLabel: string
	filesBasePath: string
	view: PackageFilesView
	serverTiming?: Array<ServerTimingEntry>
	username?: string
	kodyId?: string
	viewerIsOwner?: boolean
	isPrivate?: boolean
}): Promise<PackageFilesLoaderData> {
	const content = input.view.content
	const language = input.view.language
	const contentKind = input.view.contentKind
	const highlightOptions = { serverTiming: input.serverTiming }
	const contentFences =
		contentKind === 'markdown' && content
			? await highlightMarkdownFences(input.env, content, highlightOptions)
			: []
	const contentHighlighted =
		contentKind === 'code' && content
			? ((
					await highlightSnippets(
						input.env,
						[{ code: content, lang: language ?? 'plaintext' }],
						highlightOptions,
					)
				)[0] ?? plainHighlightedCode(content, language))
			: content
				? plainHighlightedCode(content, language)
				: null
	return {
		ok: true,
		title: input.title,
		backHref: input.backHref,
		backLabel: input.backLabel,
		filesBasePath: input.filesBasePath,
		selectedPath: input.view.selectedPath,
		kind: input.view.kind,
		paths: input.view.paths,
		children: input.view.children,
		content,
		contentPath: input.view.contentPath,
		contentKind,
		language,
		contentFences,
		contentHighlighted,
		username: input.username,
		kodyId: input.kodyId,
		viewerIsOwner: input.viewerIsOwner,
		isPrivate: input.isPrivate,
	}
}

async function readOptionalViewerUserId(input: { env: Env; request: Request }) {
	try {
		const user = await readAuthenticatedAppUser(input.request, input.env)
		return user?.mcpUser.userId ?? null
	} catch (error) {
		console.error(
			'Failed to resolve authenticated viewer for package files:',
			error,
		)
		return null
	}
}

export async function loadCommunityPackageFilesData(input: {
	env: Env
	request: Request
	listingId: string
	selectedPath: string
	ref?: string
	serverTiming?: Array<ServerTimingEntry>
}): Promise<PackageFilesLoaderData | null> {
	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId: input.listingId,
		includeDelisted: false,
	})
	if (!listing) return null

	const ownerUsername = getOwnerUsernameFromListingName(listing.name)
	const treeRef = input.ref?.trim() ?? ''
	// The source row and the viewer are independent reads.
	const [source, viewerUserId] = await Promise.all([
		getEntitySourceById(input.env.APP_DB, listing.sourceId),
		readOptionalViewerUserId({ env: input.env, request: input.request }),
	])
	const resolved = await resolvePublicTreeCommit({
		env: input.env,
		request: input.request,
		sourceRepoId: source?.repo_id ?? null,
		publishedCommit: source?.published_commit ?? listing.pinnedCommit,
		pinnedCommit: listing.pinnedCommit,
		ref: treeRef,
	})
	const resolvedCommit = resolved.commit
	const urlRef = isPublicTreeDefaultRefAlias(treeRef)
		? resolved.defaultBranch
		: treeRef
	const loaded = await loadPublicTreeFiles({
		env: input.env,
		request: input.request,
		listingId: listing.id,
		sourceId: listing.sourceId,
		sourceRepoId: source?.repo_id ?? null,
		commit: resolvedCommit,
		pinnedCommit: listing.pinnedCommit,
	})
	const requestedHex = /^[0-9a-f]{7,40}$/i.test(treeRef)
	if (
		requestedHex &&
		loaded.fromListingSnapshot &&
		resolvedCommit !== listing.pinnedCommit &&
		!(
			listing.pinnedCommit.startsWith(treeRef) ||
			treeRef.startsWith(listing.pinnedCommit)
		)
	) {
		return null
	}
	const files = loaded.files
	const filesBasePath = getCommunityPackageFilesHref({
		listingId: listing.id,
		ownerUsername,
		kodyId: listing.kodyId,
		ref: urlRef,
	})
	const view = buildPackageFilesView({
		files,
		selectedPath: input.selectedPath,
	})
	if (!view) return null

	return toLoaderData({
		env: input.env,
		title: listing.name,
		backHref: getCommunityListingHref({
			listingId: listing.id,
			ownerUsername,
			kodyId: listing.kodyId,
		}),
		backLabel: 'Code',
		filesBasePath,
		view,
		serverTiming: input.serverTiming,
		username: ownerUsername ?? undefined,
		kodyId: listing.kodyId,
		viewerIsOwner: viewerUserId === listing.ownerUserId,
		isPrivate: false,
	})
}

async function resolvePublicTreeCommit(input: {
	env: Env
	request: Request
	sourceRepoId: string | null
	publishedCommit: string | null
	pinnedCommit: string
	ref: string
}): Promise<{ commit: string | null; defaultBranch: string }> {
	const ref = input.ref.trim()
	let headCommit: string | null = null
	let defaultBranch = fallbackDefaultBranchName
	if (input.sourceRepoId) {
		try {
			const head = await resolveCachedArtifactSourceHead(
				input.env,
				input.sourceRepoId,
				{ request: input.request },
			)
			headCommit = head.commit
			defaultBranch = head.branch?.trim() || fallbackDefaultBranchName
		} catch {
			headCommit = input.publishedCommit
		}
	}
	if (isPublicTreeDefaultRefAlias(ref) || ref === defaultBranch) {
		return {
			commit: headCommit ?? input.publishedCommit ?? input.pinnedCommit,
			defaultBranch,
		}
	}
	if (headCommit && (headCommit === ref || headCommit.startsWith(ref))) {
		return { commit: headCommit, defaultBranch }
	}
	if (
		input.publishedCommit &&
		(input.publishedCommit === ref || input.publishedCommit.startsWith(ref))
	) {
		return { commit: input.publishedCommit, defaultBranch }
	}
	if (input.pinnedCommit === ref || input.pinnedCommit.startsWith(ref)) {
		return { commit: input.pinnedCommit, defaultBranch }
	}
	if (/^[0-9a-f]{7,40}$/i.test(ref)) {
		return { commit: ref, defaultBranch }
	}
	return {
		commit: headCommit ?? input.publishedCommit ?? input.pinnedCommit,
		defaultBranch,
	}
}

function loadPublicTreeFiles(input: {
	env: Env
	request: Request
	listingId?: string | null
	sourceId: string
	sourceRepoId: string | null
	commit: string | null
	pinnedCommit: string
}) {
	return recordServerTiming(
		'files',
		() => loadPublicTreeFilesUncached(input),
		input.request,
	)
}

async function loadPublicTreeFilesUncached(input: {
	env: Env
	listingId?: string | null
	sourceId: string
	sourceRepoId: string | null
	commit: string | null
	pinnedCommit: string
}): Promise<{
	files: Record<string, string>
	fromListingSnapshot: boolean
}> {
	const commit = input.commit
	if (commit && input.env.BUNDLE_ARTIFACTS_KV) {
		try {
			const snapshot = await readPublishedSourceSnapshot({
				env: input.env,
				sourceId: input.sourceId,
				publishedCommit: commit,
			})
			if (snapshot?.files) {
				return { files: snapshot.files, fromListingSnapshot: false }
			}
		} catch {
			// Fall through to git / listing snapshot.
		}
	}
	if (input.sourceRepoId && commit) {
		try {
			const treeSnapshot = await readArtifactSourceSnapshot({
				env: input.env,
				repoId: input.sourceRepoId,
				commit,
			})
			if (treeSnapshot?.files) {
				return { files: treeSnapshot.files, fromListingSnapshot: false }
			}
		} catch {
			// Fall through to the listing pin snapshot.
		}
	}
	if (input.listingId && input.env.BUNDLE_ARTIFACTS_KV) {
		const listingSnapshot = await readCommunitySnapshot(
			input.env.BUNDLE_ARTIFACTS_KV,
			input.listingId,
		)
		if (listingSnapshot?.files) {
			return { files: listingSnapshot.files, fromListingSnapshot: true }
		}
	}
	return { files: {}, fromListingSnapshot: Boolean(input.listingId) }
}

export async function loadAccountPackageFilesData(input: {
	env: Env
	request: Request
	userId: string
	username: string
	packageId: string
	selectedPath: string
	ref?: string
	serverTiming?: Array<ServerTimingEntry>
}): Promise<PackageFilesLoaderData | null> {
	const record = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.packageId,
	})
	if (!record) return null

	const source = await getEntitySourceById(input.env.APP_DB, record.sourceId)
	const treeRef = input.ref?.trim() ?? ''
	const resolved = await resolvePublicTreeCommit({
		env: input.env,
		request: input.request,
		sourceRepoId: source?.repo_id ?? null,
		publishedCommit: source?.published_commit ?? '',
		pinnedCommit: source?.published_commit ?? '',
		ref: treeRef,
	})
	const loaded = await loadPublicTreeFiles({
		env: input.env,
		request: input.request,
		sourceId: record.sourceId,
		sourceRepoId: source?.repo_id ?? null,
		commit: resolved.commit,
		pinnedCommit: source?.published_commit ?? '',
	})
	let files = loaded.files
	if (Object.keys(files).length === 0) {
		try {
			const packageSource = await loadPackageSourceBySourceId({
				env: input.env,
				baseUrl: getAppBaseUrl({
					env: input.env,
					requestUrl: input.request.url,
				}),
				userId: input.userId,
				sourceId: record.sourceId,
			})
			files = packageSource.files
		} catch {
			files = {}
		}
	}

	const view = buildPackageFilesView({
		files,
		selectedPath: input.selectedPath,
	})
	if (!view) return null

	const urlRef = isPublicTreeDefaultRefAlias(treeRef)
		? resolved.defaultBranch
		: treeRef || resolved.defaultBranch
	return toLoaderData({
		env: input.env,
		title: record.name,
		backHref: routes.communityPackage.href({
			username: input.username,
			kodyId: record.kodyId,
		}),
		backLabel: 'Code',
		filesBasePath: getPackageTreeHref({
			username: input.username,
			kodyId: record.kodyId,
			ref: urlRef,
		}),
		view,
		serverTiming: input.serverTiming,
		username: input.username,
		kodyId: record.kodyId,
		viewerIsOwner: true,
		isPrivate: record.isPrivate,
	})
}

export async function loadAccessiblePackageFilesData(input: {
	env: Env
	request: Request
	username: string
	kodyId: string
	selectedPath: string
	ref?: string
	serverTiming?: Array<ServerTimingEntry>
}): Promise<PackageFilesLoaderData | null> {
	const page = await loadPackagePage({
		env: input.env,
		request: input.request,
		username: input.username,
		kodyId: input.kodyId,
	})
	if (page.kind !== 'page') return null

	if (page.listing?.listing) {
		const data = await loadCommunityPackageFilesData({
			env: input.env,
			request: input.request,
			listingId: page.listing.listing.id,
			selectedPath: input.selectedPath,
			ref: input.ref,
			serverTiming: input.serverTiming,
		})
		if (!data) return null
		return {
			...data,
			viewerIsOwner: page.viewerIsOwner,
			isPrivate: page.ownerPackage?.isPrivate ?? false,
			username: page.username,
			kodyId: page.kodyId,
		}
	}

	if (!page.ownerPackage) return null
	const user = await readAuthenticatedAppUser(input.request, input.env)
	if (!user) return null
	return loadAccountPackageFilesData({
		env: input.env,
		request: input.request,
		userId: user.mcpUser.userId,
		username: page.username,
		packageId: page.ownerPackage.id,
		selectedPath: input.selectedPath,
		ref: input.ref,
		serverTiming: input.serverTiming,
	})
}

export async function loadOwnerPackageReadme(input: {
	env: Env
	request: Request
	userId: string
	sourceId: string
}): Promise<string | null> {
	try {
		const loaded = await loadPackageSourceBySourceId({
			env: input.env,
			baseUrl: getAppBaseUrl({
				env: input.env,
				requestUrl: input.request.url,
			}),
			userId: input.userId,
			sourceId: input.sourceId,
		})
		const path = findDirectoryReadmePath(loaded.files, '')
		if (!path) return null
		const content = loaded.files[path]?.trim()
		return content ? content : null
	} catch {
		return null
	}
}
