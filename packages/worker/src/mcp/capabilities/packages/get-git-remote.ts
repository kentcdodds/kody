import { markSecretInputFields } from '@kody-internal/shared/secret-input-schema.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	buildAuthenticatedArtifactsRemote,
	parseArtifactTokenSecret,
	resolveArtifactSourceRepo,
} from '#worker/repo/artifacts.ts'
import { resolveOwnedPackageSource } from './resolve-package-source.ts'

const getGitRemoteInputSchema = z
	.object({
		package_id: z.string().min(1).optional(),
		kody_id: z.string().min(1).optional(),
		scope: z.enum(['read', 'write']).default('write'),
		ttl_seconds: z.number().int().min(60).max(86_400).default(1800),
	})
	.superRefine((value, ctx) => {
		const idCount =
			(value.package_id !== undefined ? 1 : 0) +
			(value.kody_id !== undefined ? 1 : 0)
		if (idCount !== 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['package_id'],
				message: 'Provide exactly one of `package_id` or `kody_id`.',
			})
		}
	})

const outputSchema = markSecretInputFields(
	z.toJSONSchema(
		z.object({
			remote: z.string(),
			authenticated_remote: z.string(),
			git_extra_header: z.string(),
			scope: z.enum(['read', 'write']),
			expires_at: z.string(),
			setup_commands: z.array(z.string()),
		}),
	) as Record<string, unknown>,
	['authenticated_remote', 'git_extra_header', 'setup_commands'],
) as Record<string, unknown>

function shellQuote(value: string) {
	return `'${value.replaceAll(`'`, `'"'"'`)}'`
}

export const getGitRemoteCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_get_git_remote',
		description:
			'Mint a short-lived Cloudflare Artifacts git remote for directly cloning, pulling, or pushing a saved package source repository.',
		keywords: ['package', 'git', 'remote', 'artifacts', 'clone', 'push'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: getGitRemoteInputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const { source } = await resolveOwnedPackageSource({
				db: ctx.env.APP_DB,
				userId: user.userId,
				args: {
					package_id: args.package_id,
					kody_id: args.kody_id,
				},
			})
			const repo = await resolveArtifactSourceRepo(ctx.env, source.repo_id)
			const info = await repo.info()
			if (!info?.remote) {
				throw new Error('Artifact repo remote URL is unavailable.')
			}
			const token = await repo.createToken(args.scope, args.ttl_seconds)
			const gitExtraHeader = `Authorization: Bearer ${parseArtifactTokenSecret(token.plaintext)}`
			const cloneDirectory = source.entity_id
			return {
				remote: info.remote,
				authenticated_remote: buildAuthenticatedArtifactsRemote({
					remote: info.remote,
					token: token.plaintext,
				}),
				git_extra_header: gitExtraHeader,
				scope: args.scope,
				expires_at: token.expiresAt,
				setup_commands: [
					`git -c http.extraHeader=${shellQuote(gitExtraHeader)} clone ${shellQuote(info.remote)} ${shellQuote(cloneDirectory)}`,
					`cd ${shellQuote(cloneDirectory)}`,
					`git remote add kody ${shellQuote(info.remote)}`,
					`git -c http.extraHeader=${shellQuote(gitExtraHeader)} push kody HEAD:${shellQuote(info.defaultBranch ?? 'main')}`,
				],
			}
		},
	},
)
