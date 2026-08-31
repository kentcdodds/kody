/**
 * Single MCP-lane switch for the compact-mcp-server-instructions experiment.
 *
 * Delete this file's compact branch (and
 * `instructions/compact-mcp-server-instructions.ts`) when the experiment
 * ends; both `/mcp` lanes already call this helper.
 */

import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { resolveCallerFeatureFlags } from '#mcp/capabilities/access-control.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { compactMcpServerInstructionsFlagKey } from '#mcp/instructions/compact-mcp-server-instructions.ts'
import { loadActiveRetiringNoticeIds } from '#mcp/instructions/retiring-primitives.ts'
import { buildMcpServerInstructions } from '#mcp/server-instructions.ts'
import { getMcpUserServerInstructions } from '#mcp/user-server-instructions-repo.ts'
import { listPopularAgentPackagesForUser } from '#worker/usage/agent-package-conversation-uses.ts'

export async function assembleMcpServerInstructionsForCaller(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<string> {
	const userId = input.callerContext.user?.userId ?? null
	const flags = await resolveCallerFeatureFlags(input.env, input.callerContext)
	const compact = flags[compactMcpServerInstructionsFlagKey] === true
	if (compact) {
		const overlay =
			userId !== null
				? await getMcpUserServerInstructions(input.env.APP_DB, userId)
				: null
		return buildMcpServerInstructions({
			userOverlay: overlay,
			compact: true,
			displayName: input.callerContext.user?.displayName,
		})
	}

	const [overlay, registry, popularPackages, retiringNoticeIds] =
		await Promise.all([
			userId !== null
				? getMcpUserServerInstructions(input.env.APP_DB, userId)
				: Promise.resolve(null),
			getCapabilityRegistryForContext({
				env: input.env,
				callerContext: input.callerContext,
			}),
			userId !== null
				? listPopularAgentPackagesForUser(input.env.APP_DB, { userId })
				: Promise.resolve([]),
			loadActiveRetiringNoticeIds(input.env.APP_DB, userId),
		])
	return buildMcpServerInstructions({
		userOverlay: overlay,
		domains: registry.capabilityDomains,
		popularPackages,
		retiringNoticeIds,
	})
}
