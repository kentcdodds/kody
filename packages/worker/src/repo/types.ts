import { z } from 'zod'

export const entityKindValues = ['skill', 'app', 'job'] as const
export type EntityKind = (typeof entityKindValues)[number]

export const entitySourceRowSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	entity_kind: z.enum(entityKindValues),
	entity_id: z.string(),
	repo_id: z.string(),
	published_commit: z.string().nullable(),
	indexed_commit: z.string().nullable(),
	manifest_path: z.string(),
	source_root: z.string(),
	created_at: z.string(),
	updated_at: z.string(),
})

export type EntitySourceRow = z.infer<typeof entitySourceRowSchema>

export const repoSessionStatusValues = [
	'active',
	'published',
	'discarded',
] as const

export type RepoSessionStatus = (typeof repoSessionStatusValues)[number]

export const repoSessionRowSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	source_id: z.string(),
	session_repo_id: z.string(),
	session_repo_name: z.string(),
	session_repo_namespace: z.string(),
	base_commit: z.string(),
	source_root: z.string(),
	conversation_id: z.string().nullable(),
	status: z.enum(repoSessionStatusValues),
	expires_at: z.string().nullable(),
	last_checkpoint_at: z.string().nullable(),
	last_checkpoint_commit: z.string().nullable(),
	last_check_run_id: z.string().nullable(),
	last_check_tree_hash: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
})

export type RepoSessionRow = z.infer<typeof repoSessionRowSchema>

export const repoContextSchema = z.object({
	sourceId: z.string().nullable().optional(),
	repoId: z.string().nullable().optional(),
	sessionId: z.string().nullable().optional(),
	sessionRepoId: z.string().nullable().optional(),
	baseCommit: z.string().nullable().optional(),
	manifestPath: z.string().nullable().optional(),
	sourceRoot: z.string().nullable().optional(),
	publishedCommit: z.string().nullable().optional(),
	entityKind: z.enum(entityKindValues).nullable().optional(),
	entityId: z.string().nullable().optional(),
})

export type RepoContext = z.infer<typeof repoContextSchema>

export const repoChecksSchema = z
	.object({
		manifest: z.boolean().optional(),
		dependencies: z.boolean().optional(),
		bundle: z.boolean().optional(),
		typecheck: z.boolean().optional(),
		lint: z.boolean().optional(),
		smoke: z
			.array(
				z.object({
					path: z.string().min(1),
					method: z.string().min(1).optional(),
				}),
			)
			.optional(),
	})
	.optional()

const manifestParameterSchema = z.object({
	name: z.string().min(1),
	description: z.string().min(1),
	type: z.enum(['string', 'number', 'boolean', 'json']),
	required: z.boolean().optional(),
	default: z.unknown().optional(),
})

const manifestBaseSchema = z.object({
	version: z.literal(1),
	kind: z.enum(entityKindValues),
	title: z.string().min(1),
	description: z.string().min(1),
	keywords: z.array(z.string()).optional(),
	searchText: z.string().optional(),
	sourceRoot: z.string().optional(),
	manifestPath: z.string().optional(),
	parameters: z.array(manifestParameterSchema).optional(),
	checks: repoChecksSchema,
})

export const skillManifestSchema = manifestBaseSchema.extend({
	kind: z.literal('skill'),
	entrypoint: z.string().min(1),
	collection: z.string().optional(),
	readOnly: z.boolean().optional(),
	idempotent: z.boolean().optional(),
	destructive: z.boolean().optional(),
	usesCapabilities: z.array(z.string()).optional(),
})

export const appManifestSchema = manifestBaseSchema.extend({
	kind: z.literal('app'),
	server: z.string().min(1),
	client: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
	assets: z.array(z.string().min(1)).optional(),
	hidden: z.boolean().optional(),
})

export const jobManifestSchema = manifestBaseSchema.extend({
	kind: z.literal('job'),
	entrypoint: z.string().min(1),
})

export const repoManifestSchema = z.discriminatedUnion('kind', [
	skillManifestSchema,
	appManifestSchema,
	jobManifestSchema,
])

export type SkillManifest = z.infer<typeof skillManifestSchema>
export type AppManifest = z.infer<typeof appManifestSchema>
export type JobManifest = z.infer<typeof jobManifestSchema>
export type RepoManifest = z.infer<typeof repoManifestSchema>

export type SearchProjection = {
	title: string
	description: string
	keywords: Array<string>
	searchText: string | null
}

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

export type RepoSessionInfo = {
	id: string
	sourceId: string
	sourceRoot: string
	baseCommit: string
	sessionRepoId: string
	sessionRepoName: string
	sessionRepoNamespace: string
	conversationId: string | null
	lastCheckpointCommit: string | null
	lastCheckRunId: string | null
	lastCheckTreeHash: string | null
	expiresAt: string | null
	createdAt: string
	updatedAt: string
	publishedCommit: string | null
	manifestPath: string
	entityType: EntityKind
}

export type RepoSessionDiscardResult = {
	ok: true
	sessionId: string
	deleted: boolean
}

export type RepoSessionInfoResult = {
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
	entity_type: EntityKind
}

export type RepoSessionTreeResult = {
	path: string
	name: string
	type: 'file' | 'directory' | 'symlink'
	size: number
	children?: Array<RepoSessionTreeResult>
}

export type RepoSessionReplaceOptions = {
	caseSensitive?: boolean
	regex?: boolean
	wholeWord?: boolean
	contextBefore?: number
	contextAfter?: number
	maxMatches?: number
}

export type RepoSessionWriteJsonOptions = {
	spaces?: number
}

export type RepoSessionWriteEdit = {
	kind: 'write'
	path: string
	content: string
}

export type RepoSessionReplaceEdit = {
	kind: 'replace'
	path: string
	search: string
	replacement?: string
	options?: RepoSessionReplaceOptions
}

export type RepoSessionWriteJsonEdit = {
	kind: 'writeJson'
	path: string
	value: unknown
	options?: RepoSessionWriteJsonOptions
}

export type RepoSessionEdit =
	| RepoSessionWriteEdit
	| RepoSessionReplaceEdit
	| RepoSessionWriteJsonEdit

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

export type RepoApplyPatchResult = RepoSessionApplyEditsResult

export type RepoSessionCheckStatus = {
	runId: string | null
	treeHash: string | null
	checkedAt: string | null
	ok: boolean | null
	results: Array<{
		kind:
			| 'manifest'
			| 'dependencies'
			| 'bundle'
			| 'typecheck'
			| 'lint'
			| 'smoke'
		ok: boolean
		message: string
	}> | null
}

export type RepoSessionCheckRun = {
	ok: boolean
	results: Array<{
		kind:
			| 'manifest'
			| 'dependencies'
			| 'bundle'
			| 'typecheck'
			| 'lint'
			| 'smoke'
		ok: boolean
		message: string
	}>
	manifest: RepoManifest
	runId: string
	treeHash: string
	checkedAt: string
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

export type RepoSourceBootstrapResult = {
	sessionId: string
	publishedCommit: string
	message: string
}

export type RepoSessionRebaseResult = {
	ok: true
	sessionId: string
	baseCommit: string
	headCommit: string | null
	merged: boolean
}
