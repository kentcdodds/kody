import {
	getArtifactsBinding,
	hasArtifactsAccess,
	type ArtifactDeleteRepoResult,
} from './artifacts.ts'
import {
	getEntitySourceByIdForUser,
	listEntitySourcesByUser,
} from './entity-sources.ts'
import {
	listRepoSessionsBySource,
	listRepoSessionsByUser,
} from './repo-sessions.ts'
import { type EntitySourceRow } from './types.ts'

function logArtifactRepoDeleted(input: {
	userId: string
	repoName: string
	result: ArtifactDeleteRepoResult
}) {
	console.info(
		JSON.stringify({
			message: input.result.alreadyDeleted
				? 'artifact repo already absent during cleanup'
				: 'artifact repo deleted',
			userId: input.userId,
			repoName: input.repoName,
			repoId: input.result.id,
		}),
	)
}

export async function deleteUserScopedArtifactRepo(input: {
	env: Env
	userId: string
	repoName: string
	warnings?: Array<string>
}): Promise<boolean> {
	const repoName = input.repoName.trim()
	if (!repoName) return false
	if (!hasArtifactsAccess(input.env)) {
		return false
	}
	try {
		const binding = getArtifactsBinding(input.env)
		const result = await binding.delete(repoName)
		logArtifactRepoDeleted({
			userId: input.userId,
			repoName,
			result,
		})
		return true
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		input.warnings?.push(
			`Artifact repo delete failed for ${repoName}: ${message}`,
		)
		console.warn(
			JSON.stringify({
				message: 'artifact repo delete failed',
				userId: input.userId,
				repoName,
				error: message,
			}),
		)
		return false
	}
}

function collectUniqueRepoNames(
	repoNames: ReadonlyArray<string | null | undefined>,
) {
	const unique = new Set<string>()
	for (const repoName of repoNames) {
		const trimmed = repoName?.trim()
		if (trimmed) unique.add(trimmed)
	}
	return Array.from(unique)
}

async function deleteReposForEntitySource(input: {
	env: Env
	userId: string
	source: EntitySourceRow
	warnings?: Array<string>
}) {
	if (input.source.user_id !== input.userId) {
		input.warnings?.push(
			`Skipped artifact repo cleanup for source ${input.source.id}: user scope mismatch.`,
		)
		return 0
	}
	const sessions = await listRepoSessionsBySource(input.env.APP_DB, {
		userId: input.userId,
		sourceId: input.source.id,
	})
	const repoNames = collectUniqueRepoNames([
		input.source.repo_id,
		...sessions.map((session) => session.source_repo_id),
	])
	let deleted = 0
	for (const repoName of repoNames) {
		if (
			await deleteUserScopedArtifactRepo({
				env: input.env,
				userId: input.userId,
				repoName,
				warnings: input.warnings,
			})
		) {
			deleted += 1
		}
	}
	return deleted
}

export async function cleanupArtifactReposForPackage(input: {
	env: Env
	userId: string
	sourceId: string
	warnings?: Array<string>
}) {
	const source = await getEntitySourceByIdForUser(input.env.APP_DB, {
		id: input.sourceId,
		userId: input.userId,
	})
	if (!source) return 0
	if (source.user_id !== input.userId) {
		input.warnings?.push(
			`Skipped artifact repo cleanup for package source ${input.sourceId}: user scope mismatch.`,
		)
		return 0
	}
	if (!hasArtifactsAccess(input.env)) {
		const sessions = await listRepoSessionsBySource(input.env.APP_DB, {
			userId: input.userId,
			sourceId: source.id,
		})
		const repoCount = collectUniqueRepoNames([
			source.repo_id,
			...sessions.map((session) => session.source_repo_id),
		]).length
		if (repoCount > 0) {
			input.warnings?.push(
				`Cloudflare Artifacts access was unavailable; ${repoCount} artifact repo(s) for the deleted package were not removed and must be cleaned up manually.`,
			)
		}
		return 0
	}
	return deleteReposForEntitySource({
		env: input.env,
		userId: input.userId,
		source,
		warnings: input.warnings,
	})
}

export async function cleanupArtifactReposForSource(input: {
	env: Env
	userId: string
	sourceId: string
	warnings?: Array<string>
}): Promise<{
	deleted: number
	artifactAccessUnavailable: boolean
}> {
	const source = await getEntitySourceByIdForUser(input.env.APP_DB, {
		id: input.sourceId,
		userId: input.userId,
	})
	if (!source) return { deleted: 0, artifactAccessUnavailable: false }
	if (source.user_id !== input.userId) {
		input.warnings?.push(
			`Skipped artifact repo cleanup for source ${input.sourceId}: user scope mismatch.`,
		)
		return { deleted: 0, artifactAccessUnavailable: false }
	}
	if (!hasArtifactsAccess(input.env)) {
		const sessions = await listRepoSessionsBySource(input.env.APP_DB, {
			userId: input.userId,
			sourceId: source.id,
		})
		const repoCount = collectUniqueRepoNames([
			source.repo_id,
			...sessions.map((session) => session.source_repo_id),
		]).length
		if (repoCount > 0) {
			input.warnings?.push(
				`Cloudflare Artifacts access was unavailable; ${repoCount} artifact repo(s) for source ${source.id} were not removed and must be cleaned up manually.`,
			)
		}
		return { deleted: 0, artifactAccessUnavailable: true }
	}
	return {
		deleted: await deleteReposForEntitySource({
			env: input.env,
			userId: input.userId,
			source,
			warnings: input.warnings,
		}),
		artifactAccessUnavailable: false,
	}
}

export async function cleanupAllUserArtifactRepos(input: {
	env: Env
	userId: string
	warnings: Array<string>
}) {
	if (!hasArtifactsAccess(input.env)) {
		if ((await countUserArtifactRepoReferences(input.env, input.userId)) > 0) {
			input.warnings.push(
				'Cloudflare Artifacts access was unavailable; artifact repos referenced by the deleted user were not removed and must be cleaned up manually.',
			)
		}
		return 0
	}

	const [sources, sessions] = await Promise.all([
		listEntitySourcesByUser(input.env.APP_DB, input.userId),
		listRepoSessionsByUser(input.env.APP_DB, input.userId),
	])
	const repoNames = collectUniqueRepoNames([
		...sources.map((source) => source.repo_id),
		...sessions.map((session) => session.source_repo_id),
	])
	let deleted = 0
	for (const repoName of repoNames) {
		if (
			await deleteUserScopedArtifactRepo({
				env: input.env,
				userId: input.userId,
				repoName,
				warnings: input.warnings,
			})
		) {
			deleted += 1
		}
	}
	return deleted
}

async function countUserArtifactRepoReferences(env: Env, userId: string) {
	const [sources, sessions] = await Promise.all([
		listEntitySourcesByUser(env.APP_DB, userId),
		listRepoSessionsByUser(env.APP_DB, userId),
	])
	return collectUniqueRepoNames([
		...sources.map((source) => source.repo_id),
		...sessions.map((session) => session.source_repo_id),
	]).length
}
