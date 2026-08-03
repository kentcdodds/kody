import { expect, test } from 'vitest'
import {
	buildBaseMcpServerInstructions,
	buildMcpServerInstructions,
	formatPopularPackagesInstructions,
	popularPackagesInstructionCharBudget,
} from './server-instructions.ts'

test('base MCP server instructions preserve exact prose with domains and popular packages', () => {
	expect(
		buildBaseMcpServerInstructions({
			domains: [
				{ name: 'email', description: 'Send and read mail' },
				{ name: 'jobs', description: 'Schedule durable work' },
			],
			popularPackages: [
				{ kodyId: 'notes', description: 'Scratch notes' },
				{ kodyId: 'calendar-sync', description: 'Keep calendars aligned' },
			],
		}),
	).toMatchInlineSnapshot(`
		"Kody is a multi-user personal assistant. Each signed-in user gets a fully isolated assistant (packages, jobs, secrets, values, memories, connectors, email, storage) exposed through two MCP tools: \`search\` and \`execute\`.

		End-user documentation (workflows, secrets, troubleshooting):
		https://github.com/kentcdodds/kody/tree/main/docs/use

		Start here
		- Almost every task: \`search({ query })\` first; pass \`domain\` to narrow (domain ids listed below).
		- One-off work / smoke tests: \`execute\`. Durable reusable behavior: a package (after \`community_search\` when nothing in-account fits).
		- Official guides: \`search({ domain: "coding" })\` or \`search({ query: "… guide" })\`, then \`coding_guide_get\`. Load \`coding_guide_get({ guide: "package_lifecycle" })\` when fork/create/escalate is unclear.

		Package lifecycle (primary mental model):
		1. Discover and invoke: \`search\` for an existing capability, connected surface, or saved package; open entity detail for the exact call shape; invoke rather than reimplement.
		2. Explore temporarily: \`execute\` for one-off work, composition, authenticated smoke tests, and experiments. Execute modules are ephemeral.
		3. Prefer a close community package before creating: community listings are excluded from general \`search\` — use \`community_search\` (prefer \`trusted\`). If close, \`community_fork\`, review, adapt, publish. Create only when nothing suitable exists.
		4. Create or evolve a repo-backed package when behavior should be reused, maintained, tested, exposed as an app/service, or given a package-owned schedule, and step 3 found nothing. Search once more before creating so you extend an existing package when that fits.

		Escalate from \`execute\` to a package when the user wants reusable named behavior they will keep improving; when the code needs multiple files, dependencies, tests, binary assets, version history, or review; when it needs a durable surface (exports, package-owned jobs, app, or service); or when you keep rewriting substantially the same execute module. Scheduling alone is not a reason to package — use \`job_schedule\` for ad hoc schedules, and package-owned jobs when the schedule belongs to reusable package behavior.

		Package authoring lanes:
		- Coding agents with local filesystem/git: \`package_get_git_remote\` (\`create: true\` + new \`kody_id\` registers a stub and mints the remote), clone, edit/test, push, then \`package_publish_external_push\`.
		- Tool-only agents: \`package_save\` (full UTF-8 file set rooted at \`package.json\`) plus \`repo_*\` sessions. If the work needs binaries, many-file changes, or local build/test loops, prefer a coding-capable agent.
		- When creating or materially changing a package, load \`coding_guide_get({ guide: "package_authoring" })\` and keep a root \`README.md\` \`## Intent\` section with the user's goal.

		Conventions:
		- Credentials: never ask users to paste secrets, tokens, API keys, passwords, or credentials into chat. For API keys/PATs, always send a prefilled \`/account/secrets/new?name=…&description=…&allowedHosts=…&scope=user\` link (see \`coding_guide_get({ guide: "connect_secret" })\` for params) — never the bare secrets page. For OAuth setup or reconnect, link \`/connect/oauth?provider=<integration-name>\` (see \`coding_guide_get({ guide: "oauth" })\`).
		- Integration-backed work: before building packages/apps that need third-party auth, load \`coding_guide_get({ guide: "integration_bootstrap" })\`, confirm the \`integration\` or \`secret\` via \`search\`, run a cheap authenticated \`execute\` smoke test, then \`community_search\` for a trusted close package. Do not call auth-dependent work complete until that smoke test succeeds.
		- After \`package_save\` / \`package_publish_external_push\`, read \`pending_secret_package_approvals\` in the tool result when present; follow its guidance before calling the package complete.
		- Package state: source is the repo; config is secrets/values keyed by saved package id; durable data is \`packageStorage()\`; coordination is services; schedules are jobs — package apps/jobs/services are package-owned surfaces, not separate primitives.
		- Discover capabilities with \`search\`; entity detail includes the exact call shape. Memory writes are verify-first: \`meta_memory_verify\` before upsert/delete.
		- Durable user facts and preferences belong in memories. The optional MCP instruction overlay (\`meta_get_mcp_server_instructions\` / \`meta_set_mcp_server_instructions\`) is only for rare always-on session policy — not package inventory (popular packages are hinted automatically). Overlay updates apply to new MCP sessions.


		Often used packages (hints, not inventory — discover others with \`search\`):
		- \`notes\`
		- \`calendar-sync\`

		Domains (scope discovery with \`search({ query, domain })\` or list one with \`search({ domain })\`)
		- \`email\`: Send and read mail
		- \`jobs\`: Schedule durable work"
	`)
})

