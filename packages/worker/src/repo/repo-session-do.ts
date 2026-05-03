import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import {
	Workspace,
	WorkspaceFileSystem,
	createWorkspaceStateBackend,
} from '@cloudflare/shell'
import { applyPatch, formatPatch, parsePatch } from 'diff'
import { createGit } from '@cloudflare/shell/git'
import {
	deleteRepoSession,
	getRepoSessionById,
	insertRepoSession,
	updateRepoSession,
} from './repo-sessions.ts'
import {
	type ArtifactBootstrapAccess,
	type ArtifactRepoInfo,
	buildArtifactsGitAuth,
	buildAuthenticatedArtifactsRemote,
	resolveArtifactSourceRepo,
	resolveSessionRepo,
} from './artifacts.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { getEntitySourceById, updateEntitySource } from './entity-sources.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { searchRepoWorkspace } from './repo-session-search.ts'
import { repoSessionRpc as createRepoSessionRpc } from './repo-session-rpc.ts'
import {
	resolveRepoWorkspacePath,
	toExternalRepoPath,
	toRepoSessionInfoResult,
	toRepoSessionTreeResult,
} from './repo-session-tree.ts'
import { runRepoChecks } from './checks.ts'
import { parseRepoManifest } from './manifest.ts'
import {
	hasPublishedRuntimeArtifacts,
	writePublishedSourceSnapshot,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	type EntityKind,
	type EntitySourceRow,
	type RepoSearchMode,
	type RepoSearchOutputMode,
	type RepoSourceBootstrapResult,
	type RepoSessionApplyEditsResult,
	type RepoSessionCheckRun,
	type RepoSessionCheckStatus,
	type RepoSessionDiscardResult,
	type RepoSessionPublishResult,
	type RepoSessionRebaseResult,
	type RepoSessionRow,
	type RepoSessionSearchResult,
	type RepoSessionTreeResult,
} from './types.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import {
	type RepoGitCommand,
	type RepoRunCommandsResult,
	parseRepoGitCommands,
} from './repo-session-commands.ts'

const repoSessionWorkspacePrefix = '/session'
const lastCheckStatusStorageKey = 'repo-session:last-check-status'
const cachedSessionStateStorageKeyPrefix = 'repo-session:state:'
const defaultSessionBranch = 'main'
const sessionCommitAuthor = {
	name: 'Kody Repo Session',
	email: 'repo-session@local.invalid',
}

type CachedRepoSessionState = {
	sessionRow: RepoSessionRow
	source: EntitySourceRow
}

function buildRepoSessionWorkspaceName(sessionId: string) {
	return `repo-session:${sessionId}`
}

function nowIso() {
	return new Date().toISOString()
}

function getCachedSessionStateStorageKey(sessionId: string) {
	return `${cachedSessionStateStorageKeyPrefix}${sessionId}`
}

// D1 read replicas can lag briefly behind the primary; when we know a row was
// just inserted (for example, openSession persisted a fresh repo session before
// returning to the worker), an immediate read from a different request handler
// may still miss it. A short retry with backoff papers over that lag without
// resorting to global throttling.
const repoLookupRetryDelaysMs = [50, 100, 200, 400] as const

export async function readWithRetry<T>(
	read: () => Promise<T | null>,
	delaysMs: ReadonlyArray<number> = repoLookupRetryDelaysMs,
): Promise<T | null> {
	let result = await read()
	if (result != null) return result
	for (const delayMs of delaysMs) {
		await new Promise((resolve) => setTimeout(resolve, delayMs))
		result = await read()
		if (result != null) return result
	}
	return null
}

async function readRepoSessionWithRetry(db: D1Database, sessionId: string) {
	return readWithRetry(() => getRepoSessionById(db, sessionId))
}

async function readEntitySourceWithRetry(db: D1Database, sourceId: string) {
	return readWithRetry(() => getEntitySourceById(db, sourceId))
}

function compactArtifactsRepoSuffix(value: string) {
	const compact = value.replace(/[^a-zA-Z0-9]/g, '')
	return compact.length > 0 ? compact : 'session'
}

function buildSessionArtifactsRepoName(
	sourceRepoId: string,
	sessionId: string,
) {
	const compactSessionId = compactArtifactsRepoSuffix(sessionId).slice(-61)
	const repoPrefixLength = Math.max(1, 63 - compactSessionId.length - 1)
	return `${sourceRepoId.slice(0, repoPrefixLength)}-${compactSessionId}`
}

async function ensureArtifactRepoRemote(input: {
	repo: {
		info: () => Promise<{ remote: string } | null>
		createToken: (
			scope?: 'write' | 'read',
			ttl?: number,
		) => Promise<{
			plaintext: string
		}>
	}
	scope?: 'write' | 'read'
}) {
	const info = await input.repo.info()
	if (!info?.remote) {
		throw new Error('Artifact repo remote URL is unavailable.')
	}
	const token = await input.repo.createToken(input.scope ?? 'write', 3600)
	return {
		remote: info.remote,
		token: token.plaintext,
	}
}

function buildGitCloneAuth(input: { remote: string; token: string }) {
	return {
		url: input.remote,
		...buildArtifactsGitAuth({ token: input.token }),
	}
}

class RepoSessionBase extends DurableObject<Env> {
	readonly workspace = new Workspace({
		sql: this.ctx.storage.sql,
		name: () => buildRepoSessionWorkspaceName(this.ctx.id.toString()),
	})

