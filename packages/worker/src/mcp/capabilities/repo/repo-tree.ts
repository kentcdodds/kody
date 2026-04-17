import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { repoSessionIdSchema } from './repo-shared.ts'

const inputSchema = repoSessionIdSchema.extend({
	path: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional repo-relative subpath to summarize. Defaults to the session source root.',
		),
	max_depth: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe(
			'Optional maximum directory depth to include in the summary tree.',
		),
})

const outputSchema = z.object({
	path: z.string(),
	files: z.number().int().min(0),
	directories: z.number().int().min(0),
	symlinks: z.number().int().min(0),
	total_bytes: z.number().int().min(0),
	max_depth: z.number().int().min(0),
})

export const repoTreeCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_tree',
		description:
			'Summarize a repo session subtree so the model can understand file layout before reading or editing specific files.',
		keywords: ['repo', 'tree', 'workspace', 'files', 'directories', 'summary'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const result = await repoSessionRpc(ctx.env, args.session_id).tree({
				sessionId: args.session_id,
				userId: user.userId,
				path: args.path ?? null,
				maxDepth: args.max_depth,
			})
			const summary = summarizeTree(result)
			return summary
		},
	},
)

function summarizeTree(node: {
	path: string
	name: string
	type: 'file' | 'directory' | 'symlink'
	size: number
	children?: Array<unknown>
}) {
	const totals = {
		files: 0,
		directories: 0,
		symlinks: 0,
		total_bytes: 0,
		max_depth: 0,
	}

	function visit(
		current: {
			path: string
			name: string
			type: 'file' | 'directory' | 'symlink'
			size: number
			children?: Array<unknown>
		},
		depth: number,
	) {
		totals.max_depth = Math.max(totals.max_depth, depth)
		switch (current.type) {
			case 'file':
				totals.files += 1
				totals.total_bytes += current.size
				break
			case 'directory':
				totals.directories += 1
				break
			case 'symlink':
				totals.symlinks += 1
				break
		}
		for (const child of current.children ?? []) {
			if (!child || typeof child !== 'object') continue
			const next = child as {
				path: string
				name: string
				type: 'file' | 'directory' | 'symlink'
				size: number
				children?: Array<unknown>
			}
			visit(next, depth + 1)
		}
	}

	visit(node, 0)

	return {
		path: node.path,
		files: totals.files,
		directories: totals.directories,
		symlinks: totals.symlinks,
		total_bytes: totals.total_bytes,
		max_depth: totals.max_depth,
	}
}
