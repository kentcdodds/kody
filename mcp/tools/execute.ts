import * as Sentry from '@sentry/cloudflare'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { capabilityHandlers } from '#mcp/capabilities/registry.ts'
import {
	createExecuteExecutor,
	formatExecutionOutput,
	wrapExecuteCode,
} from '#mcp/executor.ts'
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
the capability's \`outputSchema\` from \`search\` detail mode or
\`getCapability(name)\`.

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
			const executor = createExecuteExecutor(env)
			const callerContext = agent.getCallerContext()
			const { baseUrl, hasUser } = callerContextFields(callerContext)
			const registeredCapabilityCount = Object.keys(capabilityHandlers).length
			const fns = Object.fromEntries(
				Object.entries(capabilityHandlers).map(([name, handler]) => [
					name,
					(args: unknown) =>
						handler((args ?? {}) as Record<string, unknown>, {
							env,
							callerContext,
						}),
				]),
			)
			const result = await Sentry.startSpan(
				{
					name: 'mcp.tool.execute',
					op: 'mcp.tool',
					attributes: {
						'mcp.tool': 'execute',
					},
				},
				async () => executor.execute(wrapExecuteCode(code), fns),
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
