import { z } from 'zod'
import {
	entityKindValues,
	repoSessionStatusValues,
} from '#worker/repo/types.ts'
import { privateVisibilityChangeConfirmationDescription } from '#worker/repo/source-safety-policy.ts'

export const repoSearchModeSchema = z.enum(['literal', 'regex'])
export const repoSearchOutputModeSchema = z.enum(['content', 'files'])

const repoTargetShapeSchema = z.union([
	z.object({
		kind: z.literal('package'),
		package_id: z
			.string()
			.min(1)
			.describe('Saved package id to open or edit by stable identifier.'),
	}),
	z.object({
		kind: z.literal('package'),
		kody_id: z
			.string()
			.min(1)
			.describe(
				'Saved package kody id to open or edit by user-facing identity.',
			),
	}),
	z.object({
		kind: z.literal('repo'),
		repo_id: z
			.string()
			.min(1)
			.describe('Plain repo id to open or edit by stable identifier.'),
	}),
	z.object({
		kind: z.literal('repo'),
		name: z
			.string()
			.min(1)
			.describe('Plain repo name to open or edit by user-facing identity.'),
	}),
])

/**
 * Agents routinely guess camelCase (`kodyId`, `packageId`) for the snake_case
 * target fields and burn a round trip on the validation error, so the schema
 * accepts both spellings and normalizes to snake_case.
 */
function normalizeRepoTargetAliases(value: unknown) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return value
	}
	const record = value as Record<string, unknown>
	const normalized: Record<string, unknown> = { ...record }
	if (normalized['package_id'] === undefined && 'packageId' in record) {
		normalized['package_id'] = record['packageId']
		delete normalized['packageId']
	}
	if (normalized['kody_id'] === undefined && 'kodyId' in record) {
		normalized['kody_id'] = record['kodyId']
		delete normalized['kodyId']
	}
	if (normalized['repo_id'] === undefined && 'repoId' in record) {
		normalized['repo_id'] = record['repoId']
		delete normalized['repoId']
	}
	return normalized
}

export const repoTargetSchema = z.preprocess(
	normalizeRepoTargetAliases,
	repoTargetShapeSchema,
)

export const repoResolvedTargetSchema = z.union([
	z.object({
		kind: z.literal('source'),
		source_id: z.string(),
		entity_kind: z.enum(entityKindValues),
		entity_id: z.string(),
	}),
	z.object({
		kind: z.literal('package'),
		source_id: z.string(),
		package_id: z.string(),
		kody_id: z.string(),
		name: z.string(),
	}),
	z.object({
		kind: z.literal('repo'),
		source_id: z.string(),
		repo_id: z.string(),
		name: z.string(),
	}),
])

export const repoSessionIdSchema = z.object({
	session_id: z.string().min(1).describe('Active repo session id.'),
})

export const repoPublishSessionInputSchema = repoSessionIdSchema.extend({
	confirm_private_visibility_change: z
		.boolean()
		.optional()
		.default(false)
		.describe(privateVisibilityChangeConfirmationDescription),
})

export const repoOpenSessionInputSchema = z
	.object({
		source_id: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Shared source id to open a session for. Prefer `target` when you know the saved package identity instead of the internal source id.',
			),
		target: repoTargetSchema
			.optional()
			.describe(
				'User-facing repo-backed package identity. Use this instead of `source_id` when opening a saved package session.',
			),
		conversation_id: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional conversation id to associate with this repo session for default resolution in later calls.',
			),
		source_root: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional repo subdirectory to treat as the working source root.',
			),
		default_branch: z
			.string()
			.min(1)
			.optional()
			.describe('Optional default branch name hint for session creation.'),
	})
	.superRefine((value, ctx) => {
		const sourceRefCount =
			(value.source_id !== undefined ? 1 : 0) +
			(value.target !== undefined ? 1 : 0)
		if (sourceRefCount !== 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['source_id'],
				message: 'Provide exactly one of `source_id` or `target`.',
			})
		}
	})