	readonly fileSystem = new WorkspaceFileSystem(this.workspace)

	readonly state = createWorkspaceStateBackend(this.workspace)

	readonly git = createGit(this.fileSystem, repoSessionWorkspacePrefix)

	private initializedSessionId: string | null = null

	// In-memory cache for the active DO instance. This serves as the primary
	// fallback for follow-up RPC calls on the same sessionId so that even the
	// shortest replication lag between D1 writes and reads does not surface as
	// a spurious "Repo session was not found" error during scheduled runs.
	private readonly inMemorySessionState = new Map<
		string,
		CachedRepoSessionState
	>()

	private async readCachedSessionState(
		sessionId: string,
	): Promise<CachedRepoSessionState | null> {
		const inMemory = this.inMemorySessionState.get(sessionId)
		if (inMemory) {
			return inMemory
		}
		const persisted =
			(await this.ctx.storage.get<CachedRepoSessionState | null>(
				getCachedSessionStateStorageKey(sessionId),
			)) ?? null
		if (persisted) {
			this.inMemorySessionState.set(sessionId, persisted)
		}
		return persisted
	}

	private async writeCachedSessionState(
		state: CachedRepoSessionState,
	): Promise<void> {
		this.inMemorySessionState.set(state.sessionRow.id, state)
		await this.ctx.storage.put(
			getCachedSessionStateStorageKey(state.sessionRow.id),
			state,
		)
	}

	private async clearCachedSessionState(sessionId: string): Promise<void> {
		this.inMemorySessionState.delete(sessionId)
		await this.ctx.storage.put(getCachedSessionStateStorageKey(sessionId), null)
	}

	private async getSessionState(sessionId: string, userId: string) {
		const cachedState = await this.readCachedSessionState(sessionId)
		// Prefer fresh reads from D1 so correctness-sensitive flows like
		// rebaseSession and publishSession always observe the latest
		// base_commit and published_commit. The cache is only a fallback for
		// when a D1 read genuinely cannot see a row (e.g. brief replica lag
		// immediately after openSession inserted it); this keeps scheduled
		// jobs from throwing "Repo session was not found" while still letting
		// concurrent mutations through updateRepoSession / updateEntitySource
		// drive rebase and publish decisions.
		const sessionRow =
			(await readRepoSessionWithRetry(this.env.APP_DB, sessionId)) ??
			cachedState?.sessionRow ??
			null
		if (!sessionRow) {
			throw new Error(`Repo session "${sessionId}" was not found.`)
		}
		if (sessionRow.user_id !== userId) {
			throw new Error(
				`Repo session "${sessionId}" was not found for this user.`,
			)
		}
		const source =
			(await readEntitySourceWithRetry(
				this.env.APP_DB,
				sessionRow.source_id,
			)) ??
			(cachedState?.source?.id === sessionRow.source_id
				? cachedState.source
				: null)
		if (!source) {
			throw new Error(`Source "${sessionRow.source_id}" was not found.`)
		}
		await this.writeCachedSessionState({ sessionRow, source })
		const sessionRepo = await resolveSessionRepo(this.env, {
			namespace: sessionRow.session_repo_namespace,
			name: sessionRow.session_repo_name,
		})
		const access = await ensureArtifactRepoRemote({
			repo: sessionRepo,
			scope: 'write',
		})
		await this.initialize({
			sessionId: sessionRow.id,
			sessionRepoRemote: access.remote,
			sessionRepoToken: access.token,
		})
		return {
			sessionRow,
			source,
			sessionRepo,
			sessionAccess: access,
		}
	}

	private async ensureRemote(input: { name: string; url: string }) {
		const existing = await this.git.remote({
			dir: repoSessionWorkspacePrefix,
			list: true,
		})
		const remotes = Array.isArray(existing) ? existing : []
		const current = remotes.find((remote) => remote.remote === input.name)
		if (current?.url === input.url) {
			return
		}
		if (current) {
			await this.git.remote({
				dir: repoSessionWorkspacePrefix,
				remove: input.name,
			})
		}
		await this.git.remote({
			dir: repoSessionWorkspacePrefix,
			add: {
				name: input.name,
				url: input.url,
			},
		})
	}

	private async resetWorkspace() {
		const gitConfigPath = `${repoSessionWorkspacePrefix}/.git/config`
		for (let attempt = 0; attempt < 2; attempt += 1) {
			await this.workspace.rm(repoSessionWorkspacePrefix, {
				force: true,
				recursive: true,
			})
			const [workspaceExists, gitConfigExists] = await Promise.all([
				this.workspace.exists(repoSessionWorkspacePrefix),
				this.workspace.exists(gitConfigPath),
			])
			if (!workspaceExists && !gitConfigExists) {
				this.initializedSessionId = null
				return
			}
		}
		throw new Error(
			`Failed to remove repo session workspace "${repoSessionWorkspacePrefix}" cleanly.`,
		)
	}

	private async hasExpectedOriginRemote(expectedUrl: string) {
		try {
			const remotes = await this.git.remote({
				dir: repoSessionWorkspacePrefix,
				list: true,
			})
			if (!Array.isArray(remotes)) {
				return false
			}
			return remotes.some(
				(remote) => remote.remote === 'origin' && remote.url === expectedUrl,
			)
		} catch {
			return false
		}
	}

