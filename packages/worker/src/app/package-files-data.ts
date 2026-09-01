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
	getAccountPackageFilesHref,
	getCommunityPackageFilesHref,
	isPublicTreeDefaultRefAlias,
	normalizePackageFilesPath,
	type PackageFilesView,
} from '#universal/package-files.ts'
import { type PackageFilesLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	highlightMarkdownFences,
	highlightSnippets,
} from '#app/highlight-code.ts'
import { plainHighlightedCode } from '#universal/highlighted-code.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'
import {
	readMockArtifactSnapshot,
	resolveArtifactSourceHead,
} from '#worker/repo/artifacts.ts'
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
	}
}

export async function loadCommunityPackageFilesData(input: {
	env: Env
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
	const source = await getEntitySourceById(input.env.APP_DB, listing.sourceId)
	const resolved = await resolvePublicTreeCommit({
		env: input.env,
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
		backLabel: 'Package listing',
		filesBasePath,
		view,
		serverTiming: input.serverTiming,
	})
}

async function resolvePublicTreeCommit(input: {
	env: Env
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
			const head = await resolveArtifactSourceHead(
				input.env,
				input.sourceRepoId,
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

async function loadPublicTreeFiles(input: {
	env: Env
	listingId: string
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
			const mock = await readMockArtifactSnapshot({
				env: input.env,
				repoId: input.sourceRepoId,
				commit,
			})
			if (mock?.files) {
				return { files: mock.files, fromListingSnapshot: false }
			}
		} catch {
			// Fall through to the listing pin snapshot.
		}
	}
	if (input.env.BUNDLE_ARTIFACTS_KV) {
		const listingSnapshot = await readCommunitySnapshot(
			input.env.BUNDLE_ARTIFACTS_KV,
			input.listingId,
		)
		if (listingSnapshot?.files) {
			return { files: listingSnapshot.files, fromListingSnapshot: true }
		}
	}
	return { files: {}, fromListingSnapshot: true }
}

export async function loadAccountPackageFilesData(input: {
	env: Env
	request: Request
	userId: string
	username: string
	packageId: string
	selectedPath: string
	serverTiming?: Array<ServerTimingEntry>
}): Promise<PackageFilesLoaderData | null> {
	const record = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.packageId,
	})
	if (!record) return null

	let files: Record<string, string> = {}
	try {
		const loaded = await loadPackageSourceBySourceId({
			env: input.env,
			baseUrl: getAppBaseUrl({ env: input.env, requestUrl: input.request.url }),
			userId: input.userId,
			sourceId: record.sourceId,
		})
		files = loaded.files
	} catch {
		files = {}
	}

	const view = buildPackageFilesView({
		files,
		selectedPath: input.selectedPath,
	})
	if (!view) return null

	return toLoaderData({
		env: input.env,
		title: record.name,
		backHref: routes.communityPackage.href({
			username: input.username,
			kodyId: record.kodyId,
		}),
		backLabel: 'Package',
		filesBasePath: getAccountPackageFilesHref({ packageId: record.id }),
		view,
		serverTiming: input.serverTiming,
	})
}
