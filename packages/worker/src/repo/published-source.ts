import { getEntitySourceById } from './entity-sources.ts'
import { readMockArtifactSnapshot } from './artifacts.ts'
import {
	loadPublishedSourceManifestSnapshot,
	loadPublishedSourceSnapshot,
	persistPublishedSourceManifestSnapshot,
	persistPublishedSourceSnapshot,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'

export type PublishedEntitySource = {
	source: Awaited<ReturnType<typeof getEntitySourceById>>
	files: Record<string, string>
}

export type PublishedEntityManifest = {
	source: Awaited<ReturnType<typeof getEntitySourceById>>
	manifest: AuthoredPackageJson
	content: string
}

function freezeFiles(files: Record<string, string>) {
	return Object.freeze({ ...files }) as Record<string, string>
}

function assertPublishedCommit(source: NonNullable<PublishedEntitySource['source']>) {
	if (!source.published_commit) {
		throw new Error(`Source "${source.id}" has no published commit.`)
	}
	return source.published_commit
}

async function loadSourceSnapshotFromArtifacts(input: {
	env: Env
	source: NonNullable<PublishedEntitySource['source']>
}) {
	const publishedCommit = assertPublishedCommit(input.source)
	const snapshot = await readMockArtifactSnapshot({
		env: input.env,
		repoId: input.source.repo_id,
		commit: publishedCommit,
	})
	if (!snapshot) {
		throw new Error(
			`Published snapshot for source "${input.source.id}" at commit "${publishedCommit}" was not found.`,
		)
	}
	return snapshot.files
}

function parsePublishedManifest(input: {
	source: NonNullable<PublishedEntitySource['source']>
	content: string
}) {
	return parseAuthoredPackageJson({
		content: input.content,
		manifestPath: input.source.manifest_path,
	})
}

async function loadManifestSnapshotFromArtifacts(input: {
	env: Env
	source: NonNullable<PublishedEntitySource['source']>
}) {
	const publishedCommit = assertPublishedCommit(input.source)
	const snapshot = await readMockArtifactSnapshot({
		env: input.env,
		repoId: input.source.repo_id,
		commit: publishedCommit,
	})
	if (!snapshot) {
		throw new Error(
			`Published snapshot for source "${input.source.id}" at commit "${publishedCommit}" was not found.`,
		)
	}
	const content = snapshot.files[input.source.manifest_path]
	if (!content) {
		throw new Error(
			`Published manifest for source "${input.source.id}" at path "${input.source.manifest_path}" was not found.`,
		)
	}
	return content
}

export async function loadPublishedEntitySource(input: {
	env: Env
	userId: string
	sourceId: string
}): Promise<PublishedEntitySource> {
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source || source.user_id !== input.userId) {
		throw new Error(`Published source "${input.sourceId}" was not found.`)
	}
	assertPublishedCommit(source)
	const storedSnapshot = await loadPublishedSourceSnapshot({
		env: input.env,
		userId: input.userId,
		source,
	})
	const files =
		storedSnapshot?.files ??
		(await loadSourceSnapshotFromArtifacts({
			env: input.env,
			source,
		}))
	if (!storedSnapshot) {
		await persistPublishedSourceSnapshot({
			env: input.env,
			userId: input.userId,
			source,
			snapshot: {
				files,
			},
		})
	}
	return {
		source,
		files: freezeFiles(files),
	}
}

export async function loadPublishedEntityManifest(input: {
	env: Env
	userId: string
	sourceId: string
}): Promise<PublishedEntityManifest> {
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source || source.user_id !== input.userId) {
		throw new Error(`Published source "${input.sourceId}" was not found.`)
	}
	assertPublishedCommit(source)
	const storedManifest = await loadPublishedSourceManifestSnapshot({
		env: input.env,
		userId: input.userId,
		source,
	})
	const content =
		storedManifest?.manifestContent ??
		(await loadManifestSnapshotFromArtifacts({
			env: input.env,
			source,
		}))
	if (!storedManifest) {
		await persistPublishedSourceManifestSnapshot({
			env: input.env,
			userId: input.userId,
			source,
			snapshot: {
				manifestContent: content,
			},
		})
	}
	return {
		source,
		content,
		manifest: parsePublishedManifest({
			source,
			content,
		}),
	}
}