	private async readManifestFromWorkspace(
		manifestPath: string,
		entityKind: EntityKind,
	) {
		const manifestContent = await this.workspace.readFile(
			resolveRepoWorkspacePath(manifestPath, repoSessionWorkspacePrefix),
		)
		if (manifestContent == null) {
			throw new Error(`Manifest "${manifestPath}" was not found.`)
		}
		if (entityKind === 'package') {
			return parseAuthoredPackageJson({
				content: manifestContent,
				manifestPath,
			})
		}
		return parseRepoManifest({
			content: manifestContent,
			manifestPath,
		})
	}

	private async getCurrentBranch(defaultBranch = defaultSessionBranch) {
		const branchResult = await this.git.branch({
			dir: repoSessionWorkspacePrefix,
			list: true,
		})
		if ('current' in branchResult && branchResult.current) {
			return branchResult.current
		}
		return defaultBranch
	}

	private async getHeadCommit() {
		const log = await this.git.log({
			dir: repoSessionWorkspacePrefix,
			depth: 1,
		})
		return log[0]?.oid ?? null
	}

	private async commitIfDirty(message: string) {
		const statusEntries = await this.git.status({
			dir: repoSessionWorkspacePrefix,
		})
		const hasChanges = statusEntries.some(
			(entry) => entry.status !== 'unmodified',
		)
		if (!hasChanges) {
			return this.getHeadCommit()
		}
		await this.git.add({
			dir: repoSessionWorkspacePrefix,
			filepath: '.',
		})
		const commit = await this.git.commit({
			dir: repoSessionWorkspacePrefix,
			message,
			author: sessionCommitAuthor,
		})
		return commit.oid
	}

	private async listWorkspaceFileEntries(
		root = repoSessionWorkspacePrefix,
	): Promise<Array<{ path: string }>> {
		const normalizedRoot = root.replace(/\/+$/, '')
		const entries = await this.workspace.glob(`${normalizedRoot}/**/*`)
		return entries
			.filter((entry) => entry.type === 'file')
			.filter((entry) => !entry.path.includes('/.git/'))
			.sort((left, right) => left.path.localeCompare(right.path))
			.map((entry) => ({ path: entry.path }))
	}

	private async collectWorkspaceFiles(
		root = repoSessionWorkspacePrefix,
	): Promise<Record<string, string>> {
		const entries = await this.listWorkspaceFileEntries(root)
		const rootPrefix = `${root.replace(/\/+$/, '')}/`
		const files: Record<string, string> = {}
		for (const entry of entries) {
			const content = await this.workspace.readFile(entry.path)
			// Treat an unreadable file as a hard failure so the caller aborts
			// and triggers rollback instead of persisting a KV snapshot that
			// is silently missing files. A null read here usually means the
			// file was unlinked between glob and read, which means the tree
			// we are about to publish is not the tree we scanned.
			if (content == null) {
				throw new Error(
					`Failed to read repo session file "${entry.path}" while collecting workspace snapshot.`,
				)
			}
			const relativePath = entry.path.startsWith(rootPrefix)
				? entry.path.slice(rootPrefix.length)
				: entry.path
			files[relativePath] = content
		}
		return files
	}

	private async computeTreeHash(root = repoSessionWorkspacePrefix) {
		const entries = await this.listWorkspaceFileEntries(root)
		const chunks: Array<string> = []
		for (const entry of entries) {
			const content = await this.workspace.readFile(entry.path)
			chunks.push(`${entry.path}\n${content ?? ''}\n`)
		}
		const data = new TextEncoder().encode(chunks.join(''))
		const digest = await crypto.subtle.digest('SHA-256', data)
		return [...new Uint8Array(digest)]
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('')
	}

	private async writeCheckStatus(status: RepoSessionCheckStatus) {
		await this.ctx.storage.put(lastCheckStatusStorageKey, status)
	}

	private async readCheckStatus(): Promise<RepoSessionCheckStatus> {
		return (
			(await this.ctx.storage.get<RepoSessionCheckStatus>(
				lastCheckStatusStorageKey,
			)) ?? {
				runId: null,
				treeHash: null,
				checkedAt: null,
				ok: null,
				results: null,
			}
		)
	}

	async initialize(input: {
		sessionId: string
		sessionRepoRemote: string
		sessionRepoToken: string
	}): Promise<void> {
		if (this.initializedSessionId === input.sessionId) return
		const gitConfigPath = `${repoSessionWorkspacePrefix}/.git/config`
		const hasGitDir = await this.workspace.exists(gitConfigPath)
		if (hasGitDir) {
			const hasExpectedOrigin = await this.hasExpectedOriginRemote(
				input.sessionRepoRemote,
			)
			if (!hasExpectedOrigin) {
				await this.resetWorkspace()
			}
		}
		const hasCleanGitDir = await this.workspace.exists(gitConfigPath)
		if (!hasCleanGitDir) {
			await this.workspace.mkdir(repoSessionWorkspacePrefix, {
				recursive: true,
			})
			await this.git.clone({
				dir: repoSessionWorkspacePrefix,
				...buildGitCloneAuth({
					remote: input.sessionRepoRemote,
					token: input.sessionRepoToken,
				}),
			})
		}
		this.initializedSessionId = input.sessionId
	}

