import { type Action } from 'remix/router'
import { loadPackagePage } from '#app/package-page.ts'
import { resolveCommunityPackageUrl } from '#worker/community/package-url.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
import {
	buildPackageReadmeAssetHeaders,
	packageReadmeAssetCacheControl,
	packageReadmeAssetPrivateCacheControl,
	sniffPackageReadmeImageContentType,
} from '#worker/community/package-readme-asset.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { readArtifactFileAtCommit } from '#worker/repo/artifact-file.ts'
import {
	isPackageReadmeImagePath,
	resolvePackageReadmeImagePath,
} from '#universal/package-readme-images.ts'
import { isReservedPackageFilesKodyId } from '#universal/package-files.ts'
import { type routes } from '#universal/routes.ts'

function notFound() {
	return new Response('Not found', { status: 404 })
}

function selectedAssetPath(relativePath: string | undefined) {
	return resolvePackageReadmeImagePath(relativePath ?? '', '')
}

async function servePublishedPackageReadmeAsset(input: {
	env: Env
	sourceId: string
	commit: string
	relativePath: string
	cacheControl: string
}) {
	if (!isPackageReadmeImagePath(input.relativePath)) return notFound()
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source?.repo_id || !input.commit) return notFound()
	let bytes: Uint8Array | null
	try {
		bytes = await readArtifactFileAtCommit({
			env: input.env,
			repoId: source.repo_id,
			commit: input.commit,
			filePath: input.relativePath,
		})
	} catch (error) {
		console.error(
			'package-readme-asset-load-failed',
			input.sourceId,
			input.relativePath,
			error,
		)
		return notFound()
	}
	if (!bytes) return notFound()
	const contentType = sniffPackageReadmeImageContentType(
		bytes,
		input.relativePath,
	)
	if (!contentType) return notFound()
	return new Response(Uint8Array.from(bytes), {
		headers: buildPackageReadmeAssetHeaders({
			contentType,
			byteLength: bytes.byteLength,
			etag: `"${input.commit}:${input.relativePath}:${bytes.byteLength}"`,
			cacheControl: input.cacheControl,
		}),
	})
}

export function createCommunityPackageAssetHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			if (isReservedPackageFilesKodyId(params.kodyId)) return notFound()
			const relativePath = selectedAssetPath(params.relativePath)
			if (!relativePath) return notFound()

			const publicTarget = await resolveCommunityPackageUrl({
				db: env.APP_DB,
				username: params.username,
				kodyId: params.kodyId,
			})
			if (publicTarget) {
				const listing = await getCommunityListingById(env.APP_DB, {
					listingId: publicTarget.listingId,
					includeDelisted: false,
				})
				if (!listing) return notFound()
				return servePublishedPackageReadmeAsset({
					env,
					sourceId: listing.sourceId,
					commit: listing.pinnedCommit,
					relativePath,
					cacheControl: packageReadmeAssetCacheControl,
				})
			}

			const page = await loadPackagePage({
				env,
				request,
				username: params.username,
				kodyId: params.kodyId,
			})
			if (page.kind !== 'page' || !page.ownerPackage || !page.viewerIsOwner) {
				return notFound()
			}
			return servePublishedPackageReadmeAsset({
				env,
				sourceId: page.ownerPackage.sourceId,
				commit: page.ownerPackage.publishedCommit ?? '',
				relativePath,
				cacheControl: packageReadmeAssetPrivateCacheControl,
			})
		},
	} satisfies Action<typeof routes.communityPackageAsset>
}

export function createCommunityDetailAssetHandler(env: Env) {
	return {
		middleware: [],
		async handler({ params }) {
			const relativePath = selectedAssetPath(params.relativePath)
			if (!relativePath) return notFound()

			const listing = await getCommunityListingById(env.APP_DB, {
				listingId: params.listingId,
				includeDelisted: false,
			})
			if (!listing) return notFound()

			return servePublishedPackageReadmeAsset({
				env,
				sourceId: listing.sourceId,
				commit: listing.pinnedCommit,
				relativePath,
				cacheControl: packageReadmeAssetCacheControl,
			})
		},
	} satisfies Action<typeof routes.communityDetailAsset>
}
