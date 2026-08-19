export const kodyOverviewInstructions = `Kody is a multi-user personal assistant. Each signed-in user gets a fully isolated assistant (packages, jobs, secrets, memories, connectors, email, storage) exposed through two MCP tools: \`search\` and \`execute\`.`

export const endUserDocumentationInstructions = `End-user documentation (workflows, secrets, troubleshooting):
https://github.com/kentcdodds/kody/tree/main/docs/use`

export const quickStartInstructions = `Start here
- Almost every task: \`search({ query })\` first; pass \`domain\` to narrow (domain ids listed below).
- One-off work / smoke tests: \`execute\`. Durable reusable behavior: a package (after \`community_search\` when nothing in-account fits).
- Official guides: \`search({ domain: "coding" })\` or \`search({ query: "… guide" })\`, then \`coding_guide_get\`. Load the relevant guide for package lifecycle/authoring, secrets/OAuth, and integration bootstrap instead of relying on always-on instructions.`

export const packageLifecycleInstructions = `Package lifecycle (primary mental model):
1. Discover and invoke: \`search\` for an existing capability, connected surface, or saved package; open entity detail for the exact call shape; invoke rather than reimplement.
2. Explore temporarily: \`execute\` for one-off work, composition, authenticated smoke tests, and experiments. Execute modules are ephemeral.
3. Prefer a close community package before creating: community listings are excluded from general \`search\` — use \`community_search\` (prefer \`trusted\`). If close, \`community_fork\`, review, adapt, publish. Create only when nothing suitable exists.
4. Create or evolve a repo-backed package when behavior should be reused, maintained, tested, exposed as an app/service, or given a package-owned schedule, and step 3 found nothing. Search once more before creating so you extend an existing package when that fits.`

export const packageEscalationInstructions = `Escalate from \`execute\` to a package when the user wants reusable named behavior they will keep improving; when the code needs multiple files, dependencies, tests, binary assets, version history, or review; when it needs a durable surface (exports, package-owned jobs, app, or service); or when you keep rewriting substantially the same execute module. Scheduling alone is not a reason to package — use \`job_schedule\` for ad hoc schedules, and package-owned jobs when the schedule belongs to reusable package behavior.`

export const conventionInstructions = `Conventions:
- Package state: source is the repo; credentials are secrets keyed by saved package id; runtime state and knobs are \`packageStorage()\`; versioned config lives in the repo; coordination is services; schedules are jobs — package apps/jobs/services are package-owned surfaces, not separate primitives.
- When sharing a community listing with a human, use its \`public_url\` (\`/@username/kody-id\`); never construct \`/community/{listing_id}\` for people.
- Discover capabilities with \`search\`; entity detail includes the exact call shape. Memory writes are verify-first: \`meta_memory_verify\` before upsert/delete.
- Durable user facts and preferences belong in memories. The optional MCP instruction overlay (\`meta_get_mcp_server_instructions\` / \`meta_set_mcp_server_instructions\`) is only for rare always-on session policy — not package inventory (popular packages are hinted automatically). Overlay updates apply to new MCP sessions.`

export const domainHeadingInstructions =
	'Domains (scope discovery with `search({ query, domain })` or list one with `search({ domain })`)'

export const baseMcpServerInstructionFragmentsBeforePopular = [
	kodyOverviewInstructions,
	endUserDocumentationInstructions,
	quickStartInstructions,
	packageLifecycleInstructions,
	packageEscalationInstructions,
	conventionInstructions,
] as const

export const baseMcpServerInstructionFragmentsAfterPopular = [
	domainHeadingInstructions,
] as const