export const repoSourceRefSchema = z.object({
	source_id: z
		.string()
		.min(1)
		.describe('Shared source id to open a session for.'),
})

export const repoSessionInfoSchema = z.object({
	id: z.string(),
	source_id: z.string(),
	source_root: z.string(),
	base_commit: z.string(),
	session_branch: z.string(),
	source_branch: z.string(),
	conversation_id: z.string().nullable(),
	last_checkpoint_commit: z.string().nullable(),
	last_check_run_id: z.string().nullable(),
	last_check_tree_hash: z.string().nullable(),
	expires_at: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
	published_commit: z.string().nullable(),
	manifest_path: z.string(),
	entity_type: z.enum(entityKindValues),
})

export const repoListSessionStatusValues = [
	...repoSessionStatusValues,
	'all',
] as const

export const repoListSessionStatusSchema = z.enum(repoListSessionStatusValues)

export const repoListSessionsInputSchema = z.object({
	status: repoListSessionStatusSchema
		.optional()
		.default('active')
		.describe(
			'Which repo session lifecycle status to include. Defaults to active sessions.',
		),
	source_id: z
		.string()
		.min(1)
		.optional()
		.describe('Optional repo-backed source id to narrow the session list.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.default(100)
		.describe('Maximum sessions to return. Capped at 100.'),
})

export const repoListSessionInfoSchema = repoSessionInfoSchema.extend({
	status: z.enum(repoSessionStatusValues),
	resolved_target: repoResolvedTargetSchema,
})

export const repoListSessionsOutputSchema = z.object({
	sessions: z.array(repoListSessionInfoSchema),
})

export const repoOpenSessionOutputSchema = repoSessionInfoSchema.extend({
	resolved_target: repoResolvedTargetSchema,
})

export const repoReadFileInputSchema = repoSessionIdSchema.extend({
	path: z.string().min(1).describe('Repo-relative file path to read.'),
})

export const repoReadFileOutputSchema = z.object({
	path: z.string(),
	content: z.string().nullable(),
})

export const repoWriteFileInputSchema = repoSessionIdSchema.extend({
	files: z
		.array(
			z.object({
				path: z
					.string()
					.min(1)
					.describe(
						'Repo-relative file path to write. Existing files are overwritten with the provided content; missing parent directories are created.',
					),
				content: z
					.string()
					.describe(
						'Full new file content. Pass the entire file body, not a patch or diff.',
					),
			}),
		)
		.min(1)
		.describe(
			'One or more files to overwrite in the active repo session. Each entry replaces the file at `path` with `content` exactly.',
		),
	dry_run: z
		.boolean()
		.optional()
		.describe(
			'When true, compute the per-file diff without writing the workspace. Useful for previewing changes before committing.',
		),
	rollback_on_error: z
		.boolean()
		.optional()
		.describe(
			'When true (default), all writes are rolled back if any individual write fails. Set to false to keep partial progress.',
		),
})

export const repoWriteFileEditSchema = z.object({
	path: z.string(),
	changed: z.boolean(),
	content: z.string(),
	diff: z.string(),
})

export const repoWriteFileOutputSchema = z.object({
	dry_run: z.boolean(),
	total_changed: z.number().int().min(0),
	edits: z.array(repoWriteFileEditSchema),
})

const repoSessionEditSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('write'),
		path: z.string().min(1),
		content: z.string(),
	}),
	z.object({
		kind: z.literal('replace'),
		path: z.string().min(1),
		search: z.string(),
		replacement: z.string().optional(),
		options: z
			.object({
				case_sensitive: z.boolean().optional(),
				regex: z.boolean().optional(),
				whole_word: z.boolean().optional(),
				context_before: z.number().int().min(0).optional(),
				context_after: z.number().int().min(0).optional(),
				max_matches: z.number().int().min(1).optional(),
				spaces: z.number().int().optional(),
			})
			.optional(),
	}),
	z.object({
		kind: z.literal('writeJson'),
		path: z.string().min(1),
		value: z.unknown(),
		options: z
			.object({
				spaces: z.number().int().optional(),
			})
			.optional(),
	}),
	z.object({
		kind: z.literal('delete'),
		path: z.string().min(1),
	}),
	z.object({
		kind: z.literal('move'),
		path: z.string().min(1),
		to: z.string().min(1),
	}),
])

