export const executeToolOverviewDescription = `Run one ephemeral ESM module string with a default export. Bare npm imports resolve at bundle time and must support the Cloudflare Workers runtime. Discover capabilities with \`search\`; use entity detail for exact call shapes.`

export const executeToolProjectionRuleDescription = `Projection rule: you write the code -- if a call returns a large response, project the fields you need before returning. Never return raw API responses; extract a slim shape (e.g. \`{ id, subject, snippet }\`) or a summary.`

export const executeToolCapabilityCallsDescription = `Import \`{ kody }\` from \`kody:runtime\`. Call builtins as \`kody.capability_id(input)\`, connected MCP tools as \`kody.mcp["server-name"].tool_name(input)\`, and OpenAPI operations as \`kody.openapi["name"].operation_slug(input)\`.`

export const executeToolGuideDescription =
	'Load `coding_guide_get` for secrets, package invocation, workflows, and idempotency instead of guessing their operational rules.'

export const executeToolDescriptionFragments = [
	executeToolOverviewDescription,
	executeToolProjectionRuleDescription,
	executeToolCapabilityCallsDescription,
	executeToolGuideDescription,
] as const

export const executeToolDescription =
	executeToolDescriptionFragments.join('\n\n')
