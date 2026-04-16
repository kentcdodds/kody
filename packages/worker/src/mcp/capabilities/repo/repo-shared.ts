import { z } from 'zod'

export const repoSearchModeSchema = z.enum(['literal', 'regex'])
export const repoSearchOutputModeSchema = z.enum(['content', 'files'])

export const repoSessionIdSchema = z.object({
	session_id: z.string().min(1).describe('Active repo session id.'),
})

export const repoSessionIdInputSchema = repoSessionIdSchema

export const repoOpenSessionInputSchema = z.object({
	source_id: z
		.string()
		.min(1)
		.describe('Shared source id to open a session for.'),
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
	session_repo_id: z.string(),
	session_repo_name: z.string(),
	session_repo_namespace: z.string(),
	conversation_id: z.string().nullable(),
	last_checkpoint_commit: z.string().nullable(),
	last_check_run_id: z.string().nullable(),
	last_check_tree_hash: z.string().nullable(),
	expires_at: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
	published_commit: z.string().nullable(),
	manifest_path: z.string(),
	entity_type: z.enum(['skill', 'app', 'job']),
})

export const repoReadFileInputSchema = repoSessionIdSchema.extend({
	path: z.string().min(1).describe('Repo-relative file path to read.'),
})

export const repoFileInputSchema = repoReadFileInputSchema

export const repoReadFileOutputSchema = z.object({
	path: z.string(),
	content: z.string().nullable(),
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

export const repoTreeOutputSchema = repoTreeNodeSchema

export const repoWriteFileInputSchema = repoSessionIdSchema.extend({
	path: z.string().min(1).describe('Repo-relative file path to write.'),
	content: z
		.string()
		.describe('Full file contents to persist in the repo session.'),
})

export const repoWriteFileOutputSchema = z.object({
	ok: z.literal(true),
	path: z.string(),
})

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

export const repoDiscardSessionInputSchema = repoSessionIdSchema

const repoPatchSearchOptionsSchema = z.object({
	case_sensitive: z.boolean().optional(),
	regex: z.boolean().optional(),
	whole_word: z.boolean().optional(),
	context_before: z.number().int().min(0).optional(),
	context_after: z.number().int().min(0).optional(),
	max_matches: z.number().int().min(1).optional(),
})

export const repoPatchInstructionSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('write'),
		path: z.string().min(1),
		content: z.string(),
	}),
	z.object({
		kind: z.literal('replace'),
		path: z.string().min(1),
		search: z.string().min(1),
		replacement: z.string(),
		options: repoPatchSearchOptionsSchema.optional(),
	}),
	z.object({
		kind: z.literal('writeJson'),
		path: z.string().min(1),
		value: z.unknown(),
		options: z
			.object({
				spaces: z.number().int().min(0).optional(),
			})
			.optional(),
	}),
])

export const repoApplyPatchInputSchema = repoSessionIdSchema.extend({
	instructions: z
		.array(repoPatchInstructionSchema)
		.min(1)
		.describe('Ordered structured edit instructions to apply transactionally.'),
	dry_run: z
		.boolean()
		.optional()
		.describe('Preview the edit plan without mutating the session workspace.'),
	rollback_on_error: z
		.boolean()
		.optional()
		.describe(
			'Whether to roll back all edits when one instruction fails. Defaults to true.',
		),
})

export const repoApplyPatchResultSchema = z.object({
	dry_run: z.boolean(),
	total_changed: z.number().int().min(0),
	edits: z.array(
		z.object({
			path: z.string(),
			changed: z.boolean(),
			content: z.string(),
			diff: z.string(),
		}),
	),
})
