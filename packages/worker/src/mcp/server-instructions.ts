import { type CapabilityDomainMetadata } from '#mcp/capabilities/types.ts'
import {
	baseMcpServerInstructionFragmentsAfterPopular,
	baseMcpServerInstructionFragmentsBeforePopular,
} from '#mcp/instructions/base-server-fragments.ts'

const baseMcpServerInstructionsBeforePopular =
	baseMcpServerInstructionFragmentsBeforePopular.join('\n\n')
const baseMcpServerInstructionsAfterPopular =
	baseMcpServerInstructionFragmentsAfterPopular.join('\n\n')

function formatDomainInstructions(
	domains: ReadonlyArray<CapabilityDomainMetadata>,
) {
	return domains
		.map((domain) => `- \`${domain.name}\`: ${domain.description}`)
		.join('\n')
}

const maxRemoteConnectorDescriptionChars = 240

/** Soft budget for the popular-packages hint section (names + short blurbs). */
export const popularPackagesInstructionCharBudget = 550
const maxPopularPackageDescriptionChars = 48

export type RemoteConnectorInstructionSummary = {
	name: string
	domain: string
	description?: string | null
}

export type PopularPackageInstructionSummary = {
	kodyId: string
	description?: string | null
}

function truncateRemoteConnectorDescription(description: string) {
	if (description.length <= maxRemoteConnectorDescriptionChars) {
		return description
	}
	return `${description.slice(0, maxRemoteConnectorDescriptionChars - 3).trimEnd()}...`
}

function truncatePopularPackageDescription(description: string) {
	const trimmed = description.trim().replace(/\s+/g, ' ')
	if (!trimmed) return ''
	if (trimmed.length <= maxPopularPackageDescriptionChars) {
		return trimmed
	}
	return `${trimmed.slice(0, maxPopularPackageDescriptionChars - 3).trimEnd()}...`
}

function formatRemoteConnectorInstructions(
	connectors: ReadonlyArray<RemoteConnectorInstructionSummary> | undefined,
) {
	if (!connectors?.length) return ''
	const lines = connectors.map((connector) => {
		const description = connector.description?.trim()
		return description
			? `- \`${connector.name}\` (\`${connector.domain}\`): ${truncateRemoteConnectorDescription(description)}`
			: `- \`${connector.name}\` (\`${connector.domain}\`)`
	})
	return `

Connected remote connectors
${lines.join('\n')}
`
}

/**
 * Compact packages-first popularity hint. Omits entirely when empty (cold
 * start). Frames as a hint, not a whitelist; stays under a soft char budget.
 */
export function formatPopularPackagesInstructions(
	packages: ReadonlyArray<PopularPackageInstructionSummary> | undefined,
	options: { charBudget?: number } = {},
): string {
	if (!packages?.length) return ''
	const charBudget = options.charBudget ?? popularPackagesInstructionCharBudget
	const prefix = 'Often used from agents: '
	const suffix = ' — discover others with `search`'
	const parts: Array<string> = []
	let used = prefix.length + suffix.length

	for (const pkg of packages) {
		const kodyId = pkg.kodyId.trim()
		if (!kodyId) continue
		const description = truncatePopularPackageDescription(pkg.description ?? '')
		const part = description
			? `\`${kodyId}\` — ${description}`
			: `\`${kodyId}\``
		const separatorCost = parts.length > 0 ? 2 : 0 // "; "
		if (used + separatorCost + part.length > charBudget) {
			if (parts.length === 0) {
				// Always include at least the first kody id, truncated if needed.
				const available = Math.max(8, charBudget - used)
				parts.push(
					part.length <= available
						? part
						: `${part.slice(0, available - 3)}...`,
				)
			}
			break
		}
		used += separatorCost + part.length
		parts.push(part)
	}

	if (parts.length === 0) return ''
	return `

${prefix}${parts.join('; ')}${suffix}
`
}

export function buildBaseMcpServerInstructions(
	input: {
		domains?: ReadonlyArray<CapabilityDomainMetadata>
		remoteConnectors?: ReadonlyArray<RemoteConnectorInstructionSummary>
		popularPackages?: ReadonlyArray<PopularPackageInstructionSummary>
	} = {},
): string {
	const domainInstructions = formatDomainInstructions(input.domains ?? [])
	return `
${baseMcpServerInstructionsBeforePopular}
${formatPopularPackagesInstructions(input.popularPackages)}
${baseMcpServerInstructionsAfterPopular}
${domainInstructions}
${formatRemoteConnectorInstructions(input.remoteConnectors)}
	`.trim()
}

export function buildMcpServerInstructions(
	input:
		| string
		| null
		| undefined
		| {
				userOverlay?: string | null | undefined
				domains?: ReadonlyArray<CapabilityDomainMetadata>
				remoteConnectors?: ReadonlyArray<RemoteConnectorInstructionSummary>
				popularPackages?: ReadonlyArray<PopularPackageInstructionSummary>
		  },
): string {
	const normalizedInput =
		typeof input === 'object' && input !== null ? input : { userOverlay: input }
	const base = buildBaseMcpServerInstructions({
		domains: normalizedInput.domains,
		remoteConnectors: normalizedInput.remoteConnectors,
		popularPackages: normalizedInput.popularPackages,
	})
	const userOverlay = normalizedInput.userOverlay
	const trimmed = userOverlay?.trim()
	if (!trimmed) return base
	return `${base}

---
User-provided MCP instructions (follow these when they do not conflict with safety or tool contracts):
${trimmed}`
}
