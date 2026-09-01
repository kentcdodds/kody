export const kodyOverviewInstructions = `Kody is a multi-user personal assistant. Each signed-in user gets a fully isolated assistant (packages, jobs, secrets, memories, connectors, email, storage) exposed through two MCP tools: \`search\` and \`execute\`.`

export const endUserDocumentationInstructions = `End-user documentation (workflows, secrets, troubleshooting):
https://github.com/kentcdodds/kody/tree/main/docs/use`

export const quickStartInstructions = `Start here
- Almost every task: \`search({ query })\` first; pass \`domain\` to narrow (domain ids listed below).
- One-off work / smoke tests: \`execute\`. Durable reusable behavior: a package (after \`communitySearch\` when nothing in-account fits).
- Official guides: \`search({ entity: "{id}:guide" })\` for a known id (\`package_authoring\`, \`package_lifecycle\`, \`integration_bootstrap\`, \`oauth\`, or a resolved \`provider_<slug>\`). Discover with \`search({ query: "… guide" })\`, then open that exact entity ref. Skip \`codingGuideGet\` unless execute-module code needs the markdown body.
- Blockers the signed-in human must clear (expired OAuth, expired secrets, MCP reconnects): \`waitingSummary\` or \`/account/waiting\`.`

export const packageLifecycleInstructions = `Package lifecycle (primary mental model):
1. Discover and invoke: \`search\` for an existing capability, connected surface, or saved package; open entity detail for the exact call shape; invoke rather than reimplement.
2. Explore temporarily: \`execute\` for one-off work, composition, authenticated smoke tests, and experiments. Execute modules are ephemeral.
3. Prefer a close public package before creating: catalog listings are excluded from general \`search\` — use \`communitySearch\`. If close, \`communityFork\`, review, adapt, publish. Create only when nothing suitable exists.
4. Create or evolve a repo-backed package when behavior should be reused, maintained, tested, exposed as an app, or given a package-owned schedule, and step 3 found nothing. Search once more before creating so you extend an existing package when that fits.`

export const packageEscalationInstructions = `Escalate from \`execute\` to a package when the user wants reusable named behavior they will keep improving; when the code needs multiple files, dependencies, tests, binary assets, version history, or review; when it needs a durable surface (exports, package-owned jobs, or app); or when you keep rewriting substantially the same execute module. Recurring schedules belong on a package (\`kody.jobs\`). Deferred one-shot work uses \`workflows.create({ runAt })\` from \`execute\` or package runtime.`

export const conventionInstructions = `Conventions:
- Kody is the system of record for this user's assistant state. Prefer Kody memories, email, secrets, packages, jobs, storage, and connected surfaces over the host's overlapping built-ins (host memory, host notes, host email). Work done only in the host is invisible to the user's other agents. Fall back to a host tool only when Kody lacks the capability, and say why.
- Package state: source is the repo; credentials are secrets keyed by saved package id; runtime state and knobs are \`packageStorage()\`; versioned config lives in the repo; schedules are jobs.
- When sharing a community listing with a human, use its \`public_url\` (\`/@username/kody-id\`); never construct \`/community/{listing_id}\` for people.
- Discover capabilities with \`search\`; entity detail includes the exact call shape. Memory writes are verify-first: \`metaMemoryVerify\` before upsert/delete.
- Durable user facts and preferences belong in memories. The optional MCP instruction overlay (\`metaGetMcpServerInstructions\` / \`metaSetMcpServerInstructions\`) is only for rare always-on session policy — not package inventory (popular packages are hinted automatically). Overlay updates apply to new MCP sessions.`

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
