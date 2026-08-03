import { type CapabilityDomainMetadata } from '#mcp/capabilities/types.ts'
import {
	baseMcpServerInstructionFragmentsAfterPopular,
	baseMcpServerInstructionFragmentsBeforePopular,
} from '#mcp/instructions/base-server-fragments.ts'

const baseMcpServerInstructionsBeforePopular =
	baseMcpServerInstructionFragmentsBeforePopular.join('\n\n')
const baseMcpServerInstructionsAfterPopular =
	baseMcpServerInstructionFragmentsAfterPopular.join('\n\n')

/** Soft budget for the popular-packages hint section (header + name bullets). */
export const popularPackagesInstructionCharBudget = 550

/** Hard cap matching the popularity query's top-N. */
export const popularPackagesInstructionMaxCount = 8

/** Keep domain blurbs short in always-loaded instructions. */
export const domainInstructionDescriptionMaxChars = 90

export type PopularPackageInstructionSummary = {
	kodyId: string
	description?: string | null
}

function truncateInstructionDescription(description: string, maxChars: number) {
	const trimmed = description.trim().replace(/\s+/g, ' ')
	if (!trimmed) return ''
	if (trimmed.length <= maxChars) return trimmed
	const slice = trimmed.slice(0, maxChars - 3).trimEnd()
	const lastSpace = slice.lastIndexOf(' ')
	const clipped =
		lastSpace >= Math.floor(maxChars * 0.6) ? slice.slice(0, lastSpace) : slice
	return `${clipped}...`
}

function formatDomainInstructions(
	domains: ReadonlyArray<CapabilityDomainMetadata>,
) {
	return domains
		.map((domain) => {
			const description = truncateInstructionDescription(
				domain.description,
				domainInstructionDescriptionMaxChars,
			)
			return description
				? `- \`${domain.name}\`: ${description}`
				: `- \`${domain.name}\``
		})
		.join('\n')
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
	const header =
		'Often used packages (hints, not inventory — discover others with `search`):'
	const lines: Array<string> = []
	let used = header.length + 1 // trailing newline before first bullet

	for (const pkg of packages) {
		if (lines.length >= popularPackagesInstructionMaxCount) break
		const kodyId = pkg.kodyId.trim()
		if (!kodyId) continue
		const line = `- \`${kodyId}\``
		const separatorCost = lines.length > 0 ? 1 : 0 // "\n"
		if (used + separatorCost + line.length > charBudget) {
			if (lines.length === 0) {
				// Always include at least the first kody id, truncated if needed.
				const available = Math.max(8, charBudget - used)
				lines.push(
					line.length <= available
						? line
						: `${line.slice(0, available - 3)}...`,
				)
			}
			break
		}
		used += separatorCost + line.length
		lines.push(line)
	}

	if (lines.length === 0) return ''
	return `

${header}
${lines.join('\n')}
`
}

export function buildBaseMcpServerInstructions(
	input: {
		domains?: ReadonlyArray<CapabilityDomainMetadata>
		popularPackages?: ReadonlyArray<PopularPackageInstructionSummary>
	} = {},
): string {
	const domainInstructions = formatDomainInstructions(input.domains ?? [])
	return `
${baseMcpServerInstructionsBeforePopular}
${formatPopularPackagesInstructions(input.popularPackages)}
${baseMcpServerInstructionsAfterPopular}
${domainInstructions}
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
				popularPackages?: ReadonlyArray<PopularPackageInstructionSummary>
		  },
): string {
	const normalizedInput =
		typeof input === 'object' && input !== null ? input : { userOverlay: input }
	const base = buildBaseMcpServerInstructions({
		domains: normalizedInput.domains,
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
