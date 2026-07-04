import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import rawGit from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
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
	resolveArtifactDefaultBranchHead,
	resolveExistingArtifactSourceRepo,
	resolveArtifactSourceRepo,
} from './artifacts.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { getEntitySourceById, updateEntitySource } from './entity-sources.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	collectPublishedPackageArtifactTargets,
	persistPublishedPackageArtifactTarget,
	type PublishedPackageArtifactBuildTarget,
} from '#worker/package-runtime/published-bundle-artifacts.ts'
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
	type EntityKind,
	type EntitySourceRow,
	type RepoSearchMode,
	type RepoSearchOutputMode,
	type RepoExternalPublishResult,
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
import {
	finalizePublishedEntitySource,
	publishFromExternalRef as publishExternalRefSource,
} from './external-publish.ts'
import {
	assertPackagePrivateVisibilityChangeAllowed,
	assertPackageSourceOverwriteAllowed,
	assertPublishedPackageSourceRepoHead,
	buildSourceRecoveryProblemMessage,
	loadPriorPackageManifestContent,
} from './source-safety-policy.ts'
import {
	attachPublishGitNoteBestEffort,
	buildPublishGitNote,
	type KodyPublishGitNoteChecks,
} from './publish-git-notes.ts'
import {
	type RepoGitCommand,
	type RepoRunCommandsResult,
	parseRepoGitCommands,
} from './repo-session-commands.ts'

const repoSessionWorkspacePrefix = '/session'
const lastCheckStatusStorageKey = 'repo-session:last-check-status'
const cachedSessionStateStorageKeyPrefix = 'repo-session:state:'
const defaultSessionBranch = 'main'
const publishedSessionRetentionMs = 14 * 24 * 60 * 60 * 1000
const sessionCommitAuthor = {
	name: 'Kody Repo Session',
	email: 'repo-session@local.invalid',
}

type CachedRepoSessionState = {
	sessionRow: RepoSessionRow
	source: EntitySourceRow
}

type RawGitPushInput = Parameters<typeof rawGit.push>[0]

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
	const compact = value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
	return compact.length > 0 ? compact : 'session'
}

function buildSessionBranchName(sessionId: string) {
	const readable = compactArtifactsRepoSuffix(sessionId).slice(0, 32)
	const unique = crypto.randomUUID().replaceAll('-', '')
	return `sessions/${readable}-${unique}`
}

