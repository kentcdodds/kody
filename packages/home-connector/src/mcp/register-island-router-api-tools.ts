import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { markSecretInputFields } from '@kody-internal/shared/secret-input-schema.ts'
import { z } from 'zod'
import {
	islandRouterApiWriteConfirmation,
	type createIslandRouterApiAdapter,
	validateIslandRouterApiPath,
} from '../adapters/island-router-api/index.ts'
import {
	buildToolInputSchema,
	type ToolInputSchema,
} from './tool-input-schema.ts'

type IslandRouterApiToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	annotations?: Record<string, unknown>
}

type IslandRouterApiRegisteredToolDescriptor = IslandRouterApiToolDescriptor & {
	sdkInputSchema?: ToolInputSchema
}

type IslandRouterApiToolHandler = (
	args: Record<string, unknown>,
) => Promise<CallToolResult>

function structuredTextResult(
	text: string,
	structuredContent: unknown,
): CallToolResult {
	return {
		content: [
			{
				type: 'text',
				text,
			},
		],
		structuredContent,
	}
}

function structuredErrorResult(
	code: string,
	message: string,
	structuredContent: Record<string, unknown> = {},
): CallToolResult {
	return {
		isError: true,
		content: [
			{
				type: 'text',
				text: message,
			},
		],
		structuredContent: {
			error: {
				code,
				message,
				...structuredContent,
			},
		},
	}
}

const requestDangerNotice =
	'HIGH RISK: non-GET requests issue authenticated raw HTTP requests against the live Island Router API. Use them only when you are highly certain the request is necessary and correct because mistakes can disrupt local connectivity or change router policy.'

export function registerIslandRouterApiHomeConnectorTools(input: {
	registerTool: (
		descriptor: IslandRouterApiRegisteredToolDescriptor,
		handler: IslandRouterApiToolHandler,
	) => void
	islandRouterApi: ReturnType<typeof createIslandRouterApiAdapter>
}) {
	const { registerTool, islandRouterApi } = input

	registerTool(
		{
			name: 'island_router_api_get_status',
			title: 'Get Island Router API Proxy Status',
			description:
				'Read-only status for the Island Router HTTP API proxy, including whether a PIN is stored locally and the target base URL.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const status = islandRouterApi.getStatus()
			return structuredTextResult(
				status.configured
					? 'Island Router API proxy is configured.'
					: 'Island Router API proxy is not configured. Store a PIN and ensure HOME_CONNECTOR_SHARED_SECRET is set.',
				status,
			)
		},
	)

	const pinSchema = buildToolInputSchema({
		pin: z.string().min(1).describe('Island Router PIN to store locally.'),
	})

	registerTool(
		{
			name: 'island_router_api_set_pin',
			title: 'Set Island Router API PIN',
			description:
				'Store the Island Router PIN locally in the home connector SQLite database, encrypted with HOME_CONNECTOR_SHARED_SECRET.',
			inputSchema: markSecretInputFields(pinSchema.inputSchema, [
				'pin',
			]) as Record<string, unknown>,
			sdkInputSchema: pinSchema.sdkInputSchema,
		},
		async (args) => {
			const status = islandRouterApi.setPin(String(args['pin'] ?? ''))
			return structuredTextResult('Stored Island Router API PIN.', status)
		},
	)

	registerTool(
		{
			name: 'island_router_api_clear_pin',
			title: 'Clear Island Router API PIN',
			description:
				'Delete the locally stored Island Router PIN and clear in-memory API tokens.',
			inputSchema: {},
		},
		async () => {
			const status = islandRouterApi.clearPin()
			return structuredTextResult('Cleared Island Router API PIN.', status)
		},
	)

	const requestSchema = buildToolInputSchema({
		method: z
			.enum(['GET', 'POST', 'PUT', 'DELETE'])
			.describe('HTTP method. Non-GET requests require high-risk fields.'),
		path: z
			.string()
			.min(1)
			.regex(/^\/api\//, 'path must begin with /api/.')
			.describe('Island Router API path. Must begin with /api/.'),
		query: z
			.record(z.string(), z.unknown())
			.optional()
			.describe('Optional query string parameters.'),
		body: z.unknown().optional().describe('Optional JSON request body.'),
		timeoutMs: z
			.number()
			.int()
			.min(1000)
			.max(60_000)
			.optional()
			.describe('Optional request timeout in milliseconds.'),
		acknowledgeHighRisk: z
			.boolean()
			.optional()
			.describe('Required as true for non-GET requests.'),
		reason: z
			.string()
			.min(20)
			.max(500)
			.optional()
			.describe('Required for non-GET requests.'),
		confirmation: z
			.literal(islandRouterApiWriteConfirmation)
			.optional()
			.describe('Required exact confirmation phrase for non-GET requests.'),
	})

	registerTool(
		{
			name: 'island_router_api_request',
			title: 'Proxy Island Router API Request',
			description: `${requestDangerNotice}

Proxies an authenticated JSON HTTP request from the home connector host to my.islandrouter.com or the configured ISLAND_ROUTER_API_BASE_URL. The connector authenticates with the locally stored PIN, refreshes tokens on a 401, and retries once. Paths are constrained to /api/.`,
			inputSchema: requestSchema.inputSchema,
			sdkInputSchema: requestSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const path = String(args['path'] ?? '')
			try {
				validateIslandRouterApiPath(path)
			} catch (error) {
				return structuredErrorResult(
					'island_router_api_invalid_path',
					error instanceof Error ? error.message : String(error),
				)
			}
			const result = await islandRouterApi.request({
				method: args['method'] as 'GET' | 'POST' | 'PUT' | 'DELETE',
				path,
				query:
					args['query'] && typeof args['query'] === 'object'
						? (args['query'] as Record<string, unknown>)
						: undefined,
				body: args['body'],
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: args['reason'] == null ? undefined : String(args['reason']),
				confirmation:
					args['confirmation'] == null
						? undefined
						: String(args['confirmation']),
			})
			return structuredTextResult(
				`Island Router API ${result.method} ${result.path} returned HTTP ${String(result.status)}.`,
				result,
			)
		},
	)
}
