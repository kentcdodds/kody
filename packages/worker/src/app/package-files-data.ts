import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { getOwnerUsernameFromListingName } from '#worker/community/public-urls.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
import { readCommunitySnapshot } from '#worker/community/snapshot.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { getCommunityListingHref } from '#universal/community-links.ts'
import {
	buildPackageFilesView,
	getAccountPackageFilesHref,
	getCommunityPackageFilesHref,
	normalizePackageFilesPath,
	type PackageFilesView,
} from '#universal/package-files.ts'
import { type PackageFilesLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'

export function readPackageFilesSelectedPath(requestUrl: string) {
	const url = new URL(requestUrl, 'http://localhost')
	return normalizePackageFilesPath(url.searchParams.get('path'))
}

function toLoaderData(input: {
	title: string
	backHref: string
	backLabel: string
	filesBasePath: string
	view: PackageFilesView
}): PackageFilesLoaderData {
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
		content: input.view.content,
		contentPath: input.view.contentPath,
		contentKind: input.view.contentKind,
		language: input.view.language,
	}
}

export async function loadCommunityPackageFilesData(input: {
	env: Env
	listingId: string
	selectedPath: string
}): Promise<PackageFilesLoaderData | null> {
	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId: input.listingId,
		includeDelisted: false,
	})
	if (!listing) return null

	const ownerUsername = getOwnerUsernameFromListingName(listing.name)
	const filesBasePath = getCommunityPackageFilesHref({
		listingId: listing.id,
		ownerUsername,
		kodyId: listing.kodyId,
	})
	const snapshot = input.env.BUNDLE_ARTIFACTS_KV
		? await readCommunitySnapshot(input.env.BUNDLE_ARTIFACTS_KV, listing.id)
		: null
	const view = buildPackageFilesView({
		files: snapshot?.files ?? {},
		selectedPath: input.selectedPath,
	})
	if (!view) return null

	return toLoaderData({
		title: listing.name,
		backHref: getCommunityListingHref({
			listingId: listing.id,
			ownerUsername,
			kodyId: listing.kodyId,
		}),
		backLabel: 'Package listing',
		filesBasePath,
		view,
	})
}

export async function loadAccountPackageFilesData(input: {
	env: Env
	request: Request
	userId: string
	packageId: string
	selectedPath: string
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
		title: record.name,
		backHref: routes.accountPackageDetail.href({ packageId: record.id }),
		backLabel: 'Package',
		filesBasePath: getAccountPackageFilesHref({ packageId: record.id }),
		view,
	})
}
