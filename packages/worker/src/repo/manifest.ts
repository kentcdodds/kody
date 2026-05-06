import { z } from 'zod'
import { repoManifestSchema, type RepoManifest } from './types.ts'

const defaultManifestPath = 'kody.json'

export function parseRepoManifest(input: {
	content: string
	manifestPath?: string
}): RepoManifest {
	let parsed: unknown
	try {
		parsed = JSON.parse(input.content)
	} catch (cause) {
		throw new Error(
			`Failed to parse ${input.manifestPath ?? defaultManifestPath}: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		)
	}
	const result = repoManifestSchema.safeParse(parsed)
	if (!result.success) {
		const formatted = z.prettifyError(result.error)
		throw new Error(
			`Invalid ${input.manifestPath ?? defaultManifestPath}:\n${formatted}`,
		)
	}
	return result.data
}

export function normalizeRepoWorkspacePath(path: string) {
	return path.trim().replace(/^\/+/, '')
}

export function getManifestEntrypointPath(manifest: RepoManifest) {
	return normalizeRepoWorkspacePath(
		manifest.kind === 'app' ? manifest.server : manifest.entrypoint,
	)
}
