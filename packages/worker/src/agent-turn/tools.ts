import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import {
	buildSavedPackageSearchRows,
	loadDownRemoteConnectorStatuses,
	loadOptionalSearchRows,
	resolveSearchMemoryContext,
	searchUnified,
} from '#mcp/tools/search.ts'
import { loadRelevantMemoriesForTool } from '#mcp/tools/memory-tool-context.ts'
import { toSlimStructuredMatches } from '#mcp/tools/search-format.ts'
import { listUserSecretsForSearch } from '#mcp/secrets/service.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { listValues } from '#mcp/values/service.ts'
import { runModuleWithRegistry } from '#mcp/run-codemode-registry.ts'

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
				const [registry, optionalRows] = await Promise.all([
					getCapabilityRegistryForContext({
						env: input.env,
						callerContext: input.callerContext,
					}),
					loadOptionalSearchRows({
						userId,
						loadPackages: async () => {
							const savedPackages = await listSavedPackagesByUserId(
								input.env.APP_DB,
								{ userId: userId! },
							)
							const packageRows = await buildSavedPackageSearchRows({
								env: input.env,
								baseUrl: input.callerContext.baseUrl,
								userId: userId!,
								records: savedPackages,
							})
							return packageRows
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
					}),
				])
				const { runPackageRetrievers } =
					await import('#worker/package-retrievers/service.ts')
				const retrieverSearch = await runPackageRetrievers({
					env: input.env,
					baseUrl: input.callerContext.baseUrl,
					userId,
					scope: 'search',
					query: args.query,
					memoryContext: resolveSearchMemoryContext({
						query: args.query,
						memoryContext: input.memoryContext ?? undefined,
					}),
					conversationId: input.conversationId,
				})
				const result = await searchUnified({
					env: input.env,
					query: args.query,
					limit: args.limit ?? defaultSearchLimit,
					registry,
					optionalRows,
					retrieverResults: retrieverSearch.results,
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
					warnings: [...optionalRows.warnings, ...retrieverSearch.warnings],
					guidance: result.guidance,
					memories: memoryToolContext
						? {
								surfaced: memoryToolContext.memories,
								suppressedCount: memoryToolContext.suppressedCount,
								retrievalQuery: memoryToolContext.retrievalQuery,
								retrieverResults: memoryToolContext.retrieverResults,
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
					retrieverResults: retrieverSearch.results,
				}
			},
		}),
		execute: tool({
			description:
				'Run a short JavaScript module via the execute runtime; the module should default export the function to run.',
			inputSchema: z.object({
				code: z.string().min(1),
				params: z.record(z.string(), z.unknown()).optional(),
			}),
			execute: async (args) => {
				const result = await runModuleWithRegistry(
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
