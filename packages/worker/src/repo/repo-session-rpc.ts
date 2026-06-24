import { type ArtifactBootstrapAccess } from './artifacts.ts'
import { type PublishedPackageArtifactBuildTarget } from '#worker/package-runtime/published-bundle-artifacts.ts'
import { type RepoRunCommandsResult } from './repo-session-commands.ts'
import {
	type RepoSourceBootstrapResult,
	type RepoSearchMode,
	type RepoSearchOutputMode,
	type RepoSessionApplyEditsResult,
	type RepoSessionCheckRun,
	type RepoSessionCheckStatus,
	type RepoSessionDiscardResult,
	type RepoSessionEdit,
	type RepoExternalPublishResult,
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
	cleanupSessionBranch: (payload: {
		sessionId: string
		userId: string
		reason: 'expired' | 'abandoned' | 'source_deleted'
	}) => Promise<{ ok: true; sessionId: string; branch: string }>
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
	runCommands: (payload: {
		sessionId: string
		userId: string
		commands: string
		dryRun?: boolean
		runChecks?: boolean
		publish?: boolean
		expectedPackageScope?: string
	}) => Promise<RepoRunCommandsResult>
	bootstrapSource: (payload: {
		sessionId: string
		sourceId: string
		userId: string
		edits: Array<RepoSessionEdit>
		bootstrapAccess?: ArtifactBootstrapAccess | null
	}) => Promise<RepoSourceBootstrapResult>
	runChecks: (payload: {
		sessionId: string
		userId: string
		expectedPackageScope?: string
	}) => Promise<RepoSessionCheckRun>
	getCheckStatus: (payload: {
		sessionId: string
		userId: string
	}) => Promise<RepoSessionCheckStatus>
	listPublishedPackageArtifactTargets: (payload: {
		sessionId?: string
		sourceId?: string
		userId: string
	}) => Promise<Array<PublishedPackageArtifactBuildTarget>>
	rebuildPublishedPackageArtifact: (payload: {
		sessionId?: string
		sourceId?: string
		userId: string
		publishedCommit: string
		target: PublishedPackageArtifactBuildTarget
		baseUrl?: string
	}) => Promise<{
		ok: true
		target: PublishedPackageArtifactBuildTarget
		kvKey: string | null
	}>
	rebaseSession: (payload: {
		sessionId: string
		userId: string
	}) => Promise<RepoSessionRebaseResult>
	publishSession: (payload: {
		sessionId: string
		userId: string
		force?: boolean
		destructiveOverwriteConfirmed?: boolean
		rebuildPackageArtifacts?: boolean
		expectedPackageScope?: string
	}) => Promise<RepoSessionPublishResult>
	publishFromExternalRef: (payload: {
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
	}) => Promise<RepoExternalPublishResult>
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