test('popular package MCP instructions omit cold start, list kody ids under budget, and keep overlays', () => {
	expect(formatPopularPackagesInstructions(undefined)).toBe('')
	expect(formatPopularPackagesInstructions([])).toBe('')
	expect(buildBaseMcpServerInstructions({ popularPackages: [] })).not.toMatch(
		/`email-helper`|`notes`/,
	)

	const section = formatPopularPackagesInstructions([
		{ kodyId: 'email-helper', description: 'Send and read mail' },
		{ kodyId: 'calendar-sync', description: '' },
	])
	expect(section).toMatch(/`email-helper`/)
	expect(section).toMatch(/`calendar-sync`/)
	expect(section).toContain('- `email-helper`')
	expect(section).not.toContain('Send and read mail')

	const many = Array.from({ length: 12 }, (_, index) => ({
		kodyId: `pkg-${String(index + 1).padStart(2, '0')}`,
		description: 'A reasonably long one-line description for packing',
	}))
	const capped = formatPopularPackagesInstructions(many)
	const listed = [...capped.matchAll(/`pkg-\d+`/g)].map((match) => match[0])
	expect(listed.length).toBeGreaterThan(0)
	expect(listed.length).toBeLessThanOrEqual(8)
	expect(capped.trim().length).toBeLessThanOrEqual(
		popularPackagesInstructionCharBudget + 10,
	)
	expect(
		[
			...formatPopularPackagesInstructions(many, { charBudget: 80 }).matchAll(
				/`pkg-\d+`/g,
			),
		].length,
	).toBeLessThanOrEqual(2)

	const instructions = buildMcpServerInstructions({
		popularPackages: [{ kodyId: 'notes', description: 'Scratch notes' }],
		userOverlay: 'Prefer concise replies.',
		domains: [],
	})
	expect(instructions).toMatch(/`notes`/)
	expect(instructions).toContain('Prefer concise replies.')
	expect(instructions).not.toContain('Connected remote connectors')
	expect(instructions).not.toContain('Kody repository (for contributors)')
})

test('domain instruction blurbs truncate long descriptions', () => {
	const instructions = buildBaseMcpServerInstructions({
		domains: [
			{
				name: 'admin',
				description:
					'Admin-only operator capabilities for account metadata, platform accounts, package scope grants, fleet package-codemod scan/dry-run/apply/revert over published package trees, feature flags, and much more detail that should not all appear in always-loaded instructions.',
			},
		],
	})
	const line = instructions
		.split('\n')
		.find((entry) => entry.includes('`admin`'))
	expect(line).toBeTruthy()
	expect(line!.length).toBeLessThan(130)
	expect(line).toContain('...')
})
