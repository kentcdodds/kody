/**
 * Computing, storing, and loading a package's credential needs closure
 * (ADR 0068). Publish computes it from the package's own needs and the
 * stored closures of the packages it statically imports, then stores it
 * keyed by source and published commit.
 */
import {
	readPublishedCredentialNeeds,
	writePublishedCredentialNeeds,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { resolveSavedPackageImport } from '#worker/package-runtime/package-import-resolution.ts'
import { collectStaticKodyPackageImportsFromFiles } from '#worker/package-runtime/static-kody-imports.ts'
import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { loadPublishedEntityManifest } from '#worker/repo/published-source.ts'
import {
	mergeCredentialNeeds,
	ownCredentialNeeds,
	readStoredCredentialNeeds,
	type CredentialNeed,
	type DependencyCredentialNeeds,
} from './credential-needs.ts'

/**
 * The closure a published package carries: the one stored at its publish,
 * or, for a publish from before closures were stored, its own needs.
 */
export async function loadPublishedCredentialNeeds(input: {
	env: Env
	userId: string
	sourceId: string
}): Promise<Array<CredentialNeed>> {
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source?.published_commit || source.user_id !== input.userId) return []
	const stored = readStoredCredentialNeeds(
		await readPublishedCredentialNeeds({
			env: input.env,
			sourceId: source.id,
			publishedCommit: source.published_commit,
		}),
	)
	if (stored) return stored
	const { manifest } = await loadPublishedEntityManifest({
		env: input.env,
		userId: input.userId,
		sourceId: source.id,
		source,
	})
	return ownCredentialNeeds(manifest.kody.credentials)
}

/**
 * Each statically imported package's current closure, which is what the
 * dependent's bundle snapshots. A package that cannot be resolved here is
 * left to the bundle check, which reports it.
 */
async function loadDependencyCredentialNeeds(input: {
	env: Env
	userId: string
	manifest: AuthoredPackageJson
	files: Record<string, string>
}): Promise<Array<DependencyCredentialNeeds>> {
	const names = [
		...new Set(
			collectStaticKodyPackageImportsFromFiles(input.files)
				.map((imported) => imported.packageName)
				.filter((name) => name !== input.manifest.name),
		),
	].sort()
	const dependencies = await Promise.all(
		names.map(async (packageName) => {
			const resolution = await resolveSavedPackageImport({
				db: input.env.APP_DB,
				userId: input.userId,
				specifier: packageName,
			}).catch(() => null)
			if (!resolution) return null
			const needs = await loadPublishedCredentialNeeds({
				env: input.env,
				userId: resolution.row.userId,
				sourceId: resolution.row.sourceId,
			}).catch(() => [])
			return { packageName, needs }
		}),
	)
	return dependencies.filter((entry) => entry !== null)
}

export async function computeCredentialNeedsClosure(input: {
	env: Env
	userId: string
	manifest: AuthoredPackageJson
	files: Record<string, string>
}) {
	return mergeCredentialNeeds({
		own: ownCredentialNeeds(input.manifest.kody.credentials),
		dependencies: await loadDependencyCredentialNeeds(input),
	})
}

/** Stores the closure for one publish. Conflicts were refused by checks. */
export async function storeCredentialNeedsClosure(input: {
	env: Env
	userId: string
	sourceId: string
	publishedCommit: string
	manifest: AuthoredPackageJson
	files: Record<string, string>
}) {
	const { needs } = await computeCredentialNeedsClosure(input)
	await writePublishedCredentialNeeds({
		env: input.env,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		needs,
	})
}
