import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { authorize } from '#worker/authorization/authorize.ts'
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
import { buildPlainRepoGitHttpRemote } from '#worker/repo/plain-repo-git-http.ts'
import { resolveOwnedUserRepo } from './resolve-user-repo.ts'

const getGitRemoteInputSchema = z.object({
	repo_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Plain repo UUID, or the repo name. OpenAPI path `/v1/repos/{repo_id}/git-remote` accepts either. Prefer `name` (or this field) on `POST /v1/repos/git-remote` when calling via CLI/OpenAPI without a path id.',
		),
	name: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Plain repo name. Provide exactly one of `repo_id` or `name`. Works on MCP `api`, execute, and OpenAPI `POST /v1/repos/git-remote`.',
		),
	scope: z.enum(['read', 'write']).default('write'),
	ttl_seconds: z.number().int().min(60).max(86_400).default(14_400),
})

const outputSchema = z.toJSONSchema(
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
) as Record<string, unknown>

export const repoGetGitRemoteCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoGetGitRemote',
		orgPermission: 'package:read',
		description:
			'Mint a short-lived git remote for a plain repo (Kody smart-HTTP proxy in front of Cloudflare Artifacts). Write pushes are live at HEAD — no package publish reconcile step runs afterward. Concurrent push lock contention returns HTTP 503 with Retry-After and "repository busy, retry" instead of hanging up. The result includes `git_author` (signed-in Kody account email and display name) and `setup_commands` that set local `user.email` / `user.name` to that identity — never invent a git email. The Artifacts backing store fails pushes above ~32 MiB of decompressed pack content with a raw HTTP 413.',
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
			const ownerId = ownerIdFromCaller(ctx.callerContext)
			if (args.scope === 'write') {
				await authorize(
					{ env: ctx.env, request: ctx.callerContext.request },
					'package:write',
				)
			}
			const gitAuthor = gitAuthorIdentityFromUser(user)
			const { userRepo, source } = await resolveOwnedUserRepo({
				db: ctx.env.APP_DB,
				userId: ownerId,
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
			// Proxy through Kody so receive-pack lock contention is a clean 503
			// (Retry-After) instead of a hung-up Artifacts connection. Token is
			// still an Artifacts bearer; the proxy forwards it upstream.
			const remote = buildPlainRepoGitHttpRemote({
				baseUrl: ctx.callerContext.baseUrl,
				sourceId: source.id,
			})
			return {
				repo_id: userRepo.id,
				name: userRepo.name,
				source_id: source.id,
				remote,
				authenticated_remote: buildAuthenticatedArtifactsRemote({
					remote,
					token: token.plaintext,
				}),
				git_extra_header: gitExtraHeader,
				scope: args.scope,
				expires_at: token.expiresAt,
				live_at_head: true as const,
				git_author: gitAuthor,
				setup_commands: [
					`git -c http.extraHeader=${shellQuote(gitExtraHeader)} clone ${shellQuote(remote)} ${shellQuote(cloneDirectory)}`,
					`cd ${shellQuote(cloneDirectory)}`,
					...gitAuthorSetupCommands(gitAuthor),
					`git remote add kody ${shellQuote(remote)}`,
					`git config remote.kody.fetch '+refs/heads/*:refs/remotes/kody/*'`,
					`git -c http.extraHeader=${shellQuote(gitExtraHeader)} push kody HEAD:${shellQuote(head.branch)}`,
				],
			}
		},
	},
)
