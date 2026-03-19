import * as Sentry from '@sentry/cloudflare'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
	capabilityDomains,
	capabilityDomainDescriptionsByName,
	capabilitySpecs,
} from '#mcp/capabilities/registry.ts'
import {
	createSearchExecutor,
	formatExecutionOutput,
	wrapSearchCode,
} from '#mcp/executor.ts'
import { type MCP } from '#mcp/index.ts'
import {
	callerContextFields,
	errorFields,
	logMcpEvent,
} from '#mcp/observability.ts'

const capabilityDomainSummary = capabilityDomains
	.map((domain) => `- \`${domain.name}\`: ${domain.description}`)
	.join('\n')

// TODO: If the domain list grows large, replace this inline hint with a
// dedicated `findDomains()` helper in the search sandbox.
const searchTool = {
	name: 'search',
	title: 'Search Capabilities',
	description: `
Search Kody capabilities. Use this tool first to discover the right capability
before calling \`execute\`.

Domains:
${capabilityDomainSummary}

Available in your code:

interface DomainInfo {
  name: string;
  description: string;
}

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
declare const domains: Record<string, string>;
declare function getCapability(name: string): CapabilityInfo | undefined;
declare function getDomain(name: string): string | undefined;
declare function listDomains(): DomainInfo[];
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
\`listDomains()\` and \`getDomain(name)\` explain what each domain is for before
you filter by domain.
\`capabilities\` is the low-level source-of-truth map for arbitrary JavaScript
queries that are not covered by the helper parameters.
Use the domain descriptions to pick the right domain first when the task could
fit multiple areas.
Use \`detail: true\` or \`getCapability(name)\` when you need richer metadata or
full schemas. When a schema is present, the corresponding \`inputFields\` or
\`outputFields\` list is omitted to avoid repeating the same information.

Examples:

\`async () =>
  findCapabilities({ domain: 'math', keyword: 'arithmetic' })\`

\`async () =>
  findCapabilities({ domain: 'math', inputField: 'operator' })\`

\`async () => listDomains()\`

\`async () => getDomain('coding')\`

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
			const startedAt = performance.now()
			const { baseUrl, hasUser } = callerContextFields(agent.getCallerContext())
			const executor = createSearchExecutor(
				agent.getEnv(),
				capabilitySpecs,
				capabilityDomainDescriptionsByName,
			)
			const result = await Sentry.startSpan(
				{
					name: 'mcp.tool.search',
					op: 'mcp.tool',
					attributes: {
						'mcp.tool': 'search',
					},
				},
				async () => executor.execute(wrapSearchCode(code), {}),
			)
			const durationMs = Math.round(performance.now() - startedAt)

			if (result.error) {
				const { errorName, errorMessage } = errorFields(result.error)
				logMcpEvent({
					category: 'mcp',
					tool: 'search',
					toolName: 'search',
					outcome: 'failure',
					durationMs,
					baseUrl,
					hasUser,
					sandboxError: true,
					errorName,
					errorMessage,
					cause: result.error,
				})
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

			logMcpEvent({
				category: 'mcp',
				tool: 'search',
				toolName: 'search',
				outcome: 'success',
				durationMs,
				baseUrl,
				hasUser,
			})

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
