import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import {
	Workspace,
	WorkspaceFileSystem,
	createWorkspaceStateBackend,
} from '@cloudflare/shell'
import { createGit } from '@cloudflare/shell/git'
import {
	deleteRepoSession,
	getRepoSessionById,
	insertRepoSession,
	updateRepoSession,
} from './repo-sessions.ts'
import {
	buildAuthenticatedArtifactsRemote,
	resolveArtifactSourceRepo,
	resolveSessionRepo,
} from './artifacts.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { getEntitySourceById, updateEntitySource } from './entity-sources.ts'
import { parseRepoManifest } from './manifest.ts'
import { searchRepoWorkspace } from './repo-session-search.ts'
import { repoSessionRpc as createRepoSessionRpc } from './repo-session-rpc.ts'
import {
	resolveRepoWorkspacePath,
	toExternalRepoPath,
	toRepoSessionInfoResult,
	toRepoSessionTreeResult,
} from './repo-session-tree.ts'
import { runRepoChecks } from './checks.ts'
import {
	type RepoApplyPatchResult,
	type RepoSearchMode,
	type RepoSearchOutputMode,
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

const repoSessionWorkspacePrefix = '/session'
const lastCheckStatusStorageKey = 'repo-session:last-check-status'
const defaultSessionBranch = 'main'
const sessionCommitAuthor = {
	name: 'Kody Repo Session',
	email: 'repo-session@local.invalid',
}

function buildRepoSessionWorkspaceName(sessionId: string) {
	return `repo-session:${sessionId}`
}

function nowIso() {
	return new Date().toISOString()
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
	const tokenSecret = input.token.split('?expires=')[0] ?? input.token
	return {
		url: input.remote,
		username: 'x',
		password: tokenSecret,
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

	private async getSessionState(sessionId: string, userId: string) {
		const sessionRow = await getRepoSessionById(this.env.APP_DB, sessionId)
		if (!sessionRow) {
			throw new Error(`Repo session "${sessionId}" was not found.`)
		}
		if (sessionRow.user_id !== userId) {
			throw new Error(
				`Repo session "${sessionId}" was not found for this user.`,
			)
		}
		const source = await getEntitySourceById(
			this.env.APP_DB,
			sessionRow.source_id,
		)
		if (!source) {
			throw new Error(`Source "${sessionRow.source_id}" was not found.`)
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

	private async computeTreeHash(root = repoSessionWorkspacePrefix) {
		const files = (
			await this.workspace.glob(`${root.replace(/\/+$/, '')}/**/*`)
		)
			.filter((entry) => entry.type === 'file')
			.filter((entry) => !entry.path.includes('/.git/'))
			.sort((left, right) => left.path.localeCompare(right.path))
		const chunks: Array<string> = []
		for (const file of files) {
			const content = await this.workspace.readFile(file.path)
			chunks.push(`${file.path}\n${content ?? ''}\n`)
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
		const hasGitDir = await this.workspace.exists(
			`${repoSessionWorkspacePrefix}/.git/config`,
		)
		if (!hasGitDir) {
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
			const sourceRepo = await resolveArtifactSourceRepo(
				this.env,
				source.repo_id,
			)
			const baseCommit = source.published_commit
			const sessionRepoName = `${source.repo_id}-${input.sessionId}`.slice(
				0,
				63,
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
		return toRepoSessionInfoResult(sessionRow, source)
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
		try {
			await this.workspace.rm(repoSessionWorkspacePrefix, {
				force: true,
				recursive: true,
			})
		} catch {
			// Best effort only; the session row is the source of truth.
		}
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

	async applyPatch(input: {
		sessionId: string
		userId: string
		edits: Array<
			| {
					kind: 'write'
					path: string
					content: string
			  }
			| {
					kind: 'replace'
					path: string
					search: string
					replacement: string
					options?: {
						caseSensitive?: boolean
						regex?: boolean
						wholeWord?: boolean
						contextBefore?: number
						contextAfter?: number
						maxMatches?: number
					}
			  }
			| {
					kind: 'writeJson'
					path: string
					value: unknown
					options?: {
						spaces?: number
					}
			  }
		>
		dryRun?: boolean
		rollbackOnError?: boolean
	}): Promise<RepoApplyPatchResult> {
		return this.applyEdits(input)
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
		const plan = await this.state.planEdits(
			input.edits.map((edit) => {
				const path = resolveRepoWorkspacePath(
					edit.path,
					repoSessionWorkspacePrefix,
				)
				switch (edit.kind) {
					case 'write':
						if (typeof edit.content !== 'string') {
							throw new Error('repo_apply_patch write edits require content.')
						}
						return {
							kind: 'write' as const,
							path,
							content: edit.content,
						}
					case 'replace':
						if (typeof edit.search !== 'string') {
							throw new Error('repo_apply_patch replace edits require search.')
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
		await updateRepoSession(this.env.APP_DB, {
			id: input.sessionId,
			userId: sessionRow.user_id,
			lastCheckpointAt: nowIso(),
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
		const result = await runRepoChecks({
			workspace: this.workspace,
			manifestPath,
			sourceRoot: repoSessionWorkspacePrefix,
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
			token: sourceAccess.token,
			username: 'x',
			password: sourceAccess.token.split('?expires=')[0] ?? sourceAccess.token,
		})
		const headCommit = await this.getHeadCommit()
		await this.git.push({
			dir: repoSessionWorkspacePrefix,
			remote: 'origin',
			ref: defaultBranch,
			token: sessionAccess.token,
			username: 'x',
			password:
				sessionAccess.token.split('?expires=')[0] ?? sessionAccess.token,
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
			token: sessionAccess.token,
			username: 'x',
			password:
				sessionAccess.token.split('?expires=')[0] ?? sessionAccess.token,
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
			token: sourceAccess.token,
			username: 'x',
			password: sourceAccess.token.split('?expires=')[0] ?? sourceAccess.token,
		})
		const manifestContent = await this.workspace.readFile(
			resolveRepoWorkspacePath(
				source.manifest_path,
				repoSessionWorkspacePrefix,
			),
		)
		if (manifestContent == null) {
			throw new Error(`Manifest "${source.manifest_path}" was not found.`)
		}
		const manifest = parseRepoManifest({
			content: manifestContent,
			manifestPath: source.manifest_path,
		})
		await updateEntitySource(this.env.APP_DB, {
			id: source.id,
			userId: source.user_id,
			publishedCommit: sessionHeadCommit,
			manifestPath: source.manifest_path,
			sourceRoot: manifest.sourceRoot?.startsWith('/')
				? manifest.sourceRoot
				: manifest.sourceRoot
					? `/${manifest.sourceRoot}`
					: source.source_root,
		})
		await updateRepoSession(this.env.APP_DB, {
			id: sessionRow.id,
			userId: sessionRow.user_id,
			status: 'published',
			baseCommit: sessionHeadCommit ?? sessionRow.base_commit,
			lastCheckpointCommit: sessionHeadCommit,
			lastCheckpointAt: nowIso(),
		})
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