export const repoEditFilesInputSchema = repoSessionIdSchema.extend({
	edits: z
		.array(repoSessionEditSchema)
		.min(1)
		.describe(
			'Batch of file-level edits: write, replace, writeJson, delete, or move.',
		),
	dry_run: z
		.boolean()
		.optional()
		.describe('Preview edits without mutating the workspace.'),
	rollback_on_error: z
		.boolean()
		.optional()
		.describe(
			'When true (default), roll back the batch if any edit fails. Set false to keep partial progress.',
		),
})

export const repoEditFilesOutputSchema = repoWriteFileOutputSchema

export const repoApplyPatchInputSchema = repoSessionIdSchema.extend({
	patch: z
		.string()
		.min(1)
		.describe(
			'Standard unified diff to apply. Multiple file patches can be stacked in one patch string.',
		),
	dry_run: z
		.boolean()
		.optional()
		.describe('Preview patch application without writing files.'),
})

export const repoApplyPatchOutputSchema = repoWriteFileOutputSchema

export const repoStatusOutputSchema = z.object({
	status: z.unknown(),
})

export const repoDiffOutputSchema = z.object({
	diff: z.unknown(),
})

export const repoLogInputSchema = repoSessionIdSchema.extend({
	depth: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe('Optional maximum number of commits to return.'),
})

export const repoLogOutputSchema = z.object({
	log: z.unknown(),
})

export const repoCommitInputSchema = repoSessionIdSchema.extend({
	message: z
		.string()
		.trim()
		.min(1)
		.describe('Commit message. Whitespace-only messages are rejected.'),
})

export const repoCommitOutputSchema = z.object({
	oid: z.string(),
	message: z.string(),
})

export const repoRestoreInputSchema = repoSessionIdSchema.extend({
	paths: z
		.array(z.string().min(1))
		.min(1)
		.describe('Repo-relative workspace paths to restore.'),
	commit: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Commit to restore from. Defaults to the session base commit (HEAD at open).',
		),
})

export const repoRestoreOutputSchema = z.object({
	commit: z.string(),
	restored: z.array(z.string()),
})

export const repoTreeInputSchema = repoSessionIdSchema.extend({
	path: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional repo-relative directory path. Defaults to the repo session source root.',
		),
	max_depth: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe('Optional maximum tree depth to include in the result.'),
})

export const repoTreeNodeSchema: z.ZodType<unknown> = z.lazy(() =>
	z.object({
		path: z.string(),
		name: z.string(),
		type: z.enum(['file', 'directory', 'symlink']),
		size: z.number().int().min(0),
		children: z.array(repoTreeNodeSchema).optional(),
	}),
)

export const repoSearchInputSchema = repoSessionIdSchema.extend({
	pattern: z.string().min(1).describe('Literal text or regex to search for.'),
	mode: repoSearchModeSchema
		.optional()
		.describe('Search mode. Defaults to literal.'),
	glob: z
		.string()
		.min(1)
		.optional()
		.describe('Optional glob filter for files to search.'),
	path: z
		.string()
		.min(1)
		.optional()
		.describe('Optional repo-relative subpath to scope the search to.'),
	case_sensitive: z
		.boolean()
		.optional()
		.describe('Whether matching should be case-sensitive.'),
	before: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe('Lines of context to include before each match.'),
	after: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe('Lines of context to include after each match.'),
	limit: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe('Maximum number of matches to return before truncation.'),
	output_mode: repoSearchOutputModeSchema
		.optional()
		.describe('Whether to return match content or just files with matches.'),
})