function buildPublishedSessionExpiresAt(now: Date = new Date()) {
	return new Date(now.valueOf() + publishedSessionRetentionMs).toISOString()
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

	private async touchRepoSession(sessionRow: RepoSessionRow) {
		await updateRepoSession(this.env.APP_DB, {
			id: sessionRow.id,
			userId: sessionRow.user_id,
		})
	}

	private async getSessionState(
		sessionId: string,
		userId: string,
		options: {
			allowedStatuses?: ReadonlyArray<RepoSessionRow['status']>
		} = {},
	) {
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
		const allowedStatuses = options.allowedStatuses ?? ['active']
		if (!allowedStatuses.includes(sessionRow.status)) {
			throw new Error(
				`Repo session "${sessionId}" is ${sessionRow.status}; open a new session before continuing.`,
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
		const sourceRepo = await resolveArtifactSourceRepo(this.env, source.repo_id)
		const access = await ensureArtifactRepoRemote({
			repo: sourceRepo,
			scope: 'write',
		})
		await this.initialize({
			sessionId: sessionRow.id,
			repoRemote: access.remote,
			repoToken: access.token,
			sessionBranch: sessionRow.session_branch,
		})
		return {
			sessionRow,
			source,
			sourceRepo,
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
		expectedPackageScope?: string,
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
				expectedPackageScope,
			})
		}
		return parseRepoManifest({
			content: manifestContent,
			manifestPath,
		})
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

	private async pushBranchToRemoteRef(input: {
		branch: string
		remoteRef: string
		token: string
	}) {
		const auth = buildArtifactsGitAuth({ token: input.token })
		return rawGit.push({
			fs: this.fileSystem as unknown as RawGitPushInput['fs'],
			http,
			dir: repoSessionWorkspacePrefix,
			remote: 'origin',
			ref: input.branch,
			remoteRef: input.remoteRef,
			onAuth() {
				return auth
			},
		})
	}

	private async deleteRemoteBranch(input: { branch: string; token: string }) {
		const auth = buildArtifactsGitAuth({ token: input.token })
		return rawGit.push({
			fs: this.fileSystem as unknown as RawGitPushInput['fs'],
			http,
			dir: repoSessionWorkspacePrefix,
			remote: 'origin',
			ref: input.branch,
			delete: true,
			onAuth() {
				return auth
			},
		})
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

	private async isAncestorCommit(input: {
		ancestor: string
		descendant: string
	}) {
		if (input.ancestor === input.descendant) {
			return true
		}
		// Repo command parsing rejects negative depths; use a positive infinite
		// depth here to request the complete ancestry chain from the git adapter.
		const commits = await this.git.log({
			dir: repoSessionWorkspacePrefix,
			ref: input.descendant,
			depth: Number.POSITIVE_INFINITY,
		})
		return commits.some((commit) => commit.oid === input.ancestor)
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

	private buildPublishGitNoteChecks(
		checkStatus: RepoSessionCheckStatus,
	): KodyPublishGitNoteChecks | null {
		if (!checkStatus.runId || checkStatus.ok == null) {
			return null
		}
		return {
			runId: checkStatus.runId,
			treeHash: checkStatus.treeHash,
			checkedAt: checkStatus.checkedAt,
			ok: checkStatus.ok,
			results: (checkStatus.results ?? []).map((entry) => ({
				kind: entry.kind,
				ok: entry.ok,
				message: entry.message,
			})),
		}
	}

	private async attachSourcePublishGitNote(input: {
		source: EntitySourceRow
		commitOid: string
		remote: string
		token: string
		remoteName?: string
		publishedBy: 'repo_session' | 'source_bootstrap' | 'external_push'
		sessionId?: string | null
		conversationId?: string | null
		baseCommit?: string | null
		previousPublishedCommit?: string | null
		checks?: KodyPublishGitNoteChecks | null
		scope: string
	}) {
		await attachPublishGitNoteBestEffort({
			filesystem: this.fileSystem,
			dir: repoSessionWorkspacePrefix,
			commitOid: input.commitOid,
			remote: input.remote,
			token: input.token,
			remoteName: input.remoteName,
			note: buildPublishGitNote({
				publishedBy: input.publishedBy,
				source: input.source,
				commit: input.commitOid,
				sessionId: input.sessionId,
				conversationId: input.conversationId,
				baseCommit: input.baseCommit,
				previousPublishedCommit: input.previousPublishedCommit,
				checks: input.checks,
			}),
			scope: input.scope,
		})
	}

	private async resolvePublishSource(input: {
		sessionId?: string
		sourceId?: string
		userId: string
	}) {
		if (input.sessionId) {
			const { source } = await this.getSessionState(
				input.sessionId,
				input.userId,
				{ allowedStatuses: ['active', 'published'] },
			)
			return source
		}
		if (!input.sourceId) {
			throw new Error('A sessionId or sourceId is required.')
		}
		const source = await getEntitySourceById(this.env.APP_DB, input.sourceId)
		if (!source || source.user_id !== input.userId) {
			throw new Error('Repo source was not found for this user.')
		}
		return source
	}

	private async listPackageArtifactTargetsForSource(source: EntitySourceRow) {
		if (source.entity_kind !== 'package') return []
		const manifest = await this.readManifestFromWorkspace(
			source.manifest_path,
			source.entity_kind,
		)
		return collectPublishedPackageArtifactTargets(
			manifest as Parameters<typeof collectPublishedPackageArtifactTargets>[0],
		)
	}

	async initialize(input: {
		sessionId: string
		repoRemote: string
		repoToken: string
		sessionBranch?: string | null
	}): Promise<void> {
		if (this.initializedSessionId === input.sessionId) return
		const gitConfigPath = `${repoSessionWorkspacePrefix}/.git/config`
		const hasGitDir = await this.workspace.exists(gitConfigPath)
		if (hasGitDir) {
			const hasExpectedOrigin = await this.hasExpectedOriginRemote(
				input.repoRemote,
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
				...(input.sessionBranch
					? {
							branch: input.sessionBranch,
							singleBranch: true,
						}
					: {}),
				...buildGitCloneAuth({
					remote: input.repoRemote,
					token: input.repoToken,
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
			const baseCommit = source.published_commit
			if (!baseCommit) {
				throw new Error(
					`Source "${source.id}" has no published commit yet. Bootstrap the source repo before opening a repo session.`,
				)
			}
			const sourceHead = await assertPublishedPackageSourceRepoHead({
				env: this.env,
				source,
				operation: 'repo_open_session',
				requirePublishedCommitHead: true,
			})
			const sourceRepo =
				sourceHead?.repo ??
				(await resolveArtifactSourceRepo(this.env, source.repo_id))
			const sourceAccess = await ensureArtifactRepoRemote({
				repo: sourceRepo,
				scope: 'write',
			})
			const sourceBranch =
				sourceHead?.defaultBranch ??
				input.defaultBranch ??
				(await sourceRepo.info())?.defaultBranch ??
				defaultSessionBranch
			if (
				sourceHead &&
				input.defaultBranch &&
				input.defaultBranch !== sourceBranch
			) {
				throw new Error(
					`Source "${source.id}" is published from "${sourceBranch}", not "${input.defaultBranch}".`,
				)
			}
			const sessionBranch = buildSessionBranchName(input.sessionId)
			await this.resetWorkspace()
			await this.workspace.mkdir(repoSessionWorkspacePrefix, {
				recursive: true,
			})
			await this.git.clone({
				dir: repoSessionWorkspacePrefix,
				branch: sourceBranch,
				singleBranch: true,
				...buildGitCloneAuth({
					remote: sourceAccess.remote,
					token: sourceAccess.token,
				}),
			})
			await this.git.checkout({
				dir: repoSessionWorkspacePrefix,
				ref: baseCommit,
				force: true,
			})
			await this.git.checkout({
				dir: repoSessionWorkspacePrefix,
				branch: sessionBranch,
			})
			await this.git.push({
				dir: repoSessionWorkspacePrefix,
				remote: 'origin',
				ref: sessionBranch,
				...buildArtifactsGitAuth({ token: sourceAccess.token }),
			})
			try {
				const now = nowIso()
				const newSessionRow: RepoSessionRow = {
					id: input.sessionId,
					user_id: input.userId,
					source_id: input.sourceId,
					source_repo_id: source.repo_id,
					session_branch: sessionBranch,
					source_branch: sourceBranch,
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
			} catch (error) {
				await this.deleteRemoteBranch({
					branch: sessionBranch,
					token: sourceAccess.token,
				}).catch(() => {})
				throw error
			}
		} else {
			if (sessionRow.user_id !== input.userId) {
				throw new Error(
					`Repo session "${input.sessionId}" was not found for this user.`,
				)
			}
			if (sessionRow.status !== 'active') {
				throw new Error(
					`Repo session "${input.sessionId}" is ${sessionRow.status}; open a new session before continuing.`,
				)
			}
			const source = await getEntitySourceById(
				this.env.APP_DB,
				sessionRow.source_id,
			)
			if (!source) {
				throw new Error(`Source "${sessionRow.source_id}" was not found.`)
			}
			const sourceRepo = await resolveArtifactSourceRepo(
				this.env,
				source.repo_id,
			)
			const access = await ensureArtifactRepoRemote({
				repo: sourceRepo,
				scope: 'write',
			})
			await this.initialize({
				sessionId: sessionRow.id,
				repoRemote: access.remote,
				repoToken: access.token,
				sessionBranch: sessionRow.session_branch,
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
		await this.attachSourcePublishGitNote({
			source,
			commitOid: publishedCommit,
			remote: sourceAccess.remote,
			token: sourceAccess.token,
			remoteName: 'source',
			publishedBy: 'source_bootstrap',
			sessionId: input.sessionId,
			previousPublishedCommit: null,
			scope: 'repo.bootstrapSource.publish-git-note',
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
			{ allowedStatuses: ['active', 'published'] },
		)
		await this.touchRepoSession(sessionRow)
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
		await updateRepoSession(this.env.APP_DB, {
			id: sessionRow.id,
			userId: sessionRow.user_id,
			status: 'discarded',
			expiresAt: buildPublishedSessionExpiresAt(),
			lastCheckpointAt: nowIso(),
		})
		await this.clearCachedSessionState(input.sessionId)
		await this.resetWorkspace()
		return {
			ok: true,
			sessionId: input.sessionId,
			deleted: true,
		}
	}

	async cleanupSessionBranch(input: {
		sessionId: string
		userId: string
		reason: 'expired' | 'abandoned' | 'source_deleted'
	}) {
		const sessionRow = await getRepoSessionById(
			this.env.APP_DB,
			input.sessionId,
		)
		if (!sessionRow) {
			return {
				ok: true as const,
				sessionId: input.sessionId,
				branch: '',
			}
		}
		if (sessionRow.user_id !== input.userId) {
			throw new Error(
				`Repo session "${input.sessionId}" was not found for this user.`,
			)
		}
		const sessionBranch = sessionRow.session_branch
		const source = await getEntitySourceById(
			this.env.APP_DB,
			sessionRow.source_id,
		)
		if (!source) {
			const sourceRepo = await resolveExistingArtifactSourceRepo(
				this.env,
				sessionRow.source_repo_id,
			)
			if (sourceRepo) {
				const access = await ensureArtifactRepoRemote({
					repo: sourceRepo,
					scope: 'write',
				})
				await this.initialize({
					sessionId: sessionRow.id,
					repoRemote: access.remote,
					repoToken: access.token,
					sessionBranch,
				})
				await this.deleteRemoteBranch({
					branch: sessionBranch,
					token: access.token,
				})
			}
			await deleteRepoSession(this.env.APP_DB, input.sessionId)
			await this.clearCachedSessionState(input.sessionId)
			await this.resetWorkspace()
			return {
				ok: true as const,
				sessionId: input.sessionId,
				branch: sessionBranch,
			}
		}
		const sourceRepo = await resolveArtifactSourceRepo(this.env, source.repo_id)
		const access = await ensureArtifactRepoRemote({
			repo: sourceRepo,
			scope: 'write',
		})
		await this.initialize({
			sessionId: sessionRow.id,
			repoRemote: access.remote,
			repoToken: access.token,
			sessionBranch,
		})
		await this.deleteRemoteBranch({
			branch: sessionBranch,
			token: access.token,
		})
		await deleteRepoSession(this.env.APP_DB, input.sessionId)
		await this.clearCachedSessionState(input.sessionId)
		await this.resetWorkspace()
		console.info(
			JSON.stringify({
				message: 'repo session branch deleted',
				reason: input.reason,
			}),
		)
		return {
			ok: true as const,
			sessionId: input.sessionId,
			branch: sessionBranch,
		}
	}

	async readFile(input: {
		sessionId: string
		userId: string
		path: string
	}): Promise<{ path: string; content: string | null }> {
		const { sessionRow } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		await this.touchRepoSession(sessionRow)
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
		await this.touchRepoSession(sessionRow)
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
			const oldPath =
				patch.oldFileName && patch.oldFileName !== '/dev/null'
					? patch.oldFileName.replace(/^[ab]\//, '')
					: null
			const newPath =
				patch.newFileName && patch.newFileName !== '/dev/null'
					? patch.newFileName.replace(/^[ab]\//, '')
					: null
			const targetPath = newPath ?? oldPath
			const sourcePath = oldPath ?? newPath
			if (!targetPath || !sourcePath) {
				throw new Error('git apply patch is missing a target file path.')
			}
			const workspacePath = resolveRepoWorkspacePath(
				targetPath,
				repoSessionWorkspacePrefix,
			)
			const sourceWorkspacePath = resolveRepoWorkspacePath(
				sourcePath,
				repoSessionWorkspacePrefix,
			)
			const currentContent =
				(await this.workspace.readFile(sourceWorkspacePath)) ?? ''
			const nextContent = applyPatch(currentContent, patch)
			if (nextContent === false) {
				throw new Error(
					`git apply patch did not apply cleanly to ${targetPath}.`,
				)
			}
			if (!input.dryRun) {
				if (patch.newFileName === '/dev/null') {
					await this.workspace.rm(workspacePath, { force: true })
				} else {
					await this.workspace.writeFile(workspacePath, nextContent)
					if (oldPath && newPath && oldPath !== newPath) {
						await this.workspace.rm(sourceWorkspacePath, { force: true })
					}
				}
			}
			edits.push({
				path: targetPath,
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
		expectedPackageScope?: string
	}): Promise<RepoRunCommandsResult> {
		const { sessionRow } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		const shouldRunChecks = input.runChecks ?? false
		const shouldPublish = input.publish ?? false
		if (!shouldRunChecks && shouldPublish) {
			throw new Error(
				'Publishing requires checks. Set runChecks to true when publish is true.',
			)
		}
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
		if (!shouldRunChecks) {
			return {
				session: await this.getSessionInfo(input),
				commands: results,
				checks: { status: 'not_requested' },
				publish: { status: 'not_requested' },
			}
		}
		const checkRun = await this.runChecks({
			sessionId: input.sessionId,
			userId: input.userId,
			expectedPackageScope: input.expectedPackageScope,
		})
		if (!checkRun.ok) {
			const publish = shouldPublish
				? {
						status: 'blocked_by_checks' as const,
						message: 'Publishing skipped because repo checks failed.',
					}
				: { status: 'not_requested' as const }
			return {
				session: await this.getSessionInfo(input),
				commands: results,
				checks: {
					...checkRun,
					status: 'failed',
					ok: false,
					failedChecks: checkRun.results.filter((entry) => !entry.ok),
				},
				publish,
			}
		}
		const publish = shouldPublish
			? await this.publishSession(input)
			: { status: 'not_requested' as const }
		return {
			session: await this.getSessionInfo(input),
			commands: results,
			checks: {
				...checkRun,
				status: 'passed',
				ok: true,
			},
			publish,
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
		await this.touchRepoSession(sessionRow)
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
		expectedPackageScope?: string
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
			expectedPackageScope:
				source.entity_kind === 'package'
					? input.expectedPackageScope
					: undefined,
		})
		const { sourceFiles: _sourceFiles, ...publicResult } = result
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
			ok: publicResult.ok,
			results: publicResult.results.map((entry) => ({
				kind: entry.kind,
				ok: entry.ok,
				message: entry.message,
			})),
		})
		return {
			...publicResult,
			runId,
			treeHash,
			checkedAt,
		}
	}

	async getCheckStatus(input: { sessionId: string; userId: string }) {
		const { sessionRow } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		await this.touchRepoSession(sessionRow)
		return this.readCheckStatus()
	}

	async listPublishedPackageArtifactTargets(input: {
		sessionId?: string
		sourceId?: string
		userId: string
	}): Promise<Array<PublishedPackageArtifactBuildTarget>> {
		const source = await this.resolvePublishSource(input)
		return await this.listPackageArtifactTargetsForSource(source)
	}

	async rebuildPublishedPackageArtifact(input: {
		sessionId?: string
		sourceId?: string
		userId: string
		publishedCommit: string
		target: PublishedPackageArtifactBuildTarget
		baseUrl?: string
	}): Promise<{
		ok: true
		target: PublishedPackageArtifactBuildTarget
		kvKey: string | null
	}> {
		const source = await this.resolvePublishSource(input)
		if (source.entity_kind !== 'package') {
			throw new Error(
				'Published bundle artifacts can only be rebuilt for packages.',
			)
		}
		const savedPackage = await getSavedPackageById(this.env.APP_DB, {
			userId: input.userId,
			packageId: source.entity_id,
		})
		if (!savedPackage) {
			throw new Error(`Saved package "${source.entity_id}" was not found.`)
		}
		const sourceFiles = await this.collectWorkspaceFiles()
		const sourceAtPublishedCommit = {
			...source,
			published_commit: input.publishedCommit,
		}
		const {
			buildKodyAppBundle,
			buildKodyModuleBundle,
			buildKodyImportableModuleBundle,
		} = await import('#worker/package-runtime/module-graph.ts')
		const kvKey = await persistPublishedPackageArtifactTarget({
			env: this.env,
			userId: input.userId,
			source: sourceAtPublishedCommit,
			savedPackage,
			target: input.target,
			buildAppBundle: async ({ entryPoint }) =>
				await buildKodyAppBundle({
					env: this.env,
					baseUrl: input.baseUrl ?? source.source_root,
					userId: input.userId,
					sourceFiles,
					entryPoint,
					cacheKey: null,
				}),
			buildModuleBundle: async ({ entryPoint }) =>
				await buildKodyModuleBundle({
					env: this.env,
					baseUrl: input.baseUrl ?? source.source_root,
					userId: input.userId,
					sourceFiles,
					entryPoint,
				}),
			buildImportableModuleBundle: async ({ entryPoint }) =>
				await buildKodyImportableModuleBundle({
					env: this.env,
					baseUrl: input.baseUrl ?? source.source_root,
					userId: input.userId,
					sourceFiles,
					entryPoint,
				}),
		})
		return {
			ok: true,
			target: input.target,
			kvKey,
		}
	}

	async rebaseSession(input: {
		sessionId: string
		userId: string
	}): Promise<RepoSessionRebaseResult> {
		const { sessionRow, source, sessionAccess } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		const sessionBranch = sessionRow.session_branch
		const pullResult = await this.git.pull({
			dir: repoSessionWorkspacePrefix,
			remote: 'origin',
			ref: sessionRow.source_branch,
			author: sessionCommitAuthor,
			...buildArtifactsGitAuth({ token: sessionAccess.token }),
		})
		const headCommit = await this.getHeadCommit()
		await this.git.push({
			dir: repoSessionWorkspacePrefix,
			remote: 'origin',
			ref: sessionBranch,
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
		destructiveOverwriteConfirmed?: boolean
		privateVisibilityChangeConfirmed?: boolean
		rebuildPackageArtifacts?: boolean
		expectedPackageScope?: string
	}): Promise<RepoSessionPublishResult> {
		const { sessionRow, source, sessionAccess } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		const sessionBranch = sessionRow.session_branch
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
		if (input.force === true && source.entity_kind === 'package') {
			await assertPackageSourceOverwriteAllowed({
				env: this.env,
				userId: input.userId,
				source,
				operation: 'repo forced publish',
				confirmed: input.destructiveOverwriteConfirmed,
			})
		}
		if (source.entity_kind === 'package') {
			const workspaceFiles = await this.collectWorkspaceFiles()
			const afterContent = workspaceFiles[source.manifest_path]
			if (typeof afterContent !== 'string') {
				throw new Error(`Manifest "${source.manifest_path}" was not found.`)
			}
			const beforeContent = await loadPriorPackageManifestContent({
				env: this.env,
				userId: input.userId,
				source,
			})
			assertPackagePrivateVisibilityChangeAllowed({
				beforeContent,
				afterContent,
				isNewPackage: false,
				operation: 'repo publish',
				confirmed: input.privateVisibilityChangeConfirmed,
			})
		}
		const sessionHeadCommit =
			(await this.commitIfDirty(`Publish repo session ${input.sessionId}`)) ??
			(await this.getHeadCommit())
		await this.readManifestFromWorkspace(
			source.manifest_path,
			source.entity_kind,
			input.expectedPackageScope,
		)
		await this.git.push({
			dir: repoSessionWorkspacePrefix,
			remote: 'origin',
			ref: sessionBranch,
			...buildArtifactsGitAuth({ token: sessionAccess.token }),
		})
		await this.pushBranchToRemoteRef({
			branch: sessionBranch,
			remoteRef: sessionRow.source_branch,
			token: sessionAccess.token,
		})
		const snapshotFiles = await this.collectWorkspaceFiles()
		await finalizePublishedEntitySource({
			env: this.env,
			source,
			publishedCommit: sessionHeadCommit ?? sessionRow.base_commit,
			files: snapshotFiles,
			baseUrl: source.source_root,
			rebuildPackageArtifacts: input.rebuildPackageArtifacts ?? true,
		})
		const publishedCommit = sessionHeadCommit ?? sessionRow.base_commit
		await this.attachSourcePublishGitNote({
			source,
			commitOid: publishedCommit,
			remote: sessionAccess.remote,
			token: sessionAccess.token,
			remoteName: 'origin',
			publishedBy: 'repo_session',
			sessionId: sessionRow.id,
			conversationId: sessionRow.conversation_id,
			baseCommit: sessionRow.base_commit,
			previousPublishedCommit: source.published_commit,
			checks: this.buildPublishGitNoteChecks(checkStatus),
			scope: 'repo.publishSession.publish-git-note',
		})
		await updateRepoSession(this.env.APP_DB, {
			id: sessionRow.id,
			userId: sessionRow.user_id,
			status: 'published',
			baseCommit: sessionHeadCommit ?? sessionRow.base_commit,
			lastCheckpointCommit: sessionHeadCommit,
			lastCheckpointAt: nowIso(),
			expiresAt: buildPublishedSessionExpiresAt(),
		})
		return {
			status: 'ok',
			sessionId: sessionRow.id,
			publishedCommit: sessionHeadCommit ?? sessionRow.base_commit,
			message: `Published session ${sessionRow.id} to ${source.repo_id}.`,
		}
	}

	async publishFromExternalRef(input: {
		sessionId: string
		sourceId: string
		userId: string
		newCommit: string
		expectedHead?: string | null
		allowForce?: boolean
		destructiveOverwriteConfirmed?: boolean
		baseUrl?: string
		rebuildPackageArtifacts?: boolean
		expectedPackageScope?: string
	}): Promise<RepoExternalPublishResult> {
		const source = await getEntitySourceById(this.env.APP_DB, input.sourceId)
		if (!source || source.user_id !== input.userId) {
			throw new Error('Repo source was not found for this user.')
		}
		const sourceRepo = await resolveArtifactSourceRepo(this.env, source.repo_id)
		const sourceInfo = await sourceRepo.info()
		const sourceAccess = await ensureArtifactRepoRemote({
			repo: sourceRepo,
			scope: 'read',
		})
		const targetBranch = sourceInfo?.defaultBranch ?? defaultSessionBranch
		if (input.expectedHead) {
			const currentHead = await resolveArtifactDefaultBranchHead({
				repo: sourceRepo,
			})
			if (currentHead?.commit !== input.expectedHead) {
				throw new Error(
					`Artifacts HEAD changed from "${input.expectedHead}" to "${currentHead?.commit ?? 'unknown'}" before publish.`,
				)
			}
		}
		await this.resetWorkspace()
		await this.workspace.mkdir(repoSessionWorkspacePrefix, {
			recursive: true,
		})
		try {
			await this.git.clone({
				dir: repoSessionWorkspacePrefix,
				branch: targetBranch,
				singleBranch: true,
				...buildGitCloneAuth({
					remote: sourceAccess.remote,
					token: sourceAccess.token,
				}),
			})
			await this.git.checkout({
				dir: repoSessionWorkspacePrefix,
				ref: input.newCommit,
				force: true,
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			throw new Error(
				buildSourceRecoveryProblemMessage({
					source,
					operation: 'package_publish_external_push',
					reason: `source clone or commit checkout failed: ${message}`,
				}),
				{ cause: error },
			)
		}
		const runId = crypto.randomUUID()
		const publishResult = await publishExternalRefSource({
			env: this.env,
			sourceId: source.id,
			userId: input.userId,
			newCommit: input.newCommit,
			runId,
			isFastForward: async ({ previousCommit }) =>
				await this.isAncestorCommit({
					ancestor: previousCommit,
					descendant: input.newCommit,
				}),
			allowForce: input.allowForce,
			destructiveOverwriteConfirmed: input.destructiveOverwriteConfirmed,
			workspace: this.workspace,
			baseUrl: input.baseUrl ?? source.source_root,
			manifestPath: resolveRepoWorkspacePath(
				source.manifest_path,
				repoSessionWorkspacePrefix,
			),
			sourceRoot: resolveRepoWorkspacePath(
				source.source_root || repoSessionWorkspacePrefix,
				repoSessionWorkspacePrefix,
			),
			rebuildPackageArtifacts: input.rebuildPackageArtifacts ?? true,
			expectedPackageScope: input.expectedPackageScope,
		})
		if (publishResult.status === 'published') {
			try {
				const sourceWriteAccess = await ensureArtifactRepoRemote({
					repo: sourceRepo,
					scope: 'write',
				})
				await this.attachSourcePublishGitNote({
					source,
					commitOid: input.newCommit,
					remote: sourceWriteAccess.remote,
					token: sourceWriteAccess.token,
					remoteName: 'origin',
					publishedBy: 'external_push',
					sessionId: input.sessionId,
					previousPublishedCommit: publishResult.previous_commit,
					checks: {
						runId,
						treeHash: null,
						checkedAt: new Date().toISOString(),
						ok: true,
						results: publishResult.checks.map((entry) => ({
							kind: entry.kind,
							ok: entry.ok,
							message: entry.message,
						})),
					},
					scope: 'repo.publishFromExternalRef.publish-git-note',
				})
			} catch (error) {
				Sentry.captureException(error, {
					tags: { scope: 'repo.publishFromExternalRef.publish-git-note-setup' },
					extra: {
						sourceId: source.id,
						commit: input.newCommit,
					},
				})
				console.warn('publish_git_note setup failed', {
					scope: 'repo.publishFromExternalRef.publish-git-note-setup',
					sourceId: source.id,
					commit: input.newCommit,
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}
		return publishResult
	}
}

export const RepoSession = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	RepoSessionBase,
)

export function repoSessionRpc(env: Env, sessionId: string) {
	return createRepoSessionRpc(env, sessionId)
}
