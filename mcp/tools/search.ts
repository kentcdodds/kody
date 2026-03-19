import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { capabilitySpecs } from '#mcp/capabilities/registry.ts'
import {
	createSearchExecutor,
	formatExecutionOutput,
	wrapSearchCode,
} from '#mcp/executor.ts'
import { type MCP } from '#mcp/index.ts'

const capabilityDomains = Array.from(
	new Set(
		Object.values(capabilitySpecs).map((capability) => capability.domain),
	),
).sort()

// TODO: If the domain list grows large, replace this inline hint with a
// dedicated `findDomains()` helper in the search sandbox.
const searchTool = {
	name: 'search',
	title: 'Search Capabilities',
	description: `
Search Kody capabilities. Use this tool first to discover the right capability
before calling \`execute\`.

Current domains: ${capabilityDomains.join(', ')}.

Available in your code:

interface CapabilitySummary {
  name: string;
  domain: string;
  requiredInputFields: string[];
}

interface DetailedCapabilitySummary extends CapabilitySummary {
  description: string;
  keywords: string[];
  readOnly: boolean;
  idempotent: boolean;
  destructive: boolean;
  inputFields?: string[];
  outputFields?: string[];
  inputSchema: unknown;
  outputSchema?: unknown;
}

interface CapabilityInfo extends DetailedCapabilitySummary {}

declare const capabilities: Record<string, CapabilityInfo>;
declare function getCapability(name: string): CapabilityInfo | undefined;
declare function findCapabilities(query?: {
  text?: string;
  domain?: string;
  keyword?: string;
  inputField?: string;
  outputField?: string;
  readOnly?: boolean;
  idempotent?: boolean;
  destructive?: boolean;
  detail?: boolean;
}): Array<CapabilitySummary | DetailedCapabilitySummary>;

Your code must be an async arrow function that returns the result.
\`findCapabilities(...)\` is the default helper for targeted discovery and
returns a compact summary by default.
\`getCapability(name)\` is for exact-name lookup when you already know the
capability you want to inspect.
\`capabilities\` is the low-level source-of-truth map for arbitrary JavaScript
queries that are not covered by the helper parameters.
Use \`detail: true\` or \`getCapability(name)\` when you need richer metadata or
full schemas. When a schema is present, the corresponding \`inputFields\` or
\`outputFields\` list is omitted to avoid repeating the same information.

Examples:

\`async () =>
  findCapabilities({ domain: 'math', keyword: 'arithmetic' })\`

\`async () =>
  findCapabilities({ domain: 'math', inputField: 'operator' })\`

\`async () => getCapability('do_math')\`

\`async () =>
  Object.values(capabilities)
    .filter((capability) => capability.idempotent && capability.domain === 'math')
    .map(({ name, domain, requiredInputFields }) => ({
      name,
      domain,
      requiredInputFields,
    }))\`
	`.trim(),
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	} satisfies ToolAnnotations,
} as const

export async function registerSearchTool(agent: MCP) {
	agent.server.registerTool(
		searchTool.name,
		{
			title: searchTool.title,
			description: searchTool.description,
			inputSchema: {
				code: z
					.string()
					.describe('JavaScript async arrow function to search capabilities.'),
			},
			annotations: searchTool.annotations,
		},
		async ({ code }: { code: string }) => {
			const executor = createSearchExecutor(agent.getEnv(), capabilitySpecs)
			const result = await executor.execute(wrapSearchCode(code), {})

			if (result.error) {
				return {
					content: [
						{
							type: 'text',
							text: formatExecutionOutput(result),
						},
					],
					structuredContent: {
						error: result.error,
						logs: result.logs ?? [],
					},
					isError: true,
				}
			}

			return {
				content: [
					{
						type: 'text',
						text: formatExecutionOutput(result),
					},
				],
				structuredContent: {
					result: result.result,
					logs: result.logs ?? [],
				},
			}
		},
	)
}
