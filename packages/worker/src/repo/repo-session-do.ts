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
import { type EntitySourceRow, type RepoSessionRow } from './types.ts'
import { runRepoChecks, type RepoCheckRunResult } from './checks.ts'

const repoSessionWorkspacePrefix = '/session'
const defaultRepoSearchLimit = 50
const maxRepoSearchBytes = 200_000
const maxRepoSearchRegexLength = 512
const obviousNestedQuantifierPattern =
	/\((?:[^()\\]|\\.)*[+*{][^)]*\)(?:[+*]|\{\d+(?:,\d*)?\})/

export type RepoSearchMode = 'literal' | 'regex'
export type RepoSearchOutputMode = 'content' | 'files'

export type RepoSearchMatch = {
	line: number
	column: number
	match: string
	lineText: string
	beforeLines: Array<string>
	afterLines: Array<string>
}

export type RepoSearchFileMatch = {
	path: string
	matches: Array<RepoSearchMatch>
}

export type RepoSessionSearchResult = {
	files: Array<RepoSearchFileMatch>
	totalFiles: number
	totalMatches: number
	outputMode: RepoSearchOutputMode
	truncated: boolean
}

export type RepoApplyPatchResult = {
	dryRun: boolean
	totalChanged: number
	edits: Array<{
		path: string
		changed: boolean
		content: string
		diff: string
	}>
}

export type RepoSessionTreeResult = {
	path: string
	name: string
	type: 'file' | 'directory' | 'symlink'
	size: number
	children?: Array<RepoSessionTreeResult>
}

export type RepoSessionApplyEditsResult = {
	dryRun: boolean
	totalChanged: number
	edits: Array<{
		path: string
		changed: boolean
		content: string
		diff: string
	}>
}

export type RepoSessionCheckRun = RepoCheckRunResult & {
	runId: string
	treeHash: string
	checkedAt: string
}

export type RepoSessionDiscardResult = {
	ok: true
	sessionId: string
	deleted: boolean
}

export type RepoSessionCheckStatus = {
	runId: string | null
	treeHash: string | null
	checkedAt: string | null
	ok: boolean | null
	results: Array<{
		kind: string
		ok: boolean
		message: string
	}> | null
}

export type RepoSessionPublishResult =
	| {
			status: 'ok'
			sessionId: string
			publishedCommit: string
			message: string
	  }
	| {
			status: 'checks_outdated' | 'base_moved'
			sessionId: string
			message: string
			publishedCommit: null
	  }

export type RepoSessionRebaseResult = {
	ok: true
	sessionId: string
	baseCommit: string
	headCommit: string | null
	merged: boolean
}

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

function normalizeSearchLimit(limit: number | undefined) {
	if (!Number.isFinite(limit)) return defaultRepoSearchLimit
	return Math.min(Math.max(Math.trunc(limit as number), 1), 200)
}

