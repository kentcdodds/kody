import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import {
	normalizeRepoManifestSummary,
	repoRunChecksOutputSchema,
} from '#mcp/capabilities/repo/repo-shared.ts'
import {
	packageCheckInputSchema,
	requirePackageSession,
} from './package-shell-shared.ts'

export const packageCheckCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_check',
		description:
			'Run Kody trusted package validation for the current package shell session after shell edits have been committed and pushed.',
		keywords: ['package', 'check', 'validate', 'bundle', 'typecheck', 'shell'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: packageCheckInputSchema,
		outputSchema: repoRunChecksOutputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const session = await requirePackageSession({
				env: ctx.env,
				userId: user.userId,
				sessionId: args.session_id,
			})
			const rpc = repoSessionRpc(ctx.env, session.id)
			await rpc.syncSessionFromRemote({
				sessionId: session.id,
				userId: user.userId,
			})
			const result = await rpc.runChecks({
				sessionId: session.id,
				userId: user.userId,
			})
			return {
				ok: result.ok,
				results: result.results.map((entry) => ({
					kind: entry.kind,
					ok: entry.ok,
					message: entry.message,
				})),
				manifest: normalizeRepoManifestSummary(result.manifest),
			}
		},
	},
)
