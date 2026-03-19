import * as Sentry from '@sentry/cloudflare'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { formatExecutionOutput } from '#mcp/executor.ts'
import { runCodemodeWithRegistry } from '#mcp/run-codemode-registry.ts'
import { type MCP } from '#mcp/index.ts'
import {
	callerContextFields,
	errorFields,
	logMcpEvent,
} from '#mcp/observability.ts'

const executeTool = {
	name: 'execute',
	title: 'Execute Capabilities',
	description: `
Execute JavaScript code against Kody capabilities. First use \`search\` to find
the right capability, then call it through \`codemode\`.

Available in your code:

type CapabilityArgs = Record<string, unknown>;
type CapabilityResult = unknown;

declare const codemode: Record<
  string,
  (args: CapabilityArgs) => Promise<CapabilityResult>
>;

Capability names are discovered via \`search\`.
Each method accepts one args object matching that capability's \`inputSchema\`
and returns structured data described by its \`outputSchema\` when present.
Each capability call resolves to the raw returned value itself, not an MCP
wrapper object. When chaining calls, read fields from the previous result using
the capability's \`outputSchema\` from \`search\` with \`detail: true\`.

Your code must be an async arrow function that returns the result.

Examples:

\`async () => {
  const math = 'do_math';
  const first = await codemode[math]({ left: 3, operator: '*', right: 8 });
  const second = await codemode[math]({
    left: first.result,
    operator: '/',
    right: 20,
  });
  return await codemode[math]({ left: second.result, operator: '+', right: 8 });
}\`
	`.trim(),
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	} satisfies ToolAnnotations,
} as const

export async function registerExecuteTool(agent: MCP) {
	agent.server.registerTool(
		executeTool.name,
		{
			title: executeTool.title,
			description: executeTool.description,
			inputSchema: {
				code: z
					.string()
					.describe('JavaScript async arrow function to execute capabilities.'),
			},
			annotations: executeTool.annotations,
		},
		async ({ code }: { code: string }) => {
			const startedAt = performance.now()
			const env = agent.getEnv()
			const callerContext = agent.getCallerContext()
			const { baseUrl, hasUser } = callerContextFields(callerContext)
			const { capabilityHandlers } =
				await import('#mcp/capabilities/registry.ts')
			const registeredCapabilityCount = Object.keys(capabilityHandlers).length
			const result = await Sentry.startSpan(
				{
					name: 'mcp.tool.execute',
					op: 'mcp.tool',
					attributes: {
						'mcp.tool': 'execute',
					},
				},
				async () => runCodemodeWithRegistry(env, callerContext, code),
			)
			const durationMs = Math.round(performance.now() - startedAt)

			if (result.error) {
				const { errorName, errorMessage } = errorFields(result.error)
				logMcpEvent({
					category: 'mcp',
					tool: 'execute',
					toolName: 'execute',
					outcome: 'failure',
					durationMs,
					baseUrl,
					hasUser,
					registeredCapabilityCount,
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
				tool: 'execute',
				toolName: 'execute',
				outcome: 'success',
				durationMs,
				baseUrl,
				hasUser,
				registeredCapabilityCount,
			})

			const saveSkillHint =
				'\n\nIf this codemode represents a reasonably repeatable workflow (not a one-off), you can persist it with `meta_save_skill` (meta domain); use `meta_update_skill` to replace code for an existing saved skill.'
			return {
				content: [
					{
						type: 'text',
						text: `${formatExecutionOutput(result)}${saveSkillHint}`,
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
