import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { type createIslandRouterAdapter } from '../adapters/island-router/index.ts'
import {
	islandRouterReadCommandStrings,
	islandRouterWriteOperationStrings,
	type IslandRouterReadCommand,
	type IslandRouterWriteOperation,
} from '../adapters/island-router/types.ts'
import {
	buildToolInputSchema,
	type ToolInputSchema,
} from './tool-input-schema.ts'

type IslandRouterToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	annotations?: Record<string, unknown>
}

type IslandRouterRegisteredToolDescriptor = IslandRouterToolDescriptor & {
	sdkInputSchema?: ToolInputSchema
}

type IslandRouterToolHandler = (
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

const routerWriteDangerNotice =
	'HIGH RISK: this mutates a live router. Use it only when you are highly certain it is necessary and correct because mistakes can disrupt connectivity, destroy diagnostics, or persist a bad state with severe consequences.'

export function registerIslandRouterHomeConnectorTools(input: {
	registerTool: (
		descriptor: IslandRouterRegisteredToolDescriptor,
		handler: IslandRouterToolHandler,
	) => void
	islandRouter: ReturnType<typeof createIslandRouterAdapter>
}) {
	const { registerTool, islandRouter } = input

	registerTool(
		{
			name: 'router_get_status',
			title: 'Get Island Router Status',
			description:
				'Read-only Island router connectivity/status snapshot including configuration readiness, version, interface summaries, and the current IP neighbor cache.',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			const status = await islandRouter.getStatus()
			const interfaceCount = status.interfaces.length
			const neighborCount = status.neighbors.length
			return structuredTextResult(
				status.config.configured
					? `Island router status loaded with ${interfaceCount} interface(s) and ${neighborCount} neighbor entry/entries.`
					: `Island router diagnostics are not fully configured: ${status.config.missingFields.join(', ')}.`,
				status,
			)
		},
	)

	const readCommandSchema = buildToolInputSchema({
		command: z
			.enum(islandRouterReadCommandStrings)
			.describe(
				'Exact documented Island CLI command string from the allowlisted catalog. Use show interface <iface> or show ip interface <iface> for interface-scoped reads.',
			),
		interfaceName: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Required only when command is show interface <iface> or show ip interface <iface>.',
			),
		query: z
			.string()
			.min(1)
			.optional()
			.describe('Optional Kody-side substring filter for show log output.'),
		limit: z
			.number()
			.int()
			.min(1)
			.max(10_000)
			.optional()
			.describe('Optional Kody-side maximum line count for show log output.'),
		timeoutMs: z
			.number()
			.int()
			.min(1000)
			.max(60_000)
			.optional()
			.describe('Optional command timeout in milliseconds.'),
	})

	registerTool(
		{
			name: 'router_run_read_command',
			title: 'Run Island Router Read Command',
			description:
				'Run one exact read-only Island CLI command from the typed allowlist. This is the command substrate for router packages; it does not accept arbitrary CLI text or hyphenated aliases.',
			inputSchema: readCommandSchema.inputSchema,
			sdkInputSchema: readCommandSchema.sdkInputSchema,
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args) => {
			const result = await islandRouter.runReadCommand({
				command: args['command'] as IslandRouterReadCommand,
				interfaceName:
					args['interfaceName'] == null
						? undefined
						: String(args['interfaceName']),
				query: args['query'] == null ? undefined : String(args['query']),
				limit: args['limit'] == null ? undefined : Number(args['limit']),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				`Ran read-only Island router command ${result.command}.`,
				result,
			)
		},
	)

	const writeOperationSchema = buildToolInputSchema({
		operation: z
			.enum(islandRouterWriteOperationStrings)
			.describe(
				'Explicit high-risk router operation entry. Each operation maps to one documented allowlisted Island CLI command sequence and includes catalog blast-radius metadata in the result.',
			),
		ipAddress: z
			.string()
			.optional()
			.describe(
				'Required only for reserve dhcp address and remove dhcp reservation. Must be a valid IPv4 address; it does not need to be inside DHCP scope.',
			),
		macAddress: z
			.string()
			.optional()
			.describe(
				'Required only for reserve dhcp address and remove dhcp reservation. Must be a 48-bit colon- or hyphen-separated MAC address and is normalized before command construction.',
			),
		acknowledgeHighRisk: z
			.literal(true)
			.describe(
				'Must be true. Set this only when you are highly certain the requested router mutation is necessary and correct. DHCP reservation changes can affect address assignment and future connectivity for a device.',
			),
		reason: z
			.string()
			.min(20)
			.max(500)
			.describe(
				'Short operator justification. Be specific about why this mutation is necessary right now.',
			),
		confirmation: z
			.literal(islandRouter.writeAcknowledgements.runWriteOperation)
			.describe(
				'Exact confirmation phrase required by the tool. The tool rejects any other value.',
			),
		timeoutMs: z
			.number()
			.int()
			.min(1000)
			.max(60_000)
			.optional()
			.describe('Optional command timeout in milliseconds.'),
	})

	registerTool(
		{
			name: 'router_run_write_operation',
			title: 'Run Guarded Island Router Write Operation',
			description: `${routerWriteDangerNotice} This accepts only explicit typed operation entries (${islandRouterWriteOperationStrings.join(', ')}), never arbitrary CLI text. DHCP reservation operations require ipAddress and macAddress, validate those tokens before building CLI commands, and do not automatically save running config; separately run save running config if persistence is desired. Review the returned catalog entry for the command and blast radius.`,
			inputSchema: writeOperationSchema.inputSchema,
			sdkInputSchema: writeOperationSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const operation = args['operation'] as IslandRouterWriteOperation
			const requestBase = {
				acknowledgeHighRisk: args['acknowledgeHighRisk'] === true,
				reason: String(args['reason'] ?? ''),
				confirmation: String(args['confirmation'] ?? ''),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			}
			const result = await islandRouter.runWriteOperation({
				...requestBase,
				operation,
				...(operation === 'reserve dhcp address' ||
				operation === 'remove dhcp reservation'
					? {
							ipAddress: String(args['ipAddress'] ?? ''),
							macAddress: String(args['macAddress'] ?? ''),
						}
					: {}),
			})
			return structuredTextResult(
				`Ran guarded Island router write operation ${result.catalogEntry.operation}.`,
				result,
			)
		},
	)
}
