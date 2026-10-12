import { z } from 'zod'
import { mintGitAccessToken } from '#worker/api-tokens/git-access-tokens.ts'
import {
	parseGitCredentialRepoPath,
	resolveReadableGitHttpTarget,
} from '#worker/repo/git-http-target.ts'
import { ApiError, invalidRequest } from './errors.ts'
import {
	parseNativeInput,
	type NativeApiOperationDefinition,
} from './native-operation-helpers.ts'
import { type NativeApiOperationId } from './operations.ts'

const gitCredentialMintInputSchema = z
	.object({
		host: z
			.string()
			.min(1)
			.describe(
				'Git credential `host` (for example `kody.codes`). Must match the app origin host.',
			),
		path: z
			.string()
			.min(1)
			.describe(
				'Git credential `path` for the repo, including `.git` (for example `/@owner/name.git`).',
			),
		protocol: z
			.enum(['https'])
			.optional()
			.describe('Git credential `protocol`. Only `https` is supported.'),
	})
	.strict()

const gitCredentialMintOutputSchema = z.object({
	protocol: z.literal('https'),
	host: z.string(),
	path: z.string(),
	username: z.string(),
	password: z
		.string()
		.describe(
			'Short-lived `kody_gt_…` password for Basic auth on this one repo. Shown once.',
		),
	expires_at: z.string(),
	resource_kind: z.enum(['package', 'repo']),
	owner_handle: z.string(),
	repo_name: z.string(),
})

function appOriginHost(appOrigin: string) {
	try {
		return new URL(appOrigin).host.toLowerCase()
	} catch {
		return ''
	}
}

function normalizeGitHost(host: string) {
	return host.trim().toLowerCase().replace(/:\d+$/, '')
}

export const gitCredentialOperationDefinitions: Record<
	Extract<NativeApiOperationId, 'gitCredentialMint'>,
	NativeApiOperationDefinition
> = {
	gitCredentialMint: {
		summary: 'Mint a short-lived git credential for one repo',
		description:
			'Mint a ~1h read-only `kody_gt_…` credential scoped to one `kody.codes/@owner/name.git` path. Used by the CLI git credential helper installed by `kody auth setup-git`. Requires `package:read` on the target. Push is never authorized.',
		inputSchema: gitCredentialMintInputSchema,
		outputSchema: gitCredentialMintOutputSchema,
		readOnly: false,
		async handler(params, ctx) {
			const input = parseNativeInput(gitCredentialMintInputSchema, params)
			if (input.protocol && input.protocol !== 'https') {
				throw invalidRequest('Only https git credentials are supported.')
			}
			const expectedHost = appOriginHost(ctx.callerContext.baseUrl)
			const host = normalizeGitHost(input.host)
			if (!expectedHost || host !== normalizeGitHost(expectedHost)) {
				throw invalidRequest(
					`host must be ${expectedHost || 'the Kody app origin host'}.`,
				)
			}
			const parsedPath = parseGitCredentialRepoPath(input.path)
			if (!parsedPath) {
				throw invalidRequest(
					'path must look like /@owner/name.git (git credential path).',
				)
			}
			const scopes =
				ctx.principal.kind === 'token' ? ctx.principal.token.scopes : null
			const target = await resolveReadableGitHttpTarget({
				env: ctx.env,
				viewer: ctx.callerContext.user,
				ownerHandle: parsedPath.ownerHandle,
				repoName: parsedPath.repoName,
				scopes,
			})
			if (!target) {
				throw new ApiError({
					status: 404,
					code: 'not_found',
					message:
						'Repository not found, or this credential cannot read it. Ensure the API token includes package:read and you can access the package or repo.',
				})
			}
			const path = `/@${target.ownerHandle}/${target.repoName}.git`
			return mintGitAccessToken({
				db: ctx.env.APP_DB,
				userId: ctx.callerContext.user.userId,
				host: expectedHost,
				path,
				ownerHandle: target.ownerHandle,
				repoName: target.repoName,
				resourceKind: target.resourceKind,
				resourceId: target.resourceId,
				resourceOrgId: target.resourceOrgId,
			})
		},
	},
}
