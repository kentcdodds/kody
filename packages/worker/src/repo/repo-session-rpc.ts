import {
	type RepoSourceBootstrapResult,
	type RepoSearchMode,
	type RepoSearchOutputMode,
	type RepoSessionApplyEditsResult,
	type RepoSessionCheckRun,
	type RepoSessionCheckStatus,
	type RepoSessionDiscardResult,
	type RepoSessionEdit,
	type RepoSessionInfoResult,
	type RepoSessionPublishResult,
	type RepoSessionRebaseResult,
	type RepoSessionSearchResult,
	type RepoSessionTreeResult,
} from './types.ts'

export type RepoSessionRpc = {
	openSession: (payload: {
		sessionId: string
		sourceId: string
		userId: string
		baseUrl: string
		conversationId?: string | null
		sourceRoot?: string | null
		defaultBranch?: string | null
	}) => Promise<RepoSessionInfoResult>
	getSessionInfo: (payload: {
		sessionId: string
		userId: string
	}) => Promise<RepoSessionInfoResult>
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
		edits: Array<RepoSessionEdit>
		dryRun?: boolean
		rollbackOnError?: boolean
	}) => Promise<RepoSessionApplyEditsResult>
	bootstrapSource: (payload: {
		sessionId: string
		sourceId: string
		userId: string
		edits: Array<RepoSessionEdit>
	}) => Promise<RepoSourceBootstrapResult>
	runChecks: (payload: {
		sessionId: string
		userId: string
	}) => Promise<RepoSessionCheckRun>
	getCheckStatus: (payload: {
		sessionId: string
		userId: string
	}) => Promise<RepoSessionCheckStatus>
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

export function repoSessionRpc(env: Env, sessionId: string): RepoSessionRpc {
	const namespace = (
		env as Env & { REPO_SESSION?: DurableObjectNamespace | undefined }
	).REPO_SESSION
	if (!namespace) {
		throw new Error('REPO_SESSION binding is not configured.')
	}
	return namespace.get(
		namespace.idFromName(sessionId),
	) as unknown as RepoSessionRpc
}
