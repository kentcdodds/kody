import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { openPackageShell } from '#worker/package-shell/runtime.ts'
import {
	packageShellOpenInputSchema,
	packageShellOpenOutputSchema,
	openPackageRepoSession,
} from './package-shell-shared.ts'

export const packageShellOpenCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_shell_open',
		description:
			'Open or reuse a trusted shell workbench for a saved package repo. Use shell as the primary authoring primitive, then run package_check and package_publish separately.',
		keywords: ['package', 'shell', 'sandbox', 'repo', 'git', 'workbench'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: packageShellOpenInputSchema,
		outputSchema: packageShellOpenOutputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const session = await openPackageRepoSession({ args, ctx, user })
			const opened = await openPackageShell({
				env: ctx.env,
				userId: user.userId,
				session,
				resolvedTarget: session.resolved_target,
				commandTimeoutMs: args.command_timeout_ms,
			})
			return opened.output
		},
	},
)
