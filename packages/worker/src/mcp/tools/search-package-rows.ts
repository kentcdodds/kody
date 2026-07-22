import {
	buildPackageSearchProjection,
	type PackageSearchProjection,
} from '#worker/package-registry/manifest.ts'
import {
	buildPackageReadmeSnippet,
	type PackageReadmeSnippet,
} from '#worker/package-registry/package-readme.ts'
import { type listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'

import {
	type BuildSavedPackageSearchRowsResult,
	type PackageSearchRow,
} from './search-types.ts'

function buildLeanPackageSearchProjection(
	record: Awaited<ReturnType<typeof listSavedPackagesByUserId>>[number],
): PackageSearchProjection {
	return {
		name: record.name,
		kodyId: record.kodyId,
		description: record.description,
		tags: record.tags,
		searchText: record.searchText,
		hasApp: record.hasApp,
		isPrivate: record.isPrivate,
		appEntry: null,
		exports: [],
		jobs: [],
		services: [],
		subscriptions: [],
		retrievers: [],
	}
}

export async function buildSavedPackageSearchRows(input: {
	env: Env
	baseUrl: string
	userId: string
	records: Array<Awaited<ReturnType<typeof listSavedPackagesByUserId>>[number]>
}): Promise<BuildSavedPackageSearchRowsResult> {
	const rows = input.records.map((record) => {
		let hydration: Promise<{
			projection: PackageSearchProjection
			readmeSnippet: PackageReadmeSnippet | null
		}> | null = null
		return {
			record,
			projection: buildLeanPackageSearchProjection(record),
			readmeSnippet: null,
			hydrate: () => {
				hydration ??= loadPackageSourceBySourceId({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.userId,
					sourceId: record.sourceId,
				}).then((loaded) => ({
					projection: buildPackageSearchProjection(
						loaded.manifest,
						loaded.files,
					),
					readmeSnippet: buildPackageReadmeSnippet({
						files: loaded.files,
						maxChars: 1_000,
					}),
				}))
				return hydration
			},
		} satisfies PackageSearchRow
	})
	return { rows, warnings: [] }
}