export const repoSearchMatchSchema = z.object({
	line: z.number().int().min(1),
	column: z.number().int().min(1),
	match: z.string(),
	lineText: z.string(),
	beforeLines: z.array(z.string()),
	afterLines: z.array(z.string()),
})

export const repoSearchFileMatchSchema = z.object({
	path: z.string(),
	matches: z.array(repoSearchMatchSchema),
})

export const repoSearchOutputSchema = z.object({
	files: z.array(repoSearchFileMatchSchema),
	total_files: z.number().int().min(0),
	total_matches: z.number().int().min(0),
	output_mode: repoSearchOutputModeSchema,
	truncated: z.boolean(),
})

export const repoDiscardSessionOutputSchema = z.object({
	ok: z.literal(true),
	session_id: z.string(),
	deleted: z.boolean(),
})

export const repoCheckResultSchema = z.object({
	kind: z.enum([
		'manifest',
		'dependencies',
		'bundle',
		'typecheck',
		'lint',
		'smoke',
	]),
	ok: z.boolean(),
	message: z.string(),
})

export const repoRunChecksOutputSchema = z.object({
	ok: z.boolean(),
	results: z.array(repoCheckResultSchema),
	manifest: z
		.object({
			name: z.string(),
			kody_id: z.string(),
			description: z.string(),
			has_app: z.boolean(),
		})
		.nullable()
		.describe(
			'Parsed package.json summary when available; null when the manifest itself failed validation or was missing.',
		),
})

type RepoManifestSummaryInput = {
	name?: unknown
	title?: unknown
	description?: unknown
	kody?: {
		id?: unknown
		description?: unknown
		app?: unknown
	}
}

type RepoManifestSummary = {
	name: string
	kody_id: string
	description: string
	has_app: boolean
}

export function normalizeRepoManifestSummary(manifest: null): null
export function normalizeRepoManifestSummary(
	manifest: RepoManifestSummaryInput,
): RepoManifestSummary
export function normalizeRepoManifestSummary(
	manifest: RepoManifestSummaryInput | null,
): RepoManifestSummary | null
export function normalizeRepoManifestSummary(
	manifest: RepoManifestSummaryInput | null,
): RepoManifestSummary | null {
	if (manifest == null) return null
	const packageName =
		typeof manifest.name === 'string'
			? manifest.name
			: typeof manifest.title === 'string'
				? manifest.title
				: 'package'
	const kodyId =
		typeof manifest.kody?.id === 'string' ? manifest.kody.id : packageName
	const description =
		typeof manifest.kody?.description === 'string'
			? manifest.kody.description
			: typeof manifest.description === 'string'
				? manifest.description
				: ''
	return {
		name: packageName,
		kody_id: kodyId,
		description,
		has_app: manifest.kody?.app !== undefined,
	}
}

export const repoPublishSessionOutputSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('ok'),
		session_id: z.string(),
		published_commit: z.string(),
		message: z.string(),
		package_shaped: z.boolean().optional(),
		notice: z.string().nullable().optional(),
	}),
	z.object({
		status: z.literal('checks_outdated'),
		session_id: z.string(),
		published_commit: z.null(),
		message: z.string(),
	}),
	z.object({
		status: z.literal('base_moved'),
		session_id: z.string(),
		published_commit: z.null(),
		message: z.string(),
		repair_hint: z.literal('repo_rebase_session'),
		session_base_commit: z.string(),
		current_published_commit: z.string().nullable(),
	}),
])

export const repoCheckStatusOutputSchema = z.object({
	run_id: z.string().nullable(),
	tree_hash: z.string().nullable(),
	checked_at: z.string().nullable(),
	ok: z.boolean(),
	results: z.array(repoCheckResultSchema),
})
