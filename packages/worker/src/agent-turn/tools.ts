import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	loadDownRemoteConnectorStatuses,
	loadOptionalSearchRows,
	resolveSearchMemoryContext,
	searchPackages,
} from '#mcp/tools/search.ts'
import { loadRelevantMemoriesForTool } from '#mcp/tools/memory-tool-context.ts'
import { toSlimStructuredMatches } from '#mcp/tools/search-format.ts'
import {
	listUserSecretsForSearch,
} from '#mcp/secrets/service.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { listValues } from '#mcp/values/service.ts'
import { runCodemodeWithRegistry } from '#mcp/run-codemode-registry.ts'

const defaultSearchLimit = 15
const defaultMaxResponseSize = 4_000

function truncateText(text: string, maxChars = defaultMaxResponseSize) {
	if (text.length <= maxChars) return text
	return `${text.slice(0, maxChars)}\n\n[truncated]`
}

export async function createAgentTurnToolSet(input: {
	env: Env
	callerContext: McpCallerContext
	conversationId: string
	memoryContext?: {
		task?: string
		query?: string
		entities?: Array<string>
		constraints?: Array<string>
	} | null
}): Promise<ToolSet> {
	return {
		search: tool({
			description:
				'Search Kody capabilities, saved packages, values, connectors, and secret references using a natural language query.',
			inputSchema: z.object({
				query: z.string().min(1),
				limit: z.number().int().min(1).max(50).optional(),
			}),
			execute: async (args) => {
				const userId = input.callerContext.user?.userId ?? null
				const optionalRows = await loadOptionalSearchRows({
					userId,
					loadPackages: async () => {
						const savedPackages = await listSavedPackagesByUserId(
							input.env.APP_DB,
							{ userId: userId! },
						)
						return savedPackages.map((savedPackage) => ({
							record: savedPackage,
							projection: {
								name: savedPackage.name,
								kodyId: savedPackage.kodyId,
								description: savedPackage.description,
								tags: savedPackage.tags,
								searchText: savedPackage.searchText,
								hasApp: savedPackage.hasApp,
								exports: [],
								jobs: [],
							},
						}))
					},
					loadUserSecrets: () =>
						listUserSecretsForSearch({
							env: input.env,
							userId: userId!,
						}),
					loadUserValues: () =>
						listValues({
							env: input.env,
							userId: userId!,
							storageContext: {
								sessionId:
									input.callerContext.storageContext?.sessionId ?? null,
								appId: input.callerContext.storageContext?.appId ?? null,
							},
						}),
				})
				const result = await searchPackages({
					env: input.env,
					baseUrl: input.callerContext.baseUrl,
					query: args.query,
					limit: args.limit ?? defaultSearchLimit,
					rows: optionalRows.packageRows,
				})
				const remoteConnectorStatuses = await loadDownRemoteConnectorStatuses({
					env: input.env,
					callerContext: input.callerContext,
				})
				const memoryToolContext = await loadRelevantMemoriesForTool({
					env: input.env,
					callerContext: input.callerContext,
					conversationId: input.conversationId,
					memoryContext: resolveSearchMemoryContext({
						query: args.query,
						memoryContext: input.memoryContext ?? undefined,
					}),
				})
				return {
					offline: result.offline,
					warnings: optionalRows.warnings,
					memories: memoryToolContext
						? {
								surfaced: memoryToolContext.memories,
								suppressedCount: memoryToolContext.suppressedCount,
								retrievalQuery: memoryToolContext.retrievalQuery,
							}
						: undefined,
					remoteConnectorStatuses: remoteConnectorStatuses.map((status) => ({
						connectorKind: status.connectorKind,
						connectorId: status.connectorId ?? 'unknown',
						state: status.state,
						connected: status.connected,
						toolCount: status.toolCount,
					})),
					matches: toSlimStructuredMatches({
						matches: result.matches,
						baseUrl: input.callerContext.baseUrl,
					}),
				}
			},
		}),
		execute: tool({
			description:
				'Run a short async JavaScript function against Kody capabilities via the execute runtime.',
			inputSchema: z.object({
				code: z.string().min(1),
				params: z.record(z.string(), z.unknown()).optional(),
			}),
			execute: async (args) => {
				const result = await runCodemodeWithRegistry(
					input.env,
					input.callerContext,
					args.code,
					args.params,
				)
				if (result.error) {
					throw result.error
				}
				const raw =
					typeof result.result === 'string'
						? result.result
						: JSON.stringify(result.result, null, 2)
				return {
					result: result.result,
					logs: result.logs ?? [],
					preview: truncateText(raw ?? ''),
				}
			},
		}),
	} satisfies ToolSet
}
