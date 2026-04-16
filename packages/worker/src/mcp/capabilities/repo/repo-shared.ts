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
