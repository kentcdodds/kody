import { z } from 'zod'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getActiveRepoSessionByConversation } from '#worker/repo/repo-sessions.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { resolveRepoSourceReference } from '../repo/repo-resolve-target.ts'
import {
	repoOpenSessionInputSchema,
	repoPublishSessionOutputSchema,
	repoResolvedTargetSchema,
	repoRunChecksOutputSchema,
	repoSessionIdSchema,
} from '../repo/repo-shared.ts'

export const packageShellMaxCommandTimeoutMs = 86_400_000

const packageShellCommandTimeoutSchema = z
	.number()
	.int()
	.min(1_000)
	.max(packageShellMaxCommandTimeoutMs)
	.describe(
		'Optional shell command timeout in milliseconds, capped at one day.',
	)

export const packageShellOpenInputSchema = repoOpenSessionInputSchema.extend({
	command_timeout_ms: packageShellCommandTimeoutSchema.optional(),
})

export const packageShellOpenOutputSchema = z.object({
	session_id: z.string(),
	sandbox_id: z.string(),
	package_dir: z.string(),
	remote: z.string(),
	default_branch: z.string(),
	token_expires_at: z.string(),
	instructions: z.array(z.string()),
	resolved_target: repoResolvedTargetSchema,
})

export const packageShellExecInputSchema = repoSessionIdSchema.extend({
	command: z
		.string()
		.min(1)
		.describe('Shell command string to run as-is in the package workbench.'),
	cwd: z
		.string()
		.min(1)
		.optional()
		.describe('Optional command working directory. Defaults to /workspace.'),
	command_timeout_ms: packageShellCommandTimeoutSchema.optional(),
	sync_after: z
		.boolean()
		.optional()
		.describe(
			'Whether to sync Kody repo session state from the shell-pushed remote after the command. Defaults to true.',
		),
})

export const packageShellExecOutputSchema = packageShellOpenOutputSchema.extend(
	{
		command: z.string(),
		success: z.boolean(),
		exit_code: z.number().int(),
		stdout: z.string(),
		stderr: z.string(),
		duration_ms: z.number(),
		started_at: z.string(),
		synced_session: z
			.object({
				ok: z.literal(true),
				sessionId: z.string(),
				headCommit: z.string().nullable(),
				changed: z.boolean(),
			})
			.nullable(),
	},
)

export const packageCheckInputSchema = repoSessionIdSchema
export const packageCheckOutputSchema = repoRunChecksOutputSchema
export const packagePublishInputSchema = repoSessionIdSchema
export const packagePublishOutputSchema = repoPublishSessionOutputSchema

export async function requirePackageSession(input: {
	env: Env
	userId: string
	sessionId: string
}) {
	const session = await repoSessionRpc(
		input.env,
		input.sessionId,
	).getSessionInfo({
		sessionId: input.sessionId,
		userId: input.userId,
	})
	if (session.entity_type !== 'package') {
		throw new Error('Package shell capabilities only support saved packages.')
	}
	return session
}

export async function openPackageRepoSession(input: {
	args: z.infer<typeof packageShellOpenInputSchema>
	ctx: CapabilityContext
	user: McpUserContext
}) {
	const requested = await resolveRepoSourceReference({
		db: input.ctx.env.APP_DB,
		userId: input.user.userId,
		args: input.args,
	})
	if (requested.source.entity_kind !== 'package') {
		throw new Error('Package shell workbenches only support saved packages.')
	}
	const existingSession =
		input.args.conversation_id == null
			? null
			: await getActiveRepoSessionByConversation(input.ctx.env.APP_DB, {
					userId: input.user.userId,
					conversationId: input.args.conversation_id,
				})
	if (existingSession) {
		if (existingSession.source_id !== requested.source.id) {
			throw new Error(
				'Active package shell session does not match the requested package. Use the existing session id or discard it before opening another package.',
			)
		}
		const session = await repoSessionRpc(
			input.ctx.env,
			existingSession.id,
		).getSessionInfo({
			sessionId: existingSession.id,
			userId: input.user.userId,
		})
		return {
			...session,
			resolved_target: requested.resolvedTarget,
		}
	}
	const sessionId = crypto.randomUUID()
	const session = await repoSessionRpc(input.ctx.env, sessionId).openSession({
		sessionId,
		sourceId: requested.source.id,
		userId: input.user.userId,
		baseUrl: input.ctx.callerContext.baseUrl,
		conversationId: input.args.conversation_id ?? null,
		sourceRoot: input.args.source_root ?? requested.source.source_root,
		defaultBranch: input.args.default_branch ?? null,
	})
	return {
		...session,
		resolved_target: requested.resolvedTarget,
	}
}
