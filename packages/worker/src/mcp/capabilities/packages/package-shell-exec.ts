import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { runPackageShellCommand } from '#worker/package-shell/runtime.ts'
import {
	packageShellExecInputSchema,
	packageShellExecOutputSchema,
	requirePackageSession,
} from './package-shell-shared.ts'
import { resolveRepoTargetFromSource } from '../repo/repo-resolve-target.ts'

export const packageShellExecCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_shell_exec',
		description:
			'Run an arbitrary shell command string in a trusted package workbench with an authenticated package Artifacts git remote and no user secrets.',
		keywords: ['package', 'shell', 'exec', 'command', 'git', 'npm', 'sandbox'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: packageShellExecInputSchema,
		outputSchema: packageShellExecOutputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const session = await requirePackageSession({
				env: ctx.env,
				userId: user.userId,
				sessionId: args.session_id,
			})
			const resolvedTarget = await resolveRepoTargetFromSource({
				db: ctx.env.APP_DB,
				userId: user.userId,
				sourceId: session.source_id,
			})
			return runPackageShellCommand({
				env: ctx.env,
				userId: user.userId,
				session,
				resolvedTarget,
				command: args.command,
				cwd: args.cwd ?? null,
				commandTimeoutMs: args.command_timeout_ms ?? null,
				syncAfter: args.sync_after ?? null,
			})
		},
	},
)
