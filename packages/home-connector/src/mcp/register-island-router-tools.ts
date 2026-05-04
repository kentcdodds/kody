import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { type createIslandRouterAdapter } from '../adapters/island-router/index.ts'
import {
	islandRouterCommandCatalog,
	islandRouterCommandIds,
	type IslandRouterCommandId,
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

const routerCommandDangerNotice =
	'Write-risk catalog entries mutate a live router. Use them only when you are highly certain the command id, parameters, and blast-radius guidance are correct because mistakes can disrupt connectivity, destroy diagnostics, or persist a bad state with severe consequences.'

const commandCatalogDescription = islandRouterCommandCatalog
	.map((entry) => {
		const params =
			entry.params.length === 0
				? 'no params'
				: entry.params.map((param) => param.name).join(', ')
		const persistence = entry.persistence.requiresWriteMemory
			? '; persistence requires separate write memory command'
			: ''
		return `- ${entry.id}: ${entry.access}, risk=${entry.riskLevel}, context=${entry.context.mode}, params=${params}${persistence}`
	})
	.join('\n')

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

	const commandSchema = buildToolInputSchema({
		commandId: z
			.enum(islandRouterCommandIds)
			.describe(
				'Documented Island CLI command id/template from the allowlisted catalog. This field is not arbitrary CLI text.',
			),
		params: z
			.record(z.string(), z.unknown())
			.optional()
			.describe(
				'Structured params required by the selected catalog entry. Values are validated and rendered as single CLI tokens or controlled quoted text.',
			),
		query: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional Kody-side substring filter for catalog entries that support line filtering, such as show log and show syslog.',
			),
		limit: z
			.number()
			.int()
			.min(1)
			.max(10_000)
			.optional()
			.describe(
				'Optional Kody-side maximum line count for catalog entries that support line filtering.',
			),
		reason: z
			.string()
			.min(20)
			.max(500)
			.optional()
			.describe(
				'Required for write-risk command ids. Be specific about why this router mutation is necessary right now.',
			),
		confirmation: z
			.literal(islandRouter.writeConfirmation)
			.optional()
			.describe(
				'Required for write-risk command ids. Must exactly match the connector-provided confirmation phrase.',
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
			name: 'router_run_command',
			title: 'Run Island Router Catalog Command',
			description: `${routerCommandDangerNotice}

Runs one command from the typed Island router command catalog. It never accepts arbitrary CLI text. Each entry defines the exact CLI template, read/write access, risk level, required params and validators, CLI context, no/remove variant, persistence metadata, blast-radius guidance, and docs URL.

No silent save: commands that change running config do not automatically run write memory. If persistence is required, run the separate write memory catalog command explicitly after reviewing the returned metadata.

Catalog:
${commandCatalogDescription}`,
			inputSchema: commandSchema.inputSchema,
			sdkInputSchema: commandSchema.sdkInputSchema,
			annotations: {
				destructiveHint: true,
			},
		},
		async (args) => {
			const result = await islandRouter.runCommand({
				commandId: args['commandId'] as IslandRouterCommandId,
				params:
					args['params'] && typeof args['params'] === 'object'
						? (args['params'] as Record<string, unknown>)
						: undefined,
				query: args['query'] == null ? undefined : String(args['query']),
				limit: args['limit'] == null ? undefined : Number(args['limit']),
				reason: args['reason'] == null ? undefined : String(args['reason']),
				confirmation:
					args['confirmation'] == null
						? undefined
						: String(args['confirmation']),
				timeoutMs:
					args['timeoutMs'] == null ? undefined : Number(args['timeoutMs']),
			})
			return structuredTextResult(
				`Ran Island router catalog command ${result.commandId}.`,
				result,
			)
		},
	)
}
