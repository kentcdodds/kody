import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { Workspace, WorkspaceFileSystem } from '@cloudflare/shell'
import { createGit } from '@cloudflare/shell/git'
import {
	deleteRepoSession,
	getRepoSessionById,
	insertRepoSession,
	updateRepoSession,
} from './repo-sessions.ts'
import { resolveArtifactSourceRepo, resolveSessionRepo } from './artifacts.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { getEntitySourceById } from './entity-sources.ts'
import { type EntitySourceRow, type RepoSessionRow } from './types.ts'

const repoSessionWorkspacePrefix = '/session'
const defaultRepoSearchLimit = 50

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

export type RepoSessionDiscardResult = {
	ok: true
	sessionId: string
	deleted: boolean
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

	readonly git = createGit(this.fileSystem, repoSessionWorkspacePrefix)

	private initializedSessionId: string | null = null

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

	async getSessionInfo(input: { sessionId: string }) {
		const sessionRow = await getRepoSessionById(
			this.env.APP_DB,
			input.sessionId,
		)
		if (!sessionRow) {
			throw new Error(`Repo session "${input.sessionId}" was not found.`)
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
		return this.toSessionInfo(sessionRow, source)
	}

	async discardSession(input: {
		sessionId: string
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
		path: string
	}): Promise<{ path: string; content: string | null }> {
		await this.getSessionInfo({ sessionId: input.sessionId })
		return {
			path: input.path,
			content: await this.workspace.readFile(
				this.resolveWorkspacePath(input.path),
			),
		}
	}

	async writeFile(input: {
		sessionId: string
		path: string
		content: string
	}): Promise<{ ok: true; path: string }> {
		await this.getSessionInfo({ sessionId: input.sessionId })
		await this.workspace.writeFile(
			this.resolveWorkspacePath(input.path),
			input.content,
		)
		await updateRepoSession(this.env.APP_DB, {
			id: input.sessionId,
			userId: (await this.getSessionInfo({ sessionId: input.sessionId })).id,
		})
		return { ok: true, path: input.path }
	}

	async search(input: {
		sessionId: string
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
		const session = await this.getSessionInfo({ sessionId: input.sessionId })
		const search = normalizeSearchQuery({
			pattern: input.pattern,
			mode: input.mode,
		})
		const root =
			input.path?.trim() || session.source_root || repoSessionWorkspacePrefix
		const globPattern =
			input.glob?.trim() ||
			`${root.replace(/\/+$/, '')}/**/*.{ts,tsx,js,jsx,json,md,css}`
		const files = await this.workspace.glob(globPattern)
		const matchMap = new Map<string, RepoSearchFileMatch>()
		const outputMode = input.outputMode ?? 'content'
		const maxMatches = normalizeSearchLimit(input.limit)
		let totalMatches = 0
		for (const file of files) {
			if (file.type !== 'file') continue
			const content = await this.workspace.readFile(file.path)
			if (content == null) continue
			const matches = searchInText({
				content,
				query: search.query,
				regex: search.regex,
				caseSensitive: input.caseSensitive ?? false,
				contextBefore: input.before ?? 0,
				contextAfter: input.after ?? 0,
				maxMatches,
			})
			if (matches.length === 0) continue
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
			truncated: totalMatches > maxMatches,
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
		getSessionInfo: (payload: { sessionId: string }) => Promise<{
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
		}) => Promise<RepoSessionDiscardResult>
		readFile: (payload: {
			sessionId: string
			path: string
		}) => Promise<{ path: string; content: string | null }>
		writeFile: (payload: {
			sessionId: string
			path: string
			content: string
		}) => Promise<{ ok: true; path: string }>
		search: (payload: {
			sessionId: string
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
	const source = input.content
	const flags = input.caseSensitive ? 'g' : 'gi'
	const pattern = input.regex ? input.query : escapeRegex(input.query)
	const matcher = new RegExp(pattern, flags)
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
	for (const match of source.matchAll(matcher)) {
		if (matches.length >= input.maxMatches) break
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
	return matches
}
