import { type CapabilityDomainMetadata } from '#mcp/capabilities/types.ts'

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
End-user documentation (workflows, secrets, troubleshooting):
https://github.com/kentcdodds/kody/tree/main/docs/use

Package lifecycle (use this as the primary mental model):
1. Discover and invoke before building: use \`search\` to find an existing built-in capability, connected capability, or saved package, inspect the entity detail for its exact call shape, then invoke it rather than reimplementing it.
2. Explore temporarily: use \`execute\` for quick one-off work, capability composition, authenticated smoke tests, and experiments. Execute modules are ephemeral, not the durable home for behavior.
3. Prefer a close community package before creating: community listings are excluded from general \`search\`, so call \`community_search\` (prefer \`trusted\` matches) when you need durable reusable behavior and nothing in the user's account fits. If a listing is close to the user's goal, fork with \`community_fork\`, review and adapt it, then publish — do not reimplement from scratch. Create a new package only when no suitable listing exists.
4. Create or evolve a repo-backed package when behavior should be reused, maintained, tested, exposed as an app or service, or given a package-owned schedule, and step 3 found nothing suitable. Search once more before creating one so you extend an existing package when that is the better fit.

Escalate from \`execute\` to a package when the user wants reusable named behavior they expect to keep improving, when the code needs multiple files, dependencies, tests, binary assets, version history, or review, when the behavior needs a durable surface (package exports, package-owned jobs, an app, or a service), or when you are repeatedly editing substantially the same execute module. Keep genuinely one-off exploration in \`execute\`. Scheduling alone does not require a package: use \`job_schedule\` for ad hoc or simple self-contained schedules and package-owned jobs when the schedule belongs to reusable, evolving package behavior. Before creating, check \`community_search\` for a trusted close package. Load \`coding_guide_get({ guide: "package_lifecycle" })\` when the fork-vs-create or escalation call is unclear.

Package authoring lanes:
- Coding agents with local filesystem/git access: \`package_get_git_remote\` (pass \`create: true\` with a new \`kody_id\` to register a stub package and mint its remote in one call), clone into a temporary directory, edit and test normally (binary assets supported), push, then publish with \`package_publish_external_push\`.
- Tool-only agents: \`package_save\` (creates or replaces a repo-backed package rooted at \`package.json\` from the complete UTF-8 text file set) plus \`repo_*\` sessions. If the work needs binary assets, many-file changes, or local build/test loops, tell the user it fits a coding-capable agent better and confirm before proceeding tool-only.
- When creating or materially changing a package, load \`coding_guide_get({ guide: "package_authoring" })\` and keep a root \`README.md\` \`## Intent\` section with the user's goal; ask the user if unclear and update it when scope expands.

Conventions:
- Both tools accept optional \`conversationId\` and \`memoryContext\` fields (documented in their input schemas); reuse the returned \`conversationId\` across related calls.
- Credential setup uses the standard setup pages: \`/connect/oauth\` for OAuth integrations and reconnects, \`/account/secrets/new\` for API keys, PATs, and other user-provided secrets. Never ask users to paste secrets, tokens, API keys, passwords, or credentials into chat.
- Integration-backed work: before building packages, package apps, or workflows that depend on third-party auth, call \`coding_guide_get({ guide: "integration_bootstrap" })\`, confirm the required \`integration\` or \`secret\` entity exists through \`search\`, run a cheap authenticated \`execute\` smoke test, then check \`community_search\` for a trusted close package before creating one. Do not present auth-dependent work as complete until that smoke test succeeds.
- Package secret approvals: self-authored packages (and community forks adopted via \`community_fork_adopt\` after a real source review) get automatic read/use access to user secrets; updating or deleting a user secret from package code still needs an \`allowed_packages\` grant. Unadopted community forks still need explicit approval for read/use, or adopt after review. Saving a user secret or passing an ad hoc \`execute\` smoke test does **not** approve community-fork package use. After \`package_save\` / \`package_publish_external_push\`, read \`pending_secret_package_approvals\` from the tool result (non-null only for unadopted community forks). Prefer reviewing + \`community_fork_adopt\`, or send \`bulk_approval_url\` / each \`approval_url\`. Wait when required, then verify with \`packages.invokeChecked\` before calling the package complete.
- Jobs, workflows, sessions, services, values, storage, and the other capability groups below are individual capabilities: discover them with \`search\`, whose entity detail includes each capability's exact call shape.
- Memory writes are verify-first: run \`meta_memory_verify\` before \`meta_memory_upsert\` or \`meta_memory_delete\`.
- User-specific MCP instructions: \`meta_get_mcp_server_instructions\` / \`meta_set_mcp_server_instructions\` (signed-in users) are for preferences and workflow notes only — not for maintaining a package inventory (popular packages are hinted automatically when available). Updates apply to **new** MCP sessions.
${formatPopularPackagesInstructions(input.popularPackages)}
Kody repository (for contributors): https://github.com/kentcdodds/kody

Domains (builtin capability groups)
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
