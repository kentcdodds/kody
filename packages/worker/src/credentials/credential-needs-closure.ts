/**
 * Computing, storing, and loading a package's credential needs closure
 * (ADR 0068). Publish computes it from the package's own needs and the
 * closures of the packages it statically imports, then stores it keyed by
 * source and published commit.
 */
import * as Sentry from '@sentry/cloudflare'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'
import { resolveSavedPackageImport } from '#worker/package-runtime/package-import-resolution.ts'
import {
	readPublishedCredentialNeeds,
	readPublishedSourceSnapshot,
	writePublishedCredentialNeeds,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { collectStaticKodyPackageImportsFromFiles } from '#worker/package-runtime/static-kody-imports.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { normalizeRepoWorkspacePath } from '#worker/repo/manifest.ts'
import { loadPublishedEntityManifest } from '#worker/repo/published-source.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import {
	mergeCredentialNeeds,
	ownCredentialNeeds,
	readStoredCredentialNeeds,
	type CredentialNeed,
	type DependencyCredentialNeeds,
} from './credential-needs.ts'

/**
 * The package's files relative to its source root, plus its manifest.
 * Repo-session snapshots key files from the repo root; check results key them
 * from the source root. Both shapes reach publish.
 */
export function packageSourceFiles(input: {
	source: Pick<EntitySourceRow, 'manifest_path' | 'source_root'>
	files: Record<string, string>
}) {
	const root = normalizeRepoWorkspacePath(input.source.source_root).replace(
		/\/+$/,
		'',
	)
	const manifestPath = normalizeRepoWorkspacePath(input.source.manifest_path)
	const prefix = `${root}/`
	if (root && manifestPath.startsWith(prefix)) {
		const relativeManifest = manifestPath.slice(prefix.length)
		if (typeof input.files[input.source.manifest_path] === 'string') {
			const files = Object.fromEntries(
				Object.entries(input.files)
					.map(
						([path, content]) =>
							[normalizeRepoWorkspacePath(path), content] as const,
					)
					.filter(([path]) => path.startsWith(prefix))
					.map(([path, content]) => [path.slice(prefix.length), content]),
			)
			return { files, manifestContent: files[relativeManifest] ?? null }
		}
		return {
			files: input.files,
			manifestContent: input.files[relativeManifest] ?? null,
		}
	}
	return {
		files: input.files,
		manifestContent: input.files[input.source.manifest_path] ?? null,
	}
}

/**
 * The closure a published package carries: the one stored at its publish.
 * A publish that stored none (an older publish, or a path that skipped it) is
 * computed from its published source. `visiting` breaks import cycles.
 *
 * `fresh` skips this package's stored closure and recomputes it from its own
 * needs and its imports' current closures, which picks up needs a dependency
 * declared after this package last published.
 */
export async function loadPublishedCredentialNeeds(input: {
	env: Env
	userId: string
	sourceId: string
	visiting?: ReadonlySet<string>
	fresh?: boolean
}): Promise<Array<CredentialNeed>> {
	const visiting = input.visiting ?? new Set<string>()
	if (visiting.has(input.sourceId)) return []
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source?.published_commit || source.user_id !== input.userId) return []
	const stored = input.fresh
		? null
		: readStoredCredentialNeeds(
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
	const snapshot = await readPublishedSourceSnapshot({
		env: input.env,
		sourceId: source.id,
		publishedCommit: source.published_commit,
	})
	if (!snapshot) return ownCredentialNeeds(manifest.kody.credentials)
	const { needs } = await computeCredentialNeedsClosure({
		env: input.env,
		userId: input.userId,
		manifest,
		files: packageSourceFiles({ source, files: snapshot.files }).files,
		visiting: new Set([...visiting, source.id]),
	})
	return needs
}

/**
 * Each statically imported package's current closure, which is what the
 * dependent's bundle snapshots. A package that is not in this org is left to
 * the bundle check, which reports it; any other failure throws, so a partial
 * closure is never stored.
 */
async function loadDependencyCredentialNeeds(input: {
	env: Env
	userId: string
	manifest: AuthoredPackageJson
	files: Record<string, string>
	visiting: ReadonlySet<string>
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
				specifier: { packageName, exportName: '.' },
			})
			if (!resolution) return null
			const needs = await loadPublishedCredentialNeeds({
				env: input.env,
				userId: resolution.row.userId,
				sourceId: resolution.row.sourceId,
				visiting: input.visiting,
			})
			return { packageName, needs }
		}),
	)
	return dependencies.filter((entry) => entry !== null)
}

/** `files` are relative to the package's source root. */
export async function computeCredentialNeedsClosure(input: {
	env: Env
	userId: string
	manifest: AuthoredPackageJson
	files: Record<string, string>
	visiting?: ReadonlySet<string>
}) {
	return mergeCredentialNeeds({
		own: ownCredentialNeeds(input.manifest.kody.credentials),
		dependencies: await loadDependencyCredentialNeeds({
			...input,
			visiting: input.visiting ?? new Set(),
		}),
	})
}

/**
 * Stores the closure for one package publish. Best effort: a publish whose
 * closure was not stored is computed from its source when read, so a failure
 * here never fails the publish. Conflicts were refused by checks.
 */
export async function storePublishedCredentialNeeds(input: {
	env: Env
	source: EntitySourceRow
	publishedCommit: string
	files: Record<string, string>
}) {
	if (input.source.entity_kind !== 'package') return
	try {
		const { files, manifestContent } = packageSourceFiles(input)
		if (typeof manifestContent !== 'string') return
		const { needs } = await computeCredentialNeedsClosure({
			env: input.env,
			userId: input.source.user_id,
			manifest: parseAuthoredPackageJson({
				content: manifestContent,
				mode: 'published',
			}),
			files,
			visiting: new Set([input.source.id]),
		})
		await writePublishedCredentialNeeds({
			env: input.env,
			sourceId: input.source.id,
			publishedCommit: input.publishedCommit,
			needs,
		})
	} catch (error) {
		Sentry.captureException(error, {
			tags: { scope: 'repo.publish.store-credential-needs' },
			extra: {
				sourceId: input.source.id,
				publishedCommit: input.publishedCommit,
			},
		})
	}
}
