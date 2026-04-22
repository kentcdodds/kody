import { getEntitySourceById } from './entity-sources.ts'
import { readMockArtifactSnapshot } from './artifacts.ts'
import {
	loadPublishedSourceSnapshot,
	persistPublishedSourceSnapshot,
} from '#worker/package-runtime/published-runtime-artifacts.ts'

export type PublishedEntitySource = {
	source: Awaited<ReturnType<typeof getEntitySourceById>>
	files: Record<string, string>
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
