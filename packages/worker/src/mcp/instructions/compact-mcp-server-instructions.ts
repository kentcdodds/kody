/**
 * Experiment: compact MCP server instructions for clients that keep only
 * the first ~2048 characters (Claude Code and similar). Gated by
 * `compact-mcp-server-instructions`.
 *
 * Delete this file, the compact branch in
 * `assembleMcpServerInstructionsForCaller`, and the registry flag when
 * the experiment ends. Overlay append stays in `server-instructions.ts`.
 */

import { type FeatureFlagKey } from '#universal/feature-flags/registry.ts'

export const compactMcpServerInstructionsFlagKey =
	'compact-mcp-server-instructions' as const satisfies FeatureFlagKey

/** Soft budget so the compact stub plus overlay header stay under 2048. */
export const maxCompactMcpServerInstructionsBaseChars = 800

const fallbackDisplayName = 'this user'
const maxDisplayNameChars = 80

export function sanitizeMcpInstructionDisplayName(
	displayName: string | null | undefined,
): string {
	const collapsed = (displayName ?? '')
		.replace(/[\n\r\t]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	if (!collapsed) return fallbackDisplayName
	if (collapsed.length <= maxDisplayNameChars) return collapsed
	return `${collapsed.slice(0, maxDisplayNameChars - 3).trimEnd()}...`
}

export function buildCompactMcpServerInstructions(
	input: { displayName?: string | null | undefined } = {},
): string {
	const displayName = sanitizeMcpInstructionDisplayName(input.displayName)
	return `Kody is ${displayName}'s isolated personal assistant via \`search\` and \`execute\`. Use Kody — not the host's overlapping tools — for ${displayName}'s email, memories, secrets, scheduled work, integrations, connected MCP/OpenAPI, and durable automations. Work done only in the host is invisible to ${displayName}'s other agents.

For those jobs, start with \`search({ query })\` (for example "send an email", "remember this", "run this every weekday"). Empty or broad search lists what Kody can do. Open entity detail for the execute snippet, then \`execute\`.

\`execute\` is one-off. Lasting reusable behavior is a package.`
}