	private async applyWorkspaceEdits(input: {
		edits: Array<{
			kind: 'write' | 'replace' | 'writeJson'
			path: string
			content?: string
			search?: string
			replacement?: string
			value?: unknown
			options?: {
				caseSensitive?: boolean
				regex?: boolean
				wholeWord?: boolean
				contextBefore?: number
				contextAfter?: number
				maxMatches?: number
				spaces?: number
			}
		}>
		dryRun?: boolean
		rollbackOnError?: boolean
	}): Promise<RepoSessionApplyEditsResult> {
		const plan = await this.state.planEdits(
			input.edits.map((edit) => {
				const path = resolveRepoWorkspacePath(
					edit.path,
					repoSessionWorkspacePrefix,
				)
				switch (edit.kind) {
					case 'write':
						if (typeof edit.content !== 'string') {
							throw new Error('repo session write edits require content.')
						}
						return {
							kind: 'write' as const,
							path,
							content: edit.content,
						}
					case 'replace':
						if (typeof edit.search !== 'string') {
							throw new Error('repo session replace edits require search.')
						}
						return {
							kind: 'replace' as const,
							path,
							search: edit.search,
							replacement: edit.replacement ?? '',
							options: edit.options,
						}
					case 'writeJson':
						return {
							kind: 'writeJson' as const,
							path,
							value: edit.value,
							options:
								typeof edit.options?.spaces === 'number'
									? { spaces: edit.options.spaces }
									: undefined,
						}
				}
			}),
		)
		const result = await this.state.applyEditPlan(plan, {
			dryRun: input.dryRun,
			rollbackOnError: input.rollbackOnError,
		})
		return {
			dryRun: result.dryRun,
			totalChanged: result.totalChanged,
			edits: result.edits.map((edit) => ({
				path: toExternalRepoPath(edit.path, repoSessionWorkspacePrefix),
				changed: edit.changed,
				content: edit.content,
				diff: edit.diff,
			})),
		}
	}

	async openSession(input: {
		sessionId: string
		sourceId: string
		userId: string
		baseUrl: string
		conversationId?: string | null
		sourceRoot?: string | null
		defaultBranch?: string | null
	}) {
		let sessionRow = await getRepoSessionById(this.env.APP_DB, input.sessionId)
		if (!sessionRow) {
			const source = await getEntitySourceById(this.env.APP_DB, input.sourceId)
			if (!source) {
				throw new Error(`Source "${input.sourceId}" was not found.`)
			}
			if (source.user_id !== input.userId) {
				throw new Error(
					`Source "${input.sourceId}" was not found for this user.`,
				)
			}
			const sourceRepo = await resolveArtifactSourceRepo(
				this.env,
				source.repo_id,
			)
			const baseCommit = source.published_commit
			if (!baseCommit) {
				throw new Error(
					`Source "${source.id}" has no published commit yet. Bootstrap the source repo before opening a repo session.`,
				)
			}
			const sessionRepoName = buildSessionArtifactsRepoName(
				source.repo_id,
				input.sessionId,
			)
			const forked = await sourceRepo.fork({
				name: sessionRepoName,
				readOnly: false,
			})
			const now = nowIso()
			const newSessionRow: RepoSessionRow = {
				id: input.sessionId,
				user_id: input.userId,
				source_id: input.sourceId,
				session_repo_id: forked.id,
				session_repo_name: forked.name,
				session_repo_namespace: 'default',
				base_commit: baseCommit ?? '',
				source_root: input.sourceRoot ?? source.source_root,
				conversation_id: input.conversationId ?? null,
				status: 'active',
				expires_at: null,
				last_checkpoint_at: null,
				last_checkpoint_commit: baseCommit,
				last_check_run_id: null,
				last_check_tree_hash: null,
				created_at: now,
				updated_at: now,
			}
			await insertRepoSession(this.env.APP_DB, newSessionRow)
			sessionRow = newSessionRow
			await this.initialize({
				sessionId: sessionRow.id,
				sessionRepoRemote: forked.remote,
				sessionRepoToken: forked.token,
			})
		} else {
			if (sessionRow.user_id !== input.userId) {
				throw new Error(
					`Repo session "${input.sessionId}" was not found for this user.`,
				)
			}
			const sessionRepo = await resolveSessionRepo(this.env, {
				namespace: sessionRow.session_repo_namespace,
				name: sessionRow.session_repo_name,
			})
			const access = await ensureArtifactRepoRemote({
				repo: sessionRepo,
				scope: 'write',
			})
			await this.initialize({
				sessionId: sessionRow.id,
				sessionRepoRemote: access.remote,
				sessionRepoToken: access.token,
			})
		}
		const source = await getEntitySourceById(
			this.env.APP_DB,
			sessionRow.source_id,
		)
		if (!source) {
			throw new Error(`Source "${sessionRow.source_id}" was not found.`)
		}
		await this.writeCachedSessionState({ sessionRow, source })
		return toRepoSessionInfoResult(sessionRow, source)
	}

