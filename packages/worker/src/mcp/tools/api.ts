import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { resolveCallerFeatureFlags } from '#mcp/capabilities/access-control.ts'
import {
	defaultExecutionResponseLimitBytes,
	formatLimitedExecutionOutput,
	limitExecutionResultValue,
} from '#mcp/executor.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import { callerContextFields, logMcpEvent } from '#mcp/observability.ts'
import { mcpApiToolFlagKey } from '#universal/feature-flags/registry.ts'
import { createApiInvocationContext } from '#worker/open-api/context.ts'
import { ApiError, toApiError } from '#worker/open-api/errors.ts'
import { invokeApiOperation } from '#worker/open-api/invoke.ts'
import { buildKodyToolIcons } from './tool-icons.ts'
import { finishToolTiming, startToolTiming } from './tool-timing.ts'

export const apiToolDescription = [
	'Call one Kody API operation directly: no sandbox, no execute quota. Same operations as the HTTP API at https://api.kody.codes/openapi.json.',
	'',
	'- `operationId`: a Kody capability name from `search` (e.g. `packageList`, `secretSet`, `jobRunNow`) or a token operation (`tokenCreate`, `tokenList`, `tokenGet`, `tokenRotate`, `tokenRevoke`).',
	'- `params`: the operation input as one flat object (the same fields `search` shows for the capability; HTTP path, query, and body fields together).',
	'',
	'Use `execute` instead when you need to compose several calls, transform results, or fetch external URLs.',
	'',
	'Local execute / Kody CLI: mint a short-lived scoped token with `{ "operationId": "tokenCreate", "params": { "name": "kody-cli", "scopes": ["local-execute", "packages:read"] } }`. The result includes the token value once; pass it to the CLI via `--token` or the `KODY_API_TOKEN` environment variable and do not repeat it in chat. Tokens slide their expiry on use (default 15 minutes idle) and can be revoked with `tokenRevoke`.',
].join('\n')

export const apiToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: true,
} satisfies ToolAnnotations

export const apiToolOutputSchema = {
	operationId: z.string().describe('The operation that ran.'),
	result: z
		.unknown()
		.optional()
		.describe('Operation result (JSON) when the call succeeded.'),
	error: z
		.object({
			code: z.string(),
			message: z.string(),
			details: z.unknown().optional(),
		})
		.optional()
		.describe('Error envelope when the call failed (isError is set).'),
	truncated: z
		.boolean()
		.optional()
		.describe('True when the result was truncated to fit the response limit.'),
	note: z.string().optional().describe('Explains a truncated result.'),
}

function apiToolUnavailableError() {
	return new ApiError({
		status: 404,
		code: 'feature_unavailable',
		message:
			'The api tool is not enabled for this account. Use search and execute instead.',
		details: { feature_flag: mcpApiToolFlagKey },
	})
}

/**
 * Register the MCP `api` tool when the caller has `mcp-api-tool`. The flag
 * is re-checked on every call so a flag turned off mid-session stops the tool
 * even on long-lived sessions that registered it earlier.
 */
export async function registerApiTool(agent: McpRegistrationAgent) {
	const env = agent.getEnv()
	const featureFlags = await resolveCallerFeatureFlags(
		env,
		agent.getCallerContext(),
	)
	if (featureFlags[mcpApiToolFlagKey] !== true) return
	const icons = buildKodyToolIcons(agent.getCallerContext().baseUrl)
	agent.server.registerTool(
		'api',
		{
			title: 'Kody API',
			description: apiToolDescription,
			inputSchema: {
				operationId: z
					.string()
					.min(1)
					.describe(
						'Operation id: a Kody capability name or a token operation such as tokenCreate.',
					),
				params: z
					.record(z.string(), z.unknown())
					.optional()
					.describe('Operation input as one flat JSON object.'),
			},
			outputSchema: apiToolOutputSchema,
			annotations: apiToolAnnotations,
			...(icons ? { icons } : {}),
		},
		async ({
			operationId,
			params,
		}: {
			operationId: string
			params?: Record<string, unknown>
		}) => {
			const timingStart = startToolTiming()
			const callerContext = agent.getCallerContext()
			const fields = callerContextFields(callerContext)
			const logFields = {
				category: 'mcp' as const,
				tool: 'api' as const,
				toolName: 'api',
				capabilityName: operationId,
				baseUrl: fields.baseUrl,
				hasUser: fields.hasUser,
				...(fields.userId ? { userId: fields.userId } : {}),
			}
			try {
				const user = callerContext.user
				if (!user) {
					throw new ApiError({
						status: 401,
						code: 'unauthorized',
						message: 'The api tool requires a signed-in Kody user.',
					})
				}
				const flags = await resolveCallerFeatureFlags(env, callerContext)
				if (flags[mcpApiToolFlagKey] !== true) throw apiToolUnavailableError()
				const result = await invokeApiOperation({
					operationId,
					params: params ?? {},
					ctx: createApiInvocationContext({
						env,
						callerContext: { ...callerContext, user },
						principal: { kind: 'mcp' },
						...(agent.waitUntil
							? { waitUntil: agent.waitUntil.bind(agent) }
							: {}),
					}),
				})
				const limited = limitExecutionResultValue(
					result ?? null,
					defaultExecutionResponseLimitBytes,
				)
				logMcpEvent({
					...logFields,
					outcome: 'success',
					durationMs: finishToolTiming(timingStart).durationMs,
				})
				return {
					content: [
						{
							type: 'text' as const,
							text: formatLimitedExecutionOutput(limited),
						},
					],
					structuredContent: {
						operationId,
						result: limited.value,
						...(limited.truncated
							? { truncated: true, note: limited.note }
							: {}),
					},
				}
			} catch (error) {
				const apiError = toApiError(error)
				logMcpEvent({
					...logFields,
					outcome: 'failure',
					durationMs: finishToolTiming(timingStart).durationMs,
					failurePhase: 'handler',
					errorName: apiError.code,
					errorMessage: apiError.message,
					callerError: apiError.status < 500,
					cause: error,
				})
				const body = apiError.toBody()
				return {
					isError: true,
					content: [
						{
							type: 'text' as const,
							text: `Error (${body.error.code}): ${body.error.message}${
								body.error.details === undefined
									? ''
									: `\n\n${JSON.stringify(body.error.details, null, 2)}`
							}`,
						},
					],
					structuredContent: { operationId, error: body.error },
				}
			}
		},
	)
}
