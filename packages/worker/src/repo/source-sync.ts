import {
	hasArtifactsAccess,
	type ArtifactBootstrapAccess,
	isLoopbackArtifactsRemote,
	writeMockArtifactSnapshot,
} from './artifacts.ts'
import { getEntitySourceById, updateEntitySource } from './entity-sources.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { parseRepoManifest } from './manifest.ts'
import { repoSessionRpc } from './repo-session-do.ts'
import { writePublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { type EntitySourceRow } from './types.ts'

type SyncArtifactSourceInput = {
	env: Env
	userId: string
	baseUrl: string
	sourceId: string | null
	files: Record<string, string>
	bootstrapAccess?: ArtifactBootstrapAccess | null
}

function validateEntitySourceManifest(input: {
	entityKind: EntitySourceRow['entity_kind']
	content: string
	manifestPath: string
}) {
	if (input.entityKind === 'package') {
		parseAuthoredPackageJson({
			content: input.content,
			manifestPath: input.manifestPath,
		})
		return
	}
	parseRepoManifest({
		content: input.content,
		manifestPath: input.manifestPath,
	})
}

function canSyncArtifactSource(env: Env) {
	return (
		hasArtifactsAccess(env) &&
		(env as Env & { REPO_SESSION?: DurableObjectNamespace | undefined })
			.REPO_SESSION != null &&
		typeof (env as Env & { APP_DB?: D1Database | undefined }).APP_DB
			?.prepare === 'function'
	)
}

function buildSyncSessionId(sourceId: string) {
	return `source-sync-${sourceId}-${crypto.randomUUID()}`
}

export async function syncArtifactSourceSnapshot(
	input: SyncArtifactSourceInput,
): Promise<string | null> {
	if (!input.sourceId || !canSyncArtifactSource(input.env)) {
		return null
	}
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source) return null
	const sessionId = buildSyncSessionId(source.id)
	const session = repoSessionRpc(input.env, sessionId)
	const edits = Object.entries(input.files).map(([path, content]) => ({
		kind: 'write' as const,
		path,
		content,
	}))
	try {
		if (!source.published_commit) {
			if (
				input.bootstrapAccess?.remote &&
				isLoopbackArtifactsRemote(input.bootstrapAccess.remote)
			) {
				const snapshot = await writeMockArtifactSnapshot({
					env: input.env,
					repoId: source.repo_id,
					files: input.files,
				})
				const manifestContent = input.files[source.manifest_path]
				if (typeof manifestContent !== 'string') {
					throw new Error(
						`Manifest "${source.manifest_path}" was not found in the repo source.`,
					)
				}
				validateEntitySourceManifest({
					entityKind: source.entity_kind,
					content: manifestContent,
					manifestPath: source.manifest_path,
				})
				await updateEntitySource(input.env.APP_DB, {
					id: source.id,
					userId: source.user_id,
					publishedCommit: snapshot.published_commit,
					manifestPath: source.manifest_path,
					sourceRoot: source.source_root,
				})
				await writePublishedSourceSnapshot({
					env: input.env,
					source: {
						...source,
						published_commit: snapshot.published_commit,
					},
					files: input.files,
				})
				return snapshot.published_commit
			}
			const bootstrapResult = await session.bootstrapSource({
				sessionId,
				sourceId: source.id,
				userId: input.userId,
				edits,
				bootstrapAccess: input.bootstrapAccess ?? null,
			})
			await writePublishedSourceSnapshot({
				env: input.env,
				source: {
					...source,
					published_commit: bootstrapResult.publishedCommit,
				},
				files: input.files,
			})
			return bootstrapResult.publishedCommit
		}
		await session.openSession({
			sessionId,
			sourceId: source.id,
			userId: input.userId,
			baseUrl: input.baseUrl,
			sourceRoot: source.source_root,
		})
		await session.applyEdits({
			sessionId,
			userId: input.userId,
			edits,
			dryRun: false,
			rollbackOnError: true,
		})
		const publishResult = await session.publishSession({
			sessionId,
			userId: input.userId,
			force: true,
		})
		if (publishResult.status !== 'ok') {
			throw new Error(publishResult.message)
		}
		await writePublishedSourceSnapshot({
			env: input.env,
			source: {
				...source,
				published_commit: publishResult.publishedCommit,
			},
			files: input.files,
		})
		return publishResult.publishedCommit
	} finally {
		await session
			.discardSession({ sessionId, userId: input.userId })
			.catch(() => {
				// Best effort only; publish/apply failures should preserve the root cause.
			})
	}
}