	async bootstrapSource(input: {
		sessionId: string
		sourceId: string
		userId: string
		bootstrapAccess?: ArtifactBootstrapAccess | null
		edits: Array<{
			kind: 'write' | 'replace' | 'writeJson'
			path: string
			content?: string
			search?: string
			replacement?: string
			value?: unknown
			options?: {
				caseSensitive?: boolean
				regex?: boolean
				wholeWord?: boolean
				contextBefore?: number
				contextAfter?: number
				maxMatches?: number
				spaces?: number
			}
		}>
	}): Promise<RepoSourceBootstrapResult> {
		const source = await getEntitySourceById(this.env.APP_DB, input.sourceId)
		if (!source) {
			throw new Error(`Source "${input.sourceId}" was not found.`)
		}
		if (source.user_id !== input.userId) {
			throw new Error(`Source "${input.sourceId}" was not found for this user.`)
		}
		if (source.published_commit) {
			throw new Error(
				`Source "${source.id}" already has a published commit. Use repo sessions for later edits.`,
			)
		}
		let sourceInfo: ArtifactRepoInfo | null = null
		let sourceAccess: { remote: string; token: string }
		if (input.bootstrapAccess) {
			sourceAccess = {
				remote: input.bootstrapAccess.remote,
				token: input.bootstrapAccess.token,
			}
		} else {
			const sourceRepo = await resolveArtifactSourceRepo(
				this.env,
				source.repo_id,
			)
			sourceInfo = await sourceRepo.info()
			sourceAccess = await ensureArtifactRepoRemote({
				repo: sourceRepo,
				scope: 'write',
			})
		}
		const targetBranch =
			input.bootstrapAccess?.defaultBranch ??
			sourceInfo?.defaultBranch ??
			defaultSessionBranch
		await this.resetWorkspace()
		await this.workspace.mkdir(repoSessionWorkspacePrefix, {
			recursive: true,
		})
		await this.git.init({
			dir: repoSessionWorkspacePrefix,
			defaultBranch: targetBranch,
		})
		await this.ensureRemote({
			name: 'source',
			url: buildAuthenticatedArtifactsRemote({
				remote: sourceAccess.remote,
				token: sourceAccess.token,
			}),
		})
		await this.applyWorkspaceEdits({
			edits: input.edits,
			dryRun: false,
			rollbackOnError: true,
		})
		const publishedCommit = await this.commitIfDirty(
			`Bootstrap source repo ${source.id}`,
		)
		if (!publishedCommit) {
			throw new Error(`Source "${source.id}" bootstrap produced no commit.`)
		}
		await this.readManifestFromWorkspace(
			source.manifest_path,
			source.entity_kind,
		)
		await this.git.push({
			dir: repoSessionWorkspacePrefix,
			remote: 'source',
			ref: targetBranch,
			...buildArtifactsGitAuth({ token: sourceAccess.token }),
		})
		await updateEntitySource(this.env.APP_DB, {
			id: source.id,
			userId: source.user_id,
			publishedCommit,
			manifestPath: source.manifest_path,
			sourceRoot: source.source_root,
		})
		return {
			sessionId: input.sessionId,
			publishedCommit,
			message: `Bootstrapped source ${source.id} in ${source.repo_id}.`,
		}
	}

	async getSessionInfo(input: { sessionId: string; userId: string }) {
		const { sessionRow, source } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		return toRepoSessionInfoResult(sessionRow, source)
	}

	async discardSession(input: {
		sessionId: string
		userId: string
	}): Promise<RepoSessionDiscardResult> {
		const sessionRow = await getRepoSessionById(
			this.env.APP_DB,
			input.sessionId,
		)
		if (!sessionRow) {
			await this.clearCachedSessionState(input.sessionId)
			await this.resetWorkspace()
			return {
				ok: true,
				sessionId: input.sessionId,
				deleted: false,
			}
		}
		if (sessionRow.user_id !== input.userId) {
			throw new Error(
				`Repo session "${input.sessionId}" was not found for this user.`,
			)
		}
		await deleteRepoSession(this.env.APP_DB, input.sessionId)
		await this.clearCachedSessionState(input.sessionId)
		await this.resetWorkspace()
		return {
			ok: true,
			sessionId: input.sessionId,
			deleted: true,
		}
	}

	async readFile(input: {
		sessionId: string
		userId: string
		path: string
	}): Promise<{ path: string; content: string | null }> {
		await this.getSessionState(input.sessionId, input.userId)
		return {
			path: input.path,
			content: await this.workspace.readFile(
				resolveRepoWorkspacePath(input.path, repoSessionWorkspacePrefix),
			),
		}
	}

	async writeFile(input: {
		sessionId: string
		userId: string
		path: string
		content: string
	}): Promise<{ ok: true; path: string }> {
		const { sessionRow } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		await this.workspace.writeFile(
			resolveRepoWorkspacePath(input.path, repoSessionWorkspacePrefix),
			input.content,
		)
		await updateRepoSession(this.env.APP_DB, {
			id: input.sessionId,
			userId: sessionRow.user_id,
			lastCheckpointAt: nowIso(),
		})
		return { ok: true, path: input.path }
	}

	async search(input: {
		sessionId: string
		userId: string
		pattern: string
		mode?: RepoSearchMode
		glob?: string | null
		path?: string | null
		caseSensitive?: boolean
		before?: number
		after?: number
		limit?: number
		outputMode?: RepoSearchOutputMode
	}): Promise<RepoSessionSearchResult> {
		const { sessionRow } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		const root = resolveRepoWorkspacePath(
			input.path?.trim() ||
				sessionRow.source_root ||
				repoSessionWorkspacePrefix,
			repoSessionWorkspacePrefix,
		)
		return searchRepoWorkspace({
			workspace: this.workspace,
			root,
			pattern: input.pattern,
			mode: input.mode,
			glob: input.glob,
			caseSensitive: input.caseSensitive,
			before: input.before,
			after: input.after,
			limit: input.limit,
			outputMode: input.outputMode,
			toExternalPath: (path) =>
				toExternalRepoPath(path, repoSessionWorkspacePrefix),
		})
	}

