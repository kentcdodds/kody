import { z } from 'zod'
import {
	repoManifestSchema,
	type RepoManifest,
	type SearchProjection,
} from './types.ts'

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

export function buildSearchProjectionFromManifest(
	manifest: RepoManifest,
): SearchProjection {
	return {
		title: manifest.title,
		description: manifest.description,
		keywords: [...(manifest.keywords ?? [])],
		searchText: manifest.searchText?.trim() || null,
	}
}

export function getManifestSourceRoot(manifest: RepoManifest) {
	const sourceRoot = manifest.sourceRoot?.trim()
	if (!sourceRoot) return '/'
	return sourceRoot.startsWith('/') ? sourceRoot : `/${sourceRoot}`
}

export function getManifestPath(manifest: RepoManifest) {
	const manifestPath = manifest.manifestPath?.trim()
	return manifestPath && manifestPath.length > 0
		? manifestPath
		: defaultManifestPath
}
