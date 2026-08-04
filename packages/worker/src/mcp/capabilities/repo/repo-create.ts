import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { assertWithinEntitlement } from '#worker/entitlements/service.ts'
import { ensureEntitySource } from '#worker/repo/source-service.ts'
import {
	assertValidUserRepoName,
	insertUserRepo,
} from '#worker/repo/user-repos.ts'

export const repoCreateCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_create',
		description:
			'Create a plain Artifacts-backed repo for the signed-in user. Plain repos are live-at-HEAD (no publish step). Use repo_get_git_remote for the git lane or repo_open_session for MCP file editing.',
		keywords: ['repo', 'create', 'plain', 'artifacts', 'storage'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			name: z
				.string()
				.min(1)
				.describe(
					'Repo name (lowercase letters, numbers, dashes; 1–64 characters).',
				),
			description: z
				.string()
				.min(1)
				.optional()
				.describe('Optional short description for discovery.'),
		}),
		outputSchema: z.object({
			repo_id: z.string(),
			name: z.string(),
			source_id: z.string(),
			repo_git_id: z.string(),
			session_hint: z.string(),
			git_lane_hint: z.string(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			let name: string
			try {
				name = assertValidUserRepoName(args.name)
			} catch (error) {
				throw new McpCallerError(
					error instanceof Error ? error.message : String(error),
				)
			}
			await assertWithinEntitlement({
				db: ctx.env.APP_DB,
				userId: user.userId,
				email: user.email,
				resource: 'repos',
			})
			const existing = await ctx.env.APP_DB.prepare(
				`SELECT id FROM user_repos WHERE user_id = ? AND name = ?`,
			)
				.bind(user.userId, name)
				.first<{ id: string }>()
			if (existing) {
				throw new McpCallerError(
					`A plain repo named "${name}" already exists for this user.`,
				)
			}
			const repoId = crypto.randomUUID()
			const now = new Date().toISOString()
			try {
				await insertUserRepo(ctx.env.APP_DB, {
					id: repoId,
					user_id: user.userId,
					name,
					description: args.description?.trim() ?? null,
					created_at: now,
					updated_at: now,
				})
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				if (message.includes('UNIQUE constraint failed')) {
					throw new McpCallerError(
						`A plain repo named "${name}" already exists for this user.`,
					)
				}
				throw error
			}
			const ensuredSource = await ensureEntitySource({
				db: ctx.env.APP_DB,
				env: ctx.env,
				userId: user.userId,
				entityKind: 'repo',
				entityId: repoId,
				sourceRoot: '/',
				manifestPath: 'package.json',
				requirePersistence: true,
			})
			return {
				repo_id: repoId,
				name,
				source_id: ensuredSource.id,
				repo_git_id: ensuredSource.repo_id,
				session_hint:
					'Open an MCP editing session with repo_open_session using target { kind: "repo", name } or source_id.',
				git_lane_hint:
					'Mint a short-lived write remote with repo_get_git_remote; pushes are live at HEAD with no publish reconcile step.',
			}
		},
	},
)