function escapeRegex(source: string) {
	return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function assertSafeRepoSearchRegex(pattern: string) {
	if (pattern.length > maxRepoSearchRegexLength) {
		throw new Error(
			`repo_search regex patterns must be ${maxRepoSearchRegexLength} characters or fewer.`,
		)
	}
	if (obviousNestedQuantifierPattern.test(pattern)) {
		throw new Error(
			'repo_search rejected an unsafe regex pattern with nested quantifiers.',
		)
	}
}

function normalizeSearchQuery(input: {
	pattern: string
	mode?: RepoSearchMode
}) {
	const pattern = input.pattern.trim()
	if (!pattern) {
		throw new Error('repo_search requires a non-empty pattern.')
	}
	return {
		query: pattern,
		regex: input.mode === 'regex',
	}
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
		return this.toSessionInfo(sessionRow, source)
	}

	async getSessionInfo(input: { sessionId: string; userId: string }) {
		const { sessionRow, source } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		return this.toSessionInfo(sessionRow, source)
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
				this.resolveWorkspacePath(input.path),
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
			this.resolveWorkspacePath(input.path),
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
		const search = normalizeSearchQuery({
			pattern: input.pattern,
			mode: input.mode,
		})
		const root =
			input.path?.trim() || sessionRow.source_root || repoSessionWorkspacePrefix
		const globPattern =
			input.glob?.trim() ||
			`${root.replace(/\/+$/, '')}/**/*.{ts,tsx,js,jsx,json,md,css}`
		const files = await this.workspace.glob(globPattern)
		const matchMap = new Map<string, RepoSearchFileMatch>()
		const outputMode = input.outputMode ?? 'content'
		const maxMatches = normalizeSearchLimit(input.limit)
		let totalMatches = 0
		let truncated = false
		for (const file of files) {
			if (file.type !== 'file') continue
			const content = await this.workspace.readFile(file.path)
			if (content == null) continue
			const result = searchInText({
				content,
				query: search.query,
				regex: search.regex,
				caseSensitive: input.caseSensitive ?? false,
				contextBefore: input.before ?? 0,
				contextAfter: input.after ?? 0,
				maxMatches,
			})
			const matches = result.matches
			if (matches.length === 0) continue
			truncated ||= result.truncated
			matchMap.set(file.path, {
				path: this.toExternalPath(file.path),
				matches:
					outputMode === 'files'
						? []
						: matches.map<RepoSearchMatch>((match) => ({
								line: match.line,
								column: match.column,
								match: match.match,
								lineText: match.lineText,
								beforeLines: match.beforeLines ?? [],
								afterLines: match.afterLines ?? [],
							})),
			})
			totalMatches += matches.length
		}
		const filesWithMatches = [...matchMap.values()].sort((left, right) =>
			left.path.localeCompare(right.path),
		)
		return {
			files: filesWithMatches,
			totalFiles: filesWithMatches.length,
			totalMatches,
			outputMode,
			truncated,
		}
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
		const root = this.resolveWorkspacePath(
			input.path?.trim() ||
				sessionRow.source_root ||
				repoSessionWorkspacePrefix,
		)
		const tree = await this.state.walkTree(root, {
			maxDepth: input.maxDepth,
		})
		return this.toTreeResult(tree)
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
				const path = this.resolveWorkspacePath(edit.path)
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
				path: this.toExternalPath(edit.path),
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
		const manifestPath = this.resolveWorkspacePath(source.manifest_path)
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
		const { sessionRow, source } = await this.getSessionState(
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
			token: sourceAccess.token,
			username: 'x',
			password: sourceAccess.token.split('?expires=')[0] ?? sourceAccess.token,
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
		const { sessionRow, source } = await this.getSessionState(
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
			token: sourceAccess.token,
			username: 'x',
			password: sourceAccess.token.split('?expires=')[0] ?? sourceAccess.token,
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
			this.resolveWorkspacePath(source.manifest_path),
		)
		if (manifestContent == null) {
			throw new Error(`Manifest "${source.manifest_path}" was not found.`)
		}
		const manifest = await import('./manifest.ts').then((module) =>
			module.parseRepoManifest({
				content: manifestContent,
				manifestPath: source.manifest_path,
			}),
		)
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

	private resolveWorkspacePath(path: string) {
		const trimmed = path.trim()
		if (!trimmed) {
			throw new Error('A non-empty repo path is required.')
		}
		if (trimmed.startsWith(repoSessionWorkspacePrefix)) {
			return trimmed
		}
		return `${repoSessionWorkspacePrefix}/${trimmed.replace(/^\/+/, '')}`
	}

	private toExternalPath(path: string) {
		return path.startsWith(`${repoSessionWorkspacePrefix}/`)
			? path.slice(repoSessionWorkspacePrefix.length + 1)
			: path
	}

	private normalizeUnknownTreeChild(
		child: unknown,
		parentPath: string,
	): {
		path: string
		name: string
		type: 'file' | 'directory' | 'symlink'
		size: number
		children?: Array<unknown>
	} {
		const input =
			child && typeof child === 'object'
				? (child as Record<string, unknown>)
				: ({} as Record<string, unknown>)
		return {
			path:
				typeof input.path === 'string' ? input.path : `${parentPath}/unknown`,
			name: typeof input.name === 'string' ? input.name : 'unknown',
			type:
				input.type === 'file' ||
				input.type === 'directory' ||
				input.type === 'symlink'
					? input.type
					: 'file',
			size: typeof input.size === 'number' ? input.size : 0,
			children: Array.isArray(input.children)
				? (input.children as Array<unknown>)
				: undefined,
		}
	}

	private toTreeResult(node: {
		path: string
		name: string
		type: 'file' | 'directory' | 'symlink'
		size: number
		children?: Array<unknown>
	}): RepoSessionTreeResult {
		return {
			path: this.toExternalPath(node.path),
			name: node.name,
			type: node.type,
			size: node.size,
			children: node.children?.map(
				(child): RepoSessionTreeResult =>
					this.toTreeResult(this.normalizeUnknownTreeChild(child, node.path)),
			),
		}
	}

	private toSessionInfo(session: RepoSessionRow, source: EntitySourceRow) {
		return {
			id: session.id,
			source_id: session.source_id,
			source_root: session.source_root,
			base_commit: session.base_commit,
			session_repo_id: session.session_repo_id,
			session_repo_name: session.session_repo_name,
			session_repo_namespace: session.session_repo_namespace,
			conversation_id: session.conversation_id,
			last_checkpoint_commit: session.last_checkpoint_commit,
			last_check_run_id: session.last_check_run_id,
			last_check_tree_hash: session.last_check_tree_hash,
			expires_at: session.expires_at,
			created_at: session.created_at,
			updated_at: session.updated_at,
			published_commit: source.published_commit,
			manifest_path: source.manifest_path,
			entity_type: source.entity_kind,
		}
	}
}

export const RepoSession = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	RepoSessionBase,
)

export function repoSessionRpc(env: Env, sessionId: string) {
	const namespace = (
		env as Env & { REPO_SESSION?: DurableObjectNamespace | undefined }
	).REPO_SESSION
	if (!namespace) {
		throw new Error('REPO_SESSION binding is not configured.')
	}
	return namespace.get(namespace.idFromName(sessionId)) as unknown as {
		openSession: (payload: {
			sessionId: string
			sourceId: string
			userId: string
			baseUrl: string
			conversationId?: string | null
			sourceRoot?: string | null
			defaultBranch?: string | null
		}) => Promise<{
			id: string
			source_id: string
			source_root: string
			base_commit: string
			session_repo_id: string
			session_repo_name: string
			session_repo_namespace: string
			conversation_id: string | null
			last_checkpoint_commit: string | null
			last_check_run_id: string | null
			last_check_tree_hash: string | null
			expires_at: string | null
			created_at: string
			updated_at: string
			published_commit: string | null
			manifest_path: string
			entity_type: 'skill' | 'app' | 'job'
		}>
		getSessionInfo: (payload: {
			sessionId: string
			userId: string
		}) => Promise<{
			id: string
			source_id: string
			source_root: string
			base_commit: string
			session_repo_id: string
			session_repo_name: string
			session_repo_namespace: string
			conversation_id: string | null
			last_checkpoint_commit: string | null
			last_check_run_id: string | null
			last_check_tree_hash: string | null
			expires_at: string | null
			created_at: string
			updated_at: string
			published_commit: string | null
			manifest_path: string
			entity_type: 'skill' | 'app' | 'job'
		}>
		discardSession: (payload: {
			sessionId: string
			userId: string
		}) => Promise<RepoSessionDiscardResult>
		readFile: (payload: {
			sessionId: string
			userId: string
			path: string
		}) => Promise<{ path: string; content: string | null }>
		writeFile: (payload: {
			sessionId: string
			userId: string
			path: string
			content: string
		}) => Promise<{ ok: true; path: string }>
		search: (payload: {
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
		}) => Promise<RepoSessionSearchResult>
		tree: (payload: {
			sessionId: string
			userId: string
			path?: string | null
			maxDepth?: number
		}) => Promise<RepoSessionTreeResult>
		applyEdits: (payload: {
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
		}) => Promise<RepoSessionApplyEditsResult>
		runChecks: (payload: {
			sessionId: string
			userId: string
		}) => Promise<RepoSessionCheckRun>
		getCheckStatus: (payload: {
			sessionId: string
			userId: string
		}) => Promise<ReturnType<RepoSessionBase['readCheckStatus']>>
		rebaseSession: (payload: {
			sessionId: string
			userId: string
		}) => Promise<RepoSessionRebaseResult>
		publishSession: (payload: {
			sessionId: string
			userId: string
			force?: boolean
		}) => Promise<RepoSessionPublishResult>
	}
}

function searchInText(input: {
	content: string
	query: string
	regex: boolean
	caseSensitive: boolean
	contextBefore: number
	contextAfter: number
	maxMatches: number
}) {
	const inputTruncated = input.content.length > maxRepoSearchBytes
	// Bound regex work so a single pathological search cannot monopolize the DO.
	const source = inputTruncated
		? input.content.slice(0, maxRepoSearchBytes)
		: input.content
	const flags = input.caseSensitive ? 'g' : 'gi'
	const pattern = input.regex ? input.query : escapeRegex(input.query)
	if (input.regex) {
		assertSafeRepoSearchRegex(pattern)
	}
	let matcher: RegExp
	try {
		matcher = new RegExp(pattern, flags)
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: 'Unknown regex compilation error.'
		throw new Error(`repo_search received an invalid regex: ${message}`)
	}
	const lines = source.split('\n')
	const lineOffsets: number[] = []
	let offset = 0
	for (const line of lines) {
		lineOffsets.push(offset)
		offset += line.length + 1
	}
	const matches: Array<{
		line: number
		column: number
		match: string
		lineText: string
		beforeLines?: string[]
		afterLines?: string[]
	}> = []
	let truncated = false
	for (const match of source.matchAll(matcher)) {
		if (matches.length >= input.maxMatches) {
			truncated = true
			break
		}
		const index = match.index ?? 0
		let lineIndex = 0
		for (let candidate = 0; candidate < lineOffsets.length; candidate += 1) {
			const candidateOffset = lineOffsets[candidate]
			if (candidateOffset === undefined) break
			if (candidateOffset > index) break
			lineIndex = candidate
		}
		const lineStart = lineOffsets[lineIndex] ?? 0
		const column = index - lineStart + 1
		const lineText = lines[lineIndex] ?? ''
		const beforeStart = Math.max(0, lineIndex - input.contextBefore)
		const afterEnd = Math.min(lines.length, lineIndex + input.contextAfter + 1)
		matches.push({
			line: lineIndex + 1,
			column,
			match: match[0] ?? '',
			lineText,
			beforeLines: lines.slice(beforeStart, lineIndex),
			afterLines: lines.slice(lineIndex + 1, afterEnd),
		})
	}
	return {
		matches,
		truncated: truncated || inputTruncated,
	}
}
