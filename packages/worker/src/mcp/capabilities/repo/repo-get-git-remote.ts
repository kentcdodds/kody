import { markSecretInputFields } from '@kody-internal/shared/secret-input-schema.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	gitAuthorIdentityFromUser,
	gitAuthorIdentitySchema,
	gitAuthorSetupCommands,
	shellQuote,
} from '#worker/identity/git-author-identity.ts'
import {
	buildAuthenticatedArtifactsRemote,
	parseArtifactTokenSecret,
	resolveArtifactSourceHead,
	resolveExistingArtifactSourceRepo,
} from '#worker/repo/artifacts.ts'
import { resolveOwnedUserRepo } from './resolve-user-repo.ts'

const getGitRemoteInputSchema = z.object({
	repo_id: z.string().min(1).optional(),
	name: z.string().min(1).optional(),
	scope: z.enum(['read', 'write']).default('write'),
	ttl_seconds: z.number().int().min(60).max(86_400).default(14_400),
})

const outputSchema = markSecretInputFields(
	z.toJSONSchema(
		z.object({
			repo_id: z.string(),
			name: z.string(),
			source_id: z.string(),
			remote: z.string(),
			authenticated_remote: z.string(),
			git_extra_header: z.string(),
			scope: z.enum(['read', 'write']),
			expires_at: z.string(),
			git_author: gitAuthorIdentitySchema,
			setup_commands: z.array(z.string()),
			live_at_head: z.literal(true),
		}),
	) as Record<string, unknown>,
	['authenticated_remote', 'git_extra_header', 'setup_commands'],
) as Record<string, unknown>

export const repoGetGitRemoteCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_get_git_remote',
		description:
			'Mint a short-lived Cloudflare Artifacts git remote for a plain repo. Write pushes are live at HEAD — no package publish reconcile step runs afterward. The result includes `git_author` (signed-in Kody account email and display name) and `setup_commands` that set local `user.email` / `user.name` to that identity — never invent a git email. Individual files may be at most 10 MiB (10,485,760 stored bytes; UTF-8 for text, raw for binary); larger files are rejected with external-hosting guidance. The Artifacts remote itself fails pushes above ~32 MiB of decompressed pack content with a raw HTTP 413.',
		keywords: ['repo', 'git', 'remote', 'artifacts', 'clone', 'push', 'plain'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: getGitRemoteInputSchema.superRefine((value, ctx) => {
			const count =
				(value.repo_id !== undefined ? 1 : 0) +
				(value.name !== undefined ? 1 : 0)
			if (count !== 1) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['repo_id'],
					message: 'Provide exactly one of `repo_id` or `name`.',
				})
			}
		}),
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const gitAuthor = gitAuthorIdentityFromUser(user)
			const { userRepo, source } = await resolveOwnedUserRepo({
				db: ctx.env.APP_DB,
				userId: user.userId,
				args,
			})
			const head = await resolveArtifactSourceHead(ctx.env, source.repo_id)
			const repo = await resolveExistingArtifactSourceRepo(
				ctx.env,
				source.repo_id,
			)
			if (!repo) {
				throw new Error('Plain repo Artifacts backing store was not found.')
			}
			const info = await repo.info()
			if (!info?.remote) {
				throw new Error('Artifact repo remote URL is unavailable.')
			}
			const token = await repo.createToken(args.scope, args.ttl_seconds)
			const gitExtraHeader = `Authorization: Bearer ${parseArtifactTokenSecret(token.plaintext)}`
			const cloneDirectory = userRepo.name
			return {
				repo_id: userRepo.id,
				name: userRepo.name,
				source_id: source.id,
				remote: info.remote,
				authenticated_remote: buildAuthenticatedArtifactsRemote({
					remote: info.remote,
					token: token.plaintext,
				}),
				git_extra_header: gitExtraHeader,
				scope: args.scope,
				expires_at: token.expiresAt,
				live_at_head: true as const,
				git_author: gitAuthor,
				setup_commands: [
					`git -c http.extraHeader=${shellQuote(gitExtraHeader)} clone ${shellQuote(info.remote)} ${shellQuote(cloneDirectory)}`,
					`cd ${shellQuote(cloneDirectory)}`,
					...gitAuthorSetupCommands(gitAuthor),
					`git remote add kody ${shellQuote(info.remote)}`,
					`git config remote.kody.fetch '+refs/heads/*:refs/remotes/kody/*'`,
					`git -c http.extraHeader=${shellQuote(gitExtraHeader)} push kody HEAD:${shellQuote(head.branch)}`,
				],
			}
		},
	},
)