	private async applyUnifiedDiff(input: { patch: string; dryRun?: boolean }) {
		const patches = parsePatch(input.patch)
		if (patches.length === 0) {
			throw new Error('git apply patch did not contain any file changes.')
		}
		const edits: Array<{
			path: string
			changed: boolean
			content: string
			diff: string
		}> = []
		for (const patch of patches) {
			const targetPath =
				patch.newFileName && patch.newFileName !== '/dev/null'
					? patch.newFileName
					: patch.oldFileName
			if (!targetPath || targetPath === '/dev/null') {
				throw new Error('git apply patch is missing a target file path.')
			}
			const externalPath = targetPath.replace(/^[ab]\//, '')
			const workspacePath = resolveRepoWorkspacePath(
				externalPath,
				repoSessionWorkspacePrefix,
			)
			const currentContent =
				(await this.workspace.readFile(workspacePath)) ?? ''
			const nextContent = applyPatch(currentContent, patch)
			if (nextContent === false) {
				throw new Error(
					`git apply patch did not apply cleanly to ${externalPath}.`,
				)
			}
			if (!input.dryRun) {
				if (patch.newFileName === '/dev/null') {
					await this.workspace.rm(workspacePath, { force: true })
				} else {
					await this.workspace.writeFile(workspacePath, nextContent)
				}
			}
			edits.push({
				path: externalPath,
				changed: nextContent !== currentContent,
				content: nextContent,
				diff: formatPatch(patch),
			})
		}
		return {
			dryRun: input.dryRun ?? false,
			totalChanged: edits.filter((edit) => edit.changed).length,
			edits,
		}
	}

	private async executeGitCommand(command: RepoGitCommand, dryRun?: boolean) {
		switch (command.kind) {
			case 'apply':
				return this.applyUnifiedDiff({ patch: command.patch, dryRun })
			case 'status':
				return this.git.status({ dir: repoSessionWorkspacePrefix })
			case 'diff':
				return this.git.diff({ dir: repoSessionWorkspacePrefix })
			case 'add':
				return this.git.add({
					dir: repoSessionWorkspacePrefix,
					filepath: command.filepath,
				})
			case 'rm':
				return this.git.rm({
					dir: repoSessionWorkspacePrefix,
					filepath: command.filepath,
				})
			case 'commit':
				return this.git.commit({
					dir: repoSessionWorkspacePrefix,
					message: command.message,
					author: sessionCommitAuthor,
				})
			case 'log':
				return this.git.log({
					dir: repoSessionWorkspacePrefix,
					depth: command.depth,
				})
			case 'branch':
				return this.git.branch({
					dir: repoSessionWorkspacePrefix,
					name: command.name,
					delete: command.delete,
					list: command.name == null && command.delete == null,
				})
			case 'checkout':
				return this.git.checkout({
					dir: repoSessionWorkspacePrefix,
					ref: command.ref,
					branch: command.branch,
					force: command.force,
				})
			case 'fetch':
				return this.git.fetch({
					dir: repoSessionWorkspacePrefix,
					remote: command.remote,
					ref: command.ref,
				})
			case 'pull':
				return this.git.pull({
					dir: repoSessionWorkspacePrefix,
					remote: command.remote,
					ref: command.ref,
					author: sessionCommitAuthor,
				})
			case 'push':
				return this.git.push({
					dir: repoSessionWorkspacePrefix,
					remote: command.remote,
					ref: command.ref,
					force: command.force,
				})
			case 'remote':
				if (command.action === 'add') {
					return this.git.remote({
						dir: repoSessionWorkspacePrefix,
						add: {
							name: command.name ?? '',
							url: command.url ?? '',
						},
					})
				}
				if (command.action === 'remove') {
					return this.git.remote({
						dir: repoSessionWorkspacePrefix,
						remove: command.name,
					})
				}
				return this.git.remote({
					dir: repoSessionWorkspacePrefix,
					list: true,
				})
			default: {
				const exhaustive: never = command
				return exhaustive
			}
		}
	}

	async runCommands(input: {
		sessionId: string
		userId: string
		commands: string
		dryRun?: boolean
		runChecks?: boolean
		publish?: boolean
	}): Promise<RepoRunCommandsResult> {
		const { sessionRow } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		const commands = parseRepoGitCommands(input.commands)
		const results = []
		for (const command of commands) {
			results.push({
				line: command.line,
				command: command.raw,
				ok: true as const,
				output: await this.executeGitCommand(command, input.dryRun),
			})
		}
		await updateRepoSession(this.env.APP_DB, {
			id: input.sessionId,
			userId: sessionRow.user_id,
			lastCheckpointAt: nowIso(),
		})
		const shouldRunChecks = input.runChecks ?? false
		const shouldPublish = input.publish ?? false
		if (!shouldRunChecks) {
			return {
				session: await this.getSessionInfo(input),
				commands: results,
				checks: { status: 'not_requested' },
				publish: shouldPublish
					? {
							status: 'blocked_by_checks',
							message:
								'Publishing requires checks. Set run_checks to true when publish is true.',
						}
					: { status: 'not_requested' },
			}
		}
		const checkRun = await this.runChecks(input)
		if (!checkRun.ok) {
			return {
				session: await this.getSessionInfo(input),
				commands: results,
				checks: {
					...checkRun,
					status: 'failed',
					ok: false,
					failedChecks: checkRun.results.filter((entry) => !entry.ok),
				},
				publish: shouldPublish
					? {
							status: 'blocked_by_checks',
							message: 'Publishing skipped because repo checks failed.',
						}
					: { status: 'not_requested' },
			}
		}
		return {
			session: await this.getSessionInfo(input),
			commands: results,
			checks: {
				...checkRun,
				status: 'passed',
				ok: true,
			},
			publish: shouldPublish
				? await this.publishSession(input)
				: { status: 'not_requested' },
		}
	}

	async tree(input: {
		sessionId: string
		userId: string
		path?: string | null
		maxDepth?: number
	}): Promise<RepoSessionTreeResult> {
		const { sessionRow } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		const root = resolveRepoWorkspacePath(
			input.path?.trim() ||
				sessionRow.source_root ||
				repoSessionWorkspacePrefix,
			repoSessionWorkspacePrefix,
		)
		const tree = await this.state.walkTree(root, {
			maxDepth: input.maxDepth,
		})
		return toRepoSessionTreeResult({
			node: tree,
			workspacePrefix: repoSessionWorkspacePrefix,
		})
	}

	async applyEdits(input: {
		sessionId: string
		userId: string
		edits: Array<{
			kind: 'write' | 'replace' | 'writeJson'
			path: string
			content?: string
			search?: string
			replacement?: string
			value?: unknown
			options?: {
				caseSensitive?: boolean
				regex?: boolean
				wholeWord?: boolean
				contextBefore?: number
				contextAfter?: number
				maxMatches?: number
				spaces?: number
			}
		}>
		dryRun?: boolean
		rollbackOnError?: boolean
	}): Promise<RepoSessionApplyEditsResult> {
		const { sessionRow } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		const result = await this.applyWorkspaceEdits(input)
		await updateRepoSession(this.env.APP_DB, {
			id: input.sessionId,
			userId: sessionRow.user_id,
			lastCheckpointAt: nowIso(),
		})
		return result
	}

	async runChecks(input: {
		sessionId: string
		userId: string
	}): Promise<RepoSessionCheckRun> {
		const { sessionRow, source } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		const manifestPath = resolveRepoWorkspacePath(
			source.manifest_path,
			repoSessionWorkspacePrefix,
		)
		const sourceRoot = resolveRepoWorkspacePath(
			source.source_root || repoSessionWorkspacePrefix,
			repoSessionWorkspacePrefix,
		)
		const result = await runRepoChecks({
			workspace: this.workspace,
			manifestPath,
			sourceRoot,
			env: this.env,
			baseUrl: source.source_root,
			userId: input.userId,
		})
		const runId = crypto.randomUUID()
		const treeHash = await this.computeTreeHash()
		const checkedAt = nowIso()
		await updateRepoSession(this.env.APP_DB, {
			id: input.sessionId,
			userId: sessionRow.user_id,
			lastCheckRunId: runId,
			lastCheckTreeHash: treeHash,
			lastCheckpointAt: checkedAt,
		})
		await this.writeCheckStatus({
			runId,
			treeHash,
			checkedAt,
			ok: result.ok,
			results: result.results.map((entry) => ({
				kind: entry.kind,
				ok: entry.ok,
				message: entry.message,
			})),
		})
		return {
			...result,
			runId,
			treeHash,
			checkedAt,
		}
	}

	async getCheckStatus(input: { sessionId: string; userId: string }) {
		await this.getSessionState(input.sessionId, input.userId)
		return this.readCheckStatus()
	}

	async rebaseSession(input: {
		sessionId: string
		userId: string
	}): Promise<RepoSessionRebaseResult> {
		const { sessionRow, source, sessionAccess } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		const sourceRepo = await resolveArtifactSourceRepo(this.env, source.repo_id)
		const sourceInfo = await sourceRepo.info()
		const sourceAccess = await ensureArtifactRepoRemote({
			repo: sourceRepo,
			scope: 'write',
		})
		await this.ensureRemote({
			name: 'source',
			url: buildAuthenticatedArtifactsRemote({
				remote: sourceAccess.remote,
				token: sourceAccess.token,
			}),
		})
		const defaultBranch = sourceInfo?.defaultBranch ?? defaultSessionBranch
		const pullResult = await this.git.pull({
			dir: repoSessionWorkspacePrefix,
			remote: 'source',
			ref: defaultBranch,
			author: sessionCommitAuthor,
			...buildArtifactsGitAuth({ token: sourceAccess.token }),
		})
		const headCommit = await this.getHeadCommit()
		await this.git.push({
			dir: repoSessionWorkspacePrefix,
			remote: 'origin',
			ref: defaultBranch,
			...buildArtifactsGitAuth({ token: sessionAccess.token }),
		})
		await updateRepoSession(this.env.APP_DB, {
			id: sessionRow.id,
			userId: sessionRow.user_id,
			baseCommit: source.published_commit ?? '',
			lastCheckpointCommit: headCommit,
			lastCheckpointAt: nowIso(),
		})
		return {
			ok: true,
			sessionId: sessionRow.id,
			baseCommit: source.published_commit ?? '',
			headCommit,
			merged: pullResult.pulled,
		}
	}

	async publishSession(input: {
		sessionId: string
		userId: string
		force?: boolean
	}): Promise<RepoSessionPublishResult> {
		const { sessionRow, source, sessionAccess } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		const checkStatus = await this.readCheckStatus()
		const currentTreeHash = await this.computeTreeHash()
		if (
			(!input.force && !checkStatus.runId) ||
			(!input.force && !checkStatus.ok) ||
			(!input.force && checkStatus.treeHash !== currentTreeHash)
		) {
			return {
				status: 'checks_outdated',
				sessionId: input.sessionId,
				publishedCommit: null,
				message:
					'Run repo_run_checks on the current session state before publishing.',
			}
		}
		if ((source.published_commit ?? '') !== sessionRow.base_commit) {
			return {
				status: 'base_moved',
				sessionId: input.sessionId,
				publishedCommit: null,
				sessionBaseCommit: sessionRow.base_commit,
				currentPublishedCommit: source.published_commit,
				repairHint: 'repo_rebase_session',
				message:
					'The source repo has moved since this session opened. Rebase the session before publishing.',
			}
		}
		const sourceRepo = await resolveArtifactSourceRepo(this.env, source.repo_id)
		const sourceInfo = await sourceRepo.info()
		const sourceAccess = await ensureArtifactRepoRemote({
			repo: sourceRepo,
			scope: 'write',
		})
		const sessionHeadCommit =
			(await this.commitIfDirty(`Publish repo session ${input.sessionId}`)) ??
			(await this.getHeadCommit())
		await this.git.push({
			dir: repoSessionWorkspacePrefix,
			remote: 'origin',
			ref: await this.getCurrentBranch(
				sourceInfo?.defaultBranch ?? defaultSessionBranch,
			),
			...buildArtifactsGitAuth({ token: sessionAccess.token }),
		})
		await this.ensureRemote({
			name: 'source',
			url: buildAuthenticatedArtifactsRemote({
				remote: sourceAccess.remote,
				token: sourceAccess.token,
			}),
		})
		const targetBranch = sourceInfo?.defaultBranch ?? defaultSessionBranch
		await this.git.push({
			dir: repoSessionWorkspacePrefix,
			remote: 'source',
			ref: targetBranch,
			...buildArtifactsGitAuth({ token: sourceAccess.token }),
		})
		await this.readManifestFromWorkspace(
			source.manifest_path,
			source.entity_kind,
		)
		// Persist the workspace snapshot to BUNDLE_ARTIFACTS_KV so downstream
		// readers like loadPublishedEntitySource can resolve the freshly
		// published commit without round-tripping to Artifacts. Without this,
		// refreshSavedPackageProjection below, as well as every package-backed
		// job run that reaches for the published snapshot, would throw
		// "Published snapshot for source ... was not found" because no writer
		// had stored the snapshot under the new commit.
		//
		// Collect the workspace files BEFORE advancing D1 so a failure to
		// materialize the tree never leaves entity_sources.published_commit
		// pointing at a commit whose snapshot we never wrote.
		const shouldPersistSnapshot =
			sessionHeadCommit != null && hasPublishedRuntimeArtifacts(this.env)
		const snapshotFiles = shouldPersistSnapshot
			? await this.collectWorkspaceFiles()
			: null
		await updateEntitySource(this.env.APP_DB, {
			id: source.id,
			userId: source.user_id,
			publishedCommit: sessionHeadCommit,
			manifestPath: source.manifest_path,
			sourceRoot: source.source_root,
		})
		if (shouldPersistSnapshot && snapshotFiles != null && sessionHeadCommit) {
			try {
				await writePublishedSourceSnapshot({
					env: this.env,
					source: {
						...source,
						published_commit: sessionHeadCommit,
					},
					files: snapshotFiles,
				})
			} catch (snapshotError) {
				// Preserve the original KV failure as the thrown error even if
				// the compensating D1 revert also fails; surfacing the revert
				// error would mask the real root cause and make the orphaned
				// D1 row harder to diagnose.
				try {
					await updateEntitySource(this.env.APP_DB, {
						id: source.id,
						userId: source.user_id,
						publishedCommit: source.published_commit,
						manifestPath: source.manifest_path,
						sourceRoot: source.source_root,
					})
				} catch (revertError) {
					Sentry.captureException(revertError, {
						tags: {
							scope:
								'repo-session.publishSession.revert-after-snapshot-failure',
						},
						extra: {
							sessionId: input.sessionId,
							sourceId: source.id,
							previousPublishedCommit: source.published_commit,
							attemptedPublishedCommit: sessionHeadCommit,
						},
					})
				}
				throw snapshotError
			}
		}
		await updateRepoSession(this.env.APP_DB, {
			id: sessionRow.id,
			userId: sessionRow.user_id,
			status: 'published',
			baseCommit: sessionHeadCommit ?? sessionRow.base_commit,
			lastCheckpointCommit: sessionHeadCommit,
			lastCheckpointAt: nowIso(),
		})
		if (source.entity_kind === 'package') {
			await refreshSavedPackageProjection({
				env: this.env,
				baseUrl: source.source_root,
				userId: source.user_id,
				packageId: source.entity_id,
				sourceId: source.id,
			})
		}
		return {
			status: 'ok',
			sessionId: sessionRow.id,
			publishedCommit: sessionHeadCommit ?? sessionRow.base_commit,
			message: `Published session ${sessionRow.id} to ${source.repo_id}.`,
		}
	}
}

export const RepoSession = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	RepoSessionBase,
)

export function repoSessionRpc(env: Env, sessionId: string) {
	return createRepoSessionRpc(env, sessionId)
}
