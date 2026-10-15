import { packageSourceFiles } from '#worker/credentials/credential-needs-closure.ts'
import { readPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'

const scannableModuleFilePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/
const typeDeclarationFilePattern = /\.d\.[cm]?ts$/

/**
 * `packageStorage()` from `kody:runtime`, or the storage capabilities a
 * package can call on its own bucket. Matching text (not imports) keeps this
 * conservative: a comment or string naming them still lists storage, and so
 * does computed `kody[...]` access, which text cannot resolve.
 */
const packageStorageUsePattern =
	/\bpackageStorage\b|\bstorage(?:Query|Export)\b|\bkody\s*(?:\?\.)?\s*\[/

export function sourceFilesUsePackageStorage(
	files: Record<string, string>,
): boolean {
	return Object.entries(files).some(
		([path, content]) =>
			scannableModuleFilePattern.test(path) &&
			!typeDeclarationFilePattern.test(path) &&
			packageStorageUsePattern.test(content),
	)
}

/**
 * Whether a published package's source reaches its package storage bucket.
 * A missing source row or published source snapshot reads as true, so
 * approval never hides storage it could not rule out.
 */
export async function publishedPackageUsesStorage(input: {
	env: Env
	sourceId: string
	publishedCommit: string
}): Promise<boolean> {
	const [source, snapshot] = await Promise.all([
		getEntitySourceById(input.env.APP_DB, input.sourceId),
		readPublishedSourceSnapshot({
			env: input.env,
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
		}),
	])
	if (!source || !snapshot) return true
	return sourceFilesUsePackageStorage(
		packageSourceFiles({ source, files: snapshot.files }).files,
	)
}
