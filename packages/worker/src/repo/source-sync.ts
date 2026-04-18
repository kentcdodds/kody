import { InMemoryFs } from '@cloudflare/shell'
import { createGit } from '@cloudflare/shell/git'
import {
	hasArtifactsAccess,
	parseArtifactTokenSecret,
	resolveArtifactSourceRepo,
} from './artifacts.ts'
import { getEntitySourceById, updateEntitySource } from './entity-sources.ts'
import { parseRepoManifest } from './manifest.ts'
import { repoSessionRpc } from './repo-session-do.ts'
import { type EntitySourceRow } from './types.ts'

type SyncArtifactSourceInput = {
	env: Env
	userId: string
	baseUrl: string
	sourceId: string | null
	files: Record<string, string>
}

const sourceBootstrapWorkspaceRoot = '/'
const sourceBootstrapCommitAuthor = {
	name: 'Kody Source Publish',
	email: 'source-publish@local.invalid',
}

function canPersistArtifactSource(env: Env) {
	return (
		hasArtifactsAccess(env) &&
		typeof (env as Env & { APP_DB?: D1Database | undefined }).APP_DB?.prepare ===
			'function'
	)
}

function canSyncPublishedArtifactSource(env: Env) {
	return (
		canPersistArtifactSource(env) &&
		(env as Env & { REPO_SESSION?: DurableObjectNamespace | undefined })
			.REPO_SESSION != null
	)
}

function buildSyncSessionId(sourceId: string) {
	return `source-sync-${sourceId}-${crypto.randomUUID()}`
}

function normalizeSourceRoot(input: {
	manifestSourceRoot: string | undefined
	currentSourceRoot: string
}) {
	if (!input.manifestSourceRoot) {
		return input.currentSourceRoot
	}
	return input.manifestSourceRoot.startsWith('/')
		? input.manifestSourceRoot
		: `/${input.manifestSourceRoot}`
}

function toSourceBootstrapPath(path: string) {
	return path.startsWith('/') ? path : `/${path}`
}

async function ensureParentDirectory(fs: InMemoryFs, path: string) {
	const parentPath = path.replace(/\/[^/]+$/, '') || '/'
	if (parentPath === '/') {
		return
	}
	await fs.mkdir(parentPath, { recursive: true })
}

async function bootstrapArtifactSourceSnapshot(input: {
	env: Env
	source: EntitySourceRow
	files: Record<string, string>
}) {
	const manifestContent = input.files[input.source.manifest_path]
	if (manifestContent == null) {
		throw new Error(`Manifest "${input.source.manifest_path}" was not found.`)
	}
	const manifest = parseRepoManifest({
		content: manifestContent,
		manifestPath: input.source.manifest_path,
	})
	const sourceRepo = await resolveArtifactSourceRepo(input.env, input.source.repo_id)
	const sourceInfo = await sourceRepo.info()
	if (!sourceInfo?.remote) {
		throw new Error('Artifact repo remote URL is unavailable.')
	}
	const token = await sourceRepo.createToken('write', 3600)
	const targetBranch = sourceInfo.defaultBranch
	const fs = new InMemoryFs()
	const git = createGit(fs, sourceBootstrapWorkspaceRoot)
	await git.init({
		dir: sourceBootstrapWorkspaceRoot,
		defaultBranch: targetBranch,
	})
	for (const [path, content] of Object.entries(input.files)) {
		const workspacePath = toSourceBootstrapPath(path)
		await ensureParentDirectory(fs, workspacePath)
		await fs.writeFile(workspacePath, content)
	}
	await git.remote({
		dir: sourceBootstrapWorkspaceRoot,
		add: {
			name: 'origin',
			url: sourceInfo.remote,
		},
	})
	await git.add({
		dir: sourceBootstrapWorkspaceRoot,
		filepath: '.',
	})
	const commit = await git.commit({
		dir: sourceBootstrapWorkspaceRoot,
		message: `Bootstrap source ${input.source.id}`,
		author: sourceBootstrapCommitAuthor,
	})
	await git.push({
		dir: sourceBootstrapWorkspaceRoot,
		remote: 'origin',
		ref: targetBranch,
		username: 'x',
		password: parseArtifactTokenSecret(token.plaintext),
	})
	await updateEntitySource(input.env.APP_DB, {
		id: input.source.id,
		userId: input.source.user_id,
		publishedCommit: commit.oid,
		manifestPath: input.source.manifest_path,
		sourceRoot: normalizeSourceRoot({
			manifestSourceRoot: manifest.sourceRoot,
			currentSourceRoot: input.source.source_root,
		}),
	})
	return commit.oid
}

export async function syncArtifactSourceSnapshot(
	input: SyncArtifactSourceInput,
): Promise<string | null> {
	if (!input.sourceId || !canPersistArtifactSource(input.env)) {
		return null
	}
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source) return null
	if (!source.published_commit) {
		return await bootstrapArtifactSourceSnapshot({
			env: input.env,
			source,
			files: input.files,
		})
	}
	if (!canSyncPublishedArtifactSource(input.env)) {
		return null
	}
	const sessionId = buildSyncSessionId(source.id)
	const session = repoSessionRpc(input.env, sessionId)
	try {
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
			edits: Object.entries(input.files).map(([path, content]) => ({
				kind: 'write' as const,
				path,
				content,
			})),
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
		return publishResult.publishedCommit
	} finally {
		await session
			.discardSession({ sessionId, userId: input.userId })
			.catch(() => {
				// Best effort only; publish/apply failures should preserve the root cause.
			})
	}
}
