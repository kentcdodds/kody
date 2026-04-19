import { z } from 'zod'

export const repoSearchModeSchema = z.enum(['literal', 'regex'])
export const repoSearchOutputModeSchema = z.enum(['content', 'files'])

export const repoTargetSchema = z.union([
	z.object({
		kind: z.literal('skill'),
		name: z
			.string()
			.min(1)
			.describe('Saved skill name to open or edit by user-facing identity.'),
	}),
	z.object({
		kind: z.literal('job'),
		job_id: z
			.string()
			.min(1)
			.describe('Saved job id to open or edit by stable identifier.'),
	}),
	z.object({
		kind: z.literal('job'),
		name: z
			.string()
			.min(1)
			.describe(
				'Saved job name to open or edit by human-facing label. This must resolve to exactly one job for the current user.',
			),
	}),
	z.object({
		kind: z.literal('app'),
		app_id: z
			.string()
			.min(1)
			.describe('Saved app id to open or edit by app_id.'),
	}),
])

export const repoResolvedTargetSchema = z.union([
	z.object({
		kind: z.literal('source'),
		source_id: z.string(),
		entity_kind: z.enum(['skill', 'app', 'job']),
		entity_id: z.string(),
	}),
	z.object({
		kind: z.literal('skill'),
		source_id: z.string(),
		skill_id: z.string(),
		name: z.string(),
	}),
	z.object({
		kind: z.literal('job'),
		source_id: z.string(),
		job_id: z.string(),
		name: z.string(),
	}),
	z.object({
		kind: z.literal('app'),
		source_id: z.string(),
		app_id: z.string(),
		title: z.string(),
	}),
])

export const repoSessionIdSchema = z.object({
	session_id: z.string().min(1).describe('Active repo session id.'),
})

export const repoSessionIdInputSchema = repoSessionIdSchema

export const repoOpenSessionInputSchema = z
	.object({
		source_id: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Shared source id to open a session for. Prefer `target` when you know the saved skill name, job id/name, or app_id instead of the internal source id.',
			),
		target: repoTargetSchema
			.optional()
			.describe(
				'User-facing repo-backed entity identity. Use this instead of `source_id` when opening a saved skill, job, or app session.',
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

export const repoOpenSessionOutputSchema = repoSessionInfoSchema.extend({
	resolved_target: repoResolvedTargetSchema,
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
		kind: z.literal('write_json'),
		path: z.string().min(1),
		value: z.unknown(),
		spaces: z.number().int().min(0).optional(),
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

export const repoRunChecksInputSchema = repoSessionIdSchema

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
	manifest: z.object({
		version: z.literal(1),
		kind: z.enum(['skill', 'app', 'job']),
		title: z.string(),
		description: z.string(),
	}),
})

export const repoRunChecksDetailedOutputSchema =
	repoRunChecksOutputSchema.extend({
		run_id: z.string(),
		tree_hash: z.string(),
		checked_at: z.string(),
	})

export const repoPublishSessionOutputSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('ok'),
		session_id: z.string(),
		published_commit: z.string(),
		message: z.string(),
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

export const repoEditFlowInputSchema = z
	.object({
		session_id: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Existing repo session id to continue editing. When provided, omit `source_id` and `target`.',
			),
		source_id: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Internal repo source id to open when not reusing an existing session. Prefer `target` for user-facing identities.',
			),
		target: repoTargetSchema
			.optional()
			.describe(
				'User-facing repo-backed entity identity to open when not reusing an existing session.',
			),
		conversation_id: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional conversation id used when opening or resuming a session by source identity.',
			),
		source_root: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional repo subdirectory to treat as the working source root when opening a session.',
			),
		default_branch: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional default branch hint used when opening a new session.',
			),
		instructions: z
			.array(repoPatchInstructionSchema)
			.min(1)
			.describe('Ordered structured edit instructions to apply.'),
		rollback_on_error: z
			.boolean()
			.optional()
			.describe(
				'Whether to roll back all edits when one instruction fails. Defaults to true.',
			),
		run_checks: z
			.boolean()
			.optional()
			.describe(
				'Whether to run Worker-native repo checks after applying edits. Defaults to true.',
			),
		publish: z
			.boolean()
			.optional()
			.describe(
				'Whether to publish after successful checks. Defaults to true. Publishing requires `run_checks` to stay enabled.',
			),
	})
	.superRefine((value, ctx) => {
		const openRefCount =
			(value.session_id !== undefined ? 1 : 0) +
			(value.source_id !== undefined ? 1 : 0) +
			(value.target !== undefined ? 1 : 0)
		if (openRefCount !== 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['session_id'],
				message:
					'Provide exactly one of `session_id`, `source_id`, or `target`.',
			})
		}
		if (value.session_id !== undefined) {
			if (value.source_id !== undefined || value.target !== undefined) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['session_id'],
					message: 'Do not combine `session_id` with `source_id` or `target`.',
				})
			}
			if (
				value.conversation_id !== undefined ||
				value.source_root !== undefined ||
				value.default_branch !== undefined
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['session_id'],
					message:
						'`conversation_id`, `source_root`, and `default_branch` only apply when opening a session by source identity.',
				})
			}
		}
		if (value.publish === true && value.run_checks === false) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['publish'],
				message:
					'`publish` requires checks to run in the same flow. Keep `run_checks` enabled or disable `publish`.',
			})
		}
	})

export const repoEditFlowChecksSchema = z.union([
	z.object({
		status: z.literal('not_requested'),
	}),
	z.object({
		status: z.literal('passed'),
		ok: z.literal(true),
		results: z.array(repoCheckResultSchema),
		manifest: z.object({
			version: z.literal(1),
			kind: z.enum(['skill', 'app', 'job']),
			title: z.string(),
			description: z.string(),
		}),
		run_id: z.string(),
		tree_hash: z.string(),
		checked_at: z.string(),
	}),
	z.object({
		status: z.literal('failed'),
		ok: z.literal(false),
		results: z.array(repoCheckResultSchema),
		failed_checks: z.array(repoCheckResultSchema),
		manifest: z.object({
			version: z.literal(1),
			kind: z.enum(['skill', 'app', 'job']),
			title: z.string(),
			description: z.string(),
		}),
		run_id: z.string(),
		tree_hash: z.string(),
		checked_at: z.string(),
	}),
])

export const repoEditFlowPublishSchema = z.union([
	z.object({
		status: z.literal('not_requested'),
	}),
	z.object({
		status: z.literal('published'),
		session_id: z.string(),
		published_commit: z.string(),
		message: z.string(),
	}),
	z.object({
		status: z.literal('blocked_by_checks'),
		message: z.string(),
		failed_checks: z.array(repoCheckResultSchema),
		run_id: z.string(),
		tree_hash: z.string(),
		checked_at: z.string(),
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

export const repoEditFlowOutputSchema = z.object({
	session: repoSessionInfoSchema,
	resolved_target: repoResolvedTargetSchema,
	edits: repoApplyPatchResultSchema,
	checks: repoEditFlowChecksSchema,
	publish: repoEditFlowPublishSchema,
})
