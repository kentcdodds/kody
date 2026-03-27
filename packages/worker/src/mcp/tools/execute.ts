import * as Sentry from '@sentry/cloudflare'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
	formatExecutionOutput,
	getExecutionErrorDetails,
} from '#mcp/executor.ts'
import { runCodemodeWithRegistry } from '#mcp/run-codemode-registry.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
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

To run a saved skill by id, prefer \`meta_run_skill\` with \`skill_id\` and
optional \`params\`. If you need the saved code, call \`meta_get_skill\` and
pass the returned code into this tool.

This tool accepts a single argument: \`{ "code": "async () => { ... }" }\`.

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

Network access:
- Regular \`fetch(...)\` is available inside the sandbox and is routed through a host-side gateway.
- To inject a saved secret into a request, use a placeholder string such as \`{{secret:cloudflareToken}}\` or \`{{secret:cloudflareToken|scope=user}}\` in the URL, headers, or request body.
- Secret placeholders only work for hosts that the user has already approved for that secret.
- If a request is blocked because the host is not approved, do not retry blindly. Ask the user whether they want to approve that host, then provide the approval link from the error message.
- Saving or updating a secret does not authorize outbound use automatically. Host approval happens separately in the app.

Secrets:
- Use \`await codemode.secret_list({})\` to inspect available secret metadata before building a request. The result is metadata only and does not reveal secret values.
- Pass \`scope\` to narrow results, for example \`await codemode.secret_list({ scope: 'app' })\`.
- Do not expect \`codemode.secret_get(...)\`, \`codemode.secret_require(...)\`, or any injected \`secrets\` helper to be available in execute-time code.

Your code must be an async arrow function that returns the result.

Examples:

\`async () => {
  const docs = await codemode.github_rest_api_docs({
    path: '/en/rest/repos/repos',
  });
  return {
    status: docs.status,
    preview: docs.body.slice(0, 120),
  };
}\`
	`.trim(),
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	} satisfies ToolAnnotations,
} as const

export async function registerExecuteTool(agent: McpRegistrationAgent) {
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
			const { getCapabilityRegistryForContext } =
				await import('#mcp/capabilities/registry.ts')
			const registry = await getCapabilityRegistryForContext({
				env,
				callerContext,
			})
			const registeredCapabilityCount = Object.keys(
				registry.capabilityHandlers,
			).length
			const result = await Sentry.startSpan(
				{
					name: 'mcp.tool.execute',
					op: 'mcp.tool',
					attributes: {
						'mcp.tool': 'execute',
					},
				},
				async () =>
					runCodemodeWithRegistry(
						env,
						callerContext,
						code,
						undefined,
						agent.getLoopbackExports(),
					),
			)
			const durationMs = Math.round(performance.now() - startedAt)

			if (result.error) {
				const errorDetails = getExecutionErrorDetails(result.error)
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
						errorDetails,
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
