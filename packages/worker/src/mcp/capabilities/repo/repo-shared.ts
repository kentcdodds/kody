import { z } from 'zod'

export const repoSearchModeSchema = z.enum(['literal', 'regex'])
export const repoSearchOutputModeSchema = z.enum(['content', 'files'])

export const repoTargetSchema = z.union([
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
])

export const repoResolvedTargetSchema = z.union([
	z.object({
		kind: z.literal('source'),
		source_id: z.string(),
		entity_kind: z.enum(['skill', 'app', 'job', 'package']),
		entity_id: z.string(),
	}),
	z.object({
		kind: z.literal('package'),
		source_id: z.string(),
		package_id: z.string(),
		kody_id: z.string(),
		name: z.string(),
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
	entity_type: z.enum(['skill', 'app', 'job', 'package']),
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

export const repoRunChecksInputSchema = repoSessionIdSchema

export const repoRunCommandsInputSchema = z
	.object({
		session_id: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Existing repo session id to run commands in. When provided, omit `source_id` and `target`.',
			),
		source_id: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Internal repo source id to open when not reusing an existing session. Prefer `target` for saved packages.',
			),
		target: repoTargetSchema
			.optional()
			.describe('User-facing repo-backed package identity to open.'),
		conversation_id: z
			.string()
			.min(1)
			.optional()
			.describe('Optional conversation id for newly opened sessions.'),
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
		commands: z
			.string()
			.min(1)
			.describe(
				'Newline-separated constrained git commands. Supported commands include git status, git diff, git apply heredoc, git add, git rm, git commit -m, git log, git branch, git checkout, git fetch, git pull, git push, and git remote.',
			),
		dry_run: z
			.boolean()
			.optional()
			.describe('Preview git apply changes without writing patched files.'),
		run_checks: z
			.boolean()
			.optional()
			.describe('Run repo checks after commands. Defaults to false.'),
		publish: z
			.boolean()
			.optional()
			.describe(
				'Publish after successful checks. Requires run_checks to be true.',
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
		if (value.source_id === undefined) {
			if (
				value.conversation_id !== undefined ||
				value.source_root !== undefined ||
				value.default_branch !== undefined
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['source_id'],
					message:
						'`conversation_id`, `source_root`, and `default_branch` only apply when opening a session by source identity.',
				})
			}
		}
		if (value.publish === true && value.run_checks !== true) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['publish'],
				message: '`publish` requires `run_checks: true`.',
			})
		}
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
	manifest: z.object({
		name: z.string(),
		kody_id: z.string(),
		description: z.string(),
		has_app: z.boolean(),
	}),
})

const repoRunCommandResultSchema = z.object({
	line: z.number().int().min(1),
	command: z.string(),
	ok: z.literal(true),
	output: z.unknown(),
})

export function normalizeRepoManifestSummary(manifest: {
	name?: unknown
	title?: unknown
	description?: unknown
	kody?: {
		id?: unknown
		description?: unknown
		app?: unknown
	}
}) {
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

export const repoCommandChecksSchema = z.union([
	z.object({
		status: z.literal('not_requested'),
	}),
	z.object({
		status: z.literal('passed'),
		ok: z.literal(true),
		results: z.array(repoCheckResultSchema),
		manifest: z.object({
			name: z.string(),
			kody_id: z.string(),
			description: z.string(),
			has_app: z.boolean(),
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
			name: z.string(),
			kody_id: z.string(),
			description: z.string(),
			has_app: z.boolean(),
		}),
		run_id: z.string(),
		tree_hash: z.string(),
		checked_at: z.string(),
	}),
])

export const repoCommandPublishSchema = z.union([
	z.object({
		status: z.literal('not_requested'),
	}),
	z.object({
		status: z.literal('ok'),
		session_id: z.string(),
		published_commit: z.string(),
		message: z.string(),
	}),
	z.object({
		status: z.literal('blocked_by_checks'),
		message: z.string(),
		failed_checks: z.array(repoCheckResultSchema).optional(),
		run_id: z.string().optional(),
		tree_hash: z.string().optional(),
		checked_at: z.string().optional(),
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

export const repoRunCommandsOutputSchema = z.object({
	session: repoSessionInfoSchema,
	resolved_target: repoResolvedTargetSchema,
	commands: z.array(repoRunCommandResultSchema),
	checks: repoCommandChecksSchema,
	publish: repoCommandPublishSchema,
})

export function normalizeRepoCommandChecks(input: {
	status: 'not_requested' | 'passed' | 'failed'
	ok?: boolean
	results?: Array<z.infer<typeof repoCheckResultSchema>>
	failedChecks?: Array<z.infer<typeof repoCheckResultSchema>>
	manifest?: unknown
	runId?: string
	treeHash?: string
	checkedAt?: string
}) {
	if (input.status === 'not_requested') return { status: input.status }
	if (input.status === 'passed') {
		return {
			status: input.status,
			ok: true as const,
			results: input.results ?? [],
			manifest: normalizeRepoManifestSummary(
				input.manifest && typeof input.manifest === 'object'
					? input.manifest
					: {},
			),
			run_id: input.runId ?? '',
			tree_hash: input.treeHash ?? '',
			checked_at: input.checkedAt ?? '',
		}
	}
	if (input.status === 'failed') {
		return {
			status: input.status,
			ok: false as const,
			results: input.results ?? [],
			failed_checks: input.failedChecks ?? [],
			manifest: normalizeRepoManifestSummary(
				input.manifest && typeof input.manifest === 'object'
					? input.manifest
					: {},
			),
			run_id: input.runId ?? '',
			tree_hash: input.treeHash ?? '',
			checked_at: input.checkedAt ?? '',
		}
	}
	const exhaustive: never = input.status
	return exhaustive
}

export function normalizeRepoCommandPublish(
	input:
		| { status: 'not_requested' }
		| {
				status: 'blocked_by_checks'
				message: string
				failedChecks?: Array<z.infer<typeof repoCheckResultSchema>>
				runId?: string
				treeHash?: string
				checkedAt?: string
		  }
		| {
				status: 'ok'
				sessionId: string
				publishedCommit: string
				message: string
		  }
		| {
				status: 'checks_outdated'
				sessionId: string
				publishedCommit: null
				message: string
		  }
		| {
				status: 'base_moved'
				sessionId: string
				publishedCommit: null
				message: string
				repairHint: 'repo_rebase_session'
				sessionBaseCommit: string
				currentPublishedCommit: string | null
		  },
) {
	switch (input.status) {
		case 'not_requested':
			return input
		case 'blocked_by_checks':
			return {
				status: input.status,
				message: input.message,
				failed_checks: input.failedChecks,
				run_id: input.runId,
				tree_hash: input.treeHash,
				checked_at: input.checkedAt,
			}
		case 'ok':
			return {
				status: input.status,
				session_id: input.sessionId,
				published_commit: input.publishedCommit,
				message: input.message,
			}
		case 'checks_outdated':
			return {
				status: input.status,
				session_id: input.sessionId,
				published_commit: null,
				message: input.message,
			}
		case 'base_moved':
			return {
				status: input.status,
				session_id: input.sessionId,
				published_commit: null,
				message: input.message,
				repair_hint: input.repairHint,
				session_base_commit: input.sessionBaseCommit,
				current_published_commit: input.currentPublishedCommit,
			}
		default: {
			const exhaustive: never = input
			return exhaustive
		}
	}
}
