import * as Sentry from '@sentry/cloudflare'
import { resolvePublicUsername } from '#app/user-lookup.ts'
import { isMcpCallerError } from '#mcp/caller-error.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import {
	callerContextFields,
	errorFields,
	logMcpEvent,
} from '#mcp/observability.ts'
import { type RemoteConnectorStatus } from '#worker/remote-connector/status.ts'

import {
	escapeMarkdownText,
	formatMarkdownInlineCode,
} from './markdown-safety.ts'
import {
	defaultMaxResponseSize,
	defaultSearchLimit,
	domainBrowseDefaultLimit,
	maxChars,
} from './search-constants.ts'
import { resolveEntityDetail } from './search-detail.ts'
import {
	executeSearchList,
	type SearchListExecutionResult,
} from './search-execution.ts'
import {
	formatEntityDetailMarkdown,
	formatSearchMarkdown,
	type SearchEntityDetailStructured,
	type SearchMatch,
	type SearchResultStructuredContent,
	toSlimStructuredMatches,
} from './search-format.ts'
import {
	loadDownRemoteConnectorStatuses,
	loadSearchRowsAndRegistry,
	serializeRemoteConnectorStatus,
} from './search-loaders.ts'
import {
	applyMaxResponseSize,
	truncateSearchText,
} from './search-response-size.ts'
import { elapsedMs } from './search-timing.ts'
import { type SearchPhaseTimings } from './search-types.ts'
import { type SearchToolArgs } from './search-tool-definition.ts'
import { resolveConversationId } from './tool-call-context.ts'
import { prependToolMetadataContent } from './tool-response-content.ts'
import { finishToolTiming, startToolTiming } from './tool-timing.ts'

export async function runSearchTool(input: {
	agent: McpRegistrationAgent
	args: SearchToolArgs
}) {
	const { agent, args } = input
	const timingStart = startToolTiming()
	const conversationId = resolveConversationId(args.conversationId)
	const callerContext = agent.getCallerContext()
	const {
		baseUrl,
		hasUser,
		userId: callerUserId,
	} = callerContextFields(callerContext)
	const userId = callerUserId ?? null
	const includeHiddenPackages = !!args.includeHiddenPackages
	const domainFilter = args.domain?.trim() || undefined
	// Whitespace-only queries stay valid (memory enrichment may still run) but
	// count as "no query" for the domain-browse limit default.
	const trimmedQuery = args.query?.trim() ?? ''
	if (!args.query && !args.entity && !domainFilter) {
		const timing = finishToolTiming(timingStart)
		logMcpEvent({
			category: 'mcp',
			tool: 'search',
			toolName: 'search',
			outcome: 'failure',
			durationMs: timing.durationMs,
			baseUrl,
			hasUser,
			userId: userId ?? undefined,
			sandboxError: false,
			callerError: true,
			errorName: 'ValidationError',
			errorMessage: 'Provide "query", "entity", or "domain".',
			message: 'Search request missing query, entity, and domain.',
			context: {
				failurePhase: 'validation_error',
			},
		})
		return {
			content: prependToolMetadataContent(conversationId, [
				{
					type: 'text',
					text: 'Error: Provide "query", "entity", or "domain".',
				},
			]),
			structuredContent: {
				conversationId,
				timing,
				error: 'Provide "query", "entity", or "domain".',
			},
			isError: true,
		}
	}
	// Domain browsing (domain without query) deliberately lists the whole
	// domain by default instead of cutting at the ranked default.
	const limit =
		args.limit ??
		(domainFilter && !trimmedQuery
			? domainBrowseDefaultLimit
			: defaultSearchLimit)
	const maxResponseSize = args.maxResponseSize ?? defaultMaxResponseSize
	let warnings: Array<string> = []
	let remoteConnectorDownStatuses: Array<RemoteConnectorStatus> = []
	let username: string | null = null
	const endToEndPhaseTimings: Partial<SearchPhaseTimings> = {}

	const searchSpan = async () => {
		const query = trimmedQuery
		if (!args.entity) {
			const execution = await executeSearchList({
				env: agent.getEnv(),
				callerContext,
				conversationId,
				query,
				memoryQuery: args.query,
				limit,
				userId,
				includeHiddenPackages,
				memoryContext: args.memoryContext,
				...(domainFilter ? { domain: domainFilter } : {}),
			})
			username = execution.username
			warnings = execution.warnings
			remoteConnectorDownStatuses = execution.remoteConnectorStatuses
			Object.assign(endToEndPhaseTimings, execution.phaseTimings)
			return {
				mode: 'list' as const,
				execution,
			}
		}
		username = await resolvePublicUsername({
			db: agent.getEnv().APP_DB,
			username: callerContext.user?.username ?? null,
			email: callerContext.user?.email ?? null,
		})
		const rowAndRegistryLoadStart = performance.now()
		const rowsPromise = loadSearchRowsAndRegistry({
			env: agent.getEnv(),
			callerContext,
			userId,
			includeHiddenPackages,
		}).then((rows) => {
			endToEndPhaseTimings.rowAndRegistryLoadMs = elapsedMs(
				rowAndRegistryLoadStart,
			)
			return rows
		})
		const [searchRows] = await Promise.all([rowsPromise])
		const remoteConnectorStatusStart = performance.now()
		remoteConnectorDownStatuses = await loadDownRemoteConnectorStatuses({
			env: agent.getEnv(),
			callerContext,
		})
		endToEndPhaseTimings.remoteConnectorStatusMs = elapsedMs(
			remoteConnectorStatusStart,
		)
		warnings = searchRows.warnings

		if (Array.isArray(args.entity)) {
			const batchResults = await Promise.all(
				args.entity.map(async (entityRef) => {
					try {
						const detail = await resolveEntityDetail({
							agent,
							callerContext,
							userId,
							username,
							entity: entityRef,
							searchRows,
						})
						return {
							ok: true as const,
							entityRef,
							detail,
						}
					} catch (cause) {
						const error =
							cause instanceof Error ? cause : new Error(String(cause))
						return {
							ok: false as const,
							entityRef,
							error: error.message,
							callerError: isMcpCallerError(cause),
						}
					}
				}),
			)
			return {
				mode: 'entity-batch' as const,
				results: batchResults,
			}
		}
		return {
			mode: 'entity' as const,
			detail: await resolveEntityDetail({
				agent,
				callerContext,
				userId,
				username,
				entity: args.entity,
				searchRows,
			}),
		}
	}

	try {
		const outcome:
			| {
					mode: 'list'
					execution: SearchListExecutionResult
			  }
			| {
					mode: 'entity'
					detail: Awaited<ReturnType<typeof resolveEntityDetail>>
			  }
			| {
					mode: 'entity-batch'
					results: Array<
						| {
								ok: true
								entityRef: string
								detail: Awaited<ReturnType<typeof resolveEntityDetail>>
						  }
						| {
								ok: false
								entityRef: string
								error: string
								callerError: boolean
						  }
					>
			  } = await Sentry.startSpan(
			{
				name: 'mcp.tool.search',
				op: 'mcp.tool',
				attributes: {
					'mcp.tool': 'search',
				},
			},
			searchSpan,
		)

		if (outcome.mode === 'entity') {
			const entityResult = formatEntityDetailMarkdown(outcome.detail)
			const timing = finishToolTiming(timingStart)
			logMcpEvent({
				category: 'mcp',
				tool: 'search',
				toolName: 'search',
				outcome: 'success',
				durationMs: timing.durationMs,
				baseUrl,
				hasUser,
				userId: userId ?? undefined,
			})
			return {
				content: prependToolMetadataContent(conversationId, [
					{
						type: 'text',
						text: truncateSearchText(entityResult.markdown),
					},
				]),
				structuredContent: {
					conversationId,
					timing,
					result: entityResult.structured,
				},
			}
		}

		if (outcome.mode === 'entity-batch') {
			const timing = finishToolTiming(timingStart)
			const structuredResults: Array<
				SearchEntityDetailStructured | { entityRef: string; error: string }
			> = []
			const markdownParts: Array<string> = []
			let successCount = 0
			for (const entry of outcome.results) {
				if (!entry.ok) {
					structuredResults.push({
						entityRef: entry.entityRef,
						error: entry.error,
					})
					markdownParts.push(
						`Error resolving ${formatMarkdownInlineCode(entry.entityRef)}: ${escapeMarkdownText(entry.error)}`,
					)
					continue
				}
				const entityResult = formatEntityDetailMarkdown(entry.detail)
				const candidateStructured = [
					...structuredResults,
					entityResult.structured,
				]
				const hasFullDetail = structuredResults.some(
					(result) => 'kind' in result && result.kind === 'entity',
				)
				if (
					hasFullDetail &&
					JSON.stringify(candidateStructured).length > maxChars
				) {
					const overflowError =
						'Omitted from batch response (exceeds size budget). Look up individually with search({ entity }).'
					structuredResults.push({
						entityRef: entry.entityRef,
						error: overflowError,
					})
					markdownParts.push(
						`Error resolving ${formatMarkdownInlineCode(entry.entityRef)}: ${escapeMarkdownText(overflowError)}`,
					)
					continue
				}
				successCount += 1
				structuredResults.push(entityResult.structured)
				markdownParts.push(entityResult.markdown)
			}
			const allFailed = successCount === 0
			const failedEntries = outcome.results.filter(
				(
					entry,
				): entry is Extract<(typeof outcome.results)[number], { ok: false }> =>
					!entry.ok,
			)
			// Only treat a total batch failure as caller-caused when every
			// failed lookup was a caller mistake. Shared platform failures
			// (DB/load) still reach Sentry.
			const allCallerFailures =
				failedEntries.length > 0 &&
				failedEntries.every((entry) => entry.callerError)
			logMcpEvent({
				category: 'mcp',
				tool: 'search',
				toolName: 'search',
				outcome: allFailed ? 'failure' : 'success',
				durationMs: timing.durationMs,
				baseUrl,
				hasUser,
				userId: userId ?? undefined,
				...(allFailed
					? {
							sandboxError: false,
							...(allCallerFailures ? { callerError: true } : {}),
							errorName: 'EntityBatchError',
							errorMessage: 'All entity lookups failed.',
						}
					: {}),
			})
			return {
				content: prependToolMetadataContent(conversationId, [
					{
						type: 'text',
						text: truncateSearchText(markdownParts.join('\n\n---\n\n')),
					},
				]),
				structuredContent: {
					conversationId,
					timing,
					result: structuredResults,
					...(allFailed ? { error: 'All entity lookups failed.' } : {}),
				},
				...(allFailed ? { isError: true } : {}),
			}
		}

		const normalizedRemoteConnectorStatuses =
			remoteConnectorDownStatuses.length > 0
				? remoteConnectorDownStatuses.map(serializeRemoteConnectorStatus)
				: undefined
		const execution = outcome.execution
		const searchMemories = execution.memorySettlement.memories
		const structuredWarnings = [...warnings]

		const payload: {
			matches: Array<SearchMatch>
			offline: boolean
			remoteConnectorStatuses?: Array<{
				connectorId: string
				state: string
				connected: boolean
				toolCount: number
			}>
		} = {
			matches: execution.result.matches,
			offline: execution.result.offline,
			...(normalizedRemoteConnectorStatuses
				? {
						remoteConnectorStatuses: normalizedRemoteConnectorStatuses,
					}
				: {}),
		}
		const statefulAgent = agent as McpRegistrationAgent & {
			state?: {
				searchConversationIdsWithPreamble?: Array<string>
			}
			setState?: (state: {
				searchConversationIdsWithPreamble?: Array<string>
			}) => void
		}
		const searchConversationIdsWithPreamble = Array.isArray(
			statefulAgent.state?.searchConversationIdsWithPreamble,
		)
			? (statefulAgent.state?.searchConversationIdsWithPreamble ?? [])
			: []
		const includePreamble =
			!args.conversationId ||
			!searchConversationIdsWithPreamble.includes(conversationId)
		if (includePreamble && typeof statefulAgent.setState === 'function') {
			statefulAgent.setState({
				...(statefulAgent.state ?? {}),
				searchConversationIdsWithPreamble: [
					...searchConversationIdsWithPreamble,
					conversationId,
				],
			})
		}
		const formattingStartMs = performance.now()
		const { payload: trimmedPayload, serialized } = applyMaxResponseSize(
			payload,
			maxResponseSize,
			(value) =>
				formatSearchMarkdown({
					matches: value.matches,
					warningCount: structuredWarnings.length,
					includePreamble,
				}),
			(value, count) => ({
				...value,
				matches: value.matches.slice(0, count),
			}),
			(value) => value.matches.length,
		)
		const trimmedMatchCount = Math.max(
			0,
			execution.result.matches.length - trimmedPayload.matches.length,
		)
		const formattingMs = elapsedMs(formattingStartMs)
		const result: SearchResultStructuredContent = {
			offline: trimmedPayload.offline,
			warnings: structuredWarnings,
			...(execution.result.guidance
				? {
						guidance: execution.result.guidance,
					}
				: {}),
			telemetry: {
				...execution.result.telemetry,
				topResultTypes: trimmedPayload.matches
					.slice(0, 5)
					.map((match) => match.type),
				trimmedMatchCount,
				responseTrimmed: trimmedMatchCount > 0,
			},
			phaseTimings: {
				...execution.result.phaseTimings,
				...endToEndPhaseTimings,
				formattingMs,
			},
			...(searchMemories
				? {
						memories: searchMemories,
					}
				: {}),
			...(trimmedPayload.remoteConnectorStatuses
				? {
						remoteConnectorStatuses: trimmedPayload.remoteConnectorStatuses,
					}
				: {}),
			matches: toSlimStructuredMatches({
				matches: trimmedPayload.matches,
				baseUrl,
				username,
			}),
		}
		const timing = finishToolTiming(timingStart)
		logMcpEvent({
			category: 'mcp',
			tool: 'search',
			toolName: 'search',
			outcome: 'success',
			durationMs: timing.durationMs,
			baseUrl,
			hasUser,
			userId: userId ?? undefined,
			message: 'Search completed successfully.',
			context: {
				task: execution.result.intent.task.name,
				intentConfidence: execution.result.intent.confidence,
				entityCount: execution.result.intent.entities.length,
				actionCount: execution.result.intent.actions.length,
				constraintCount: execution.result.intent.constraints.length,
				candidateCounts: execution.result.telemetry.candidateCounts,
				topResultTypes: result.telemetry?.topResultTypes ?? [],
				responseTrimmed: result.telemetry?.responseTrimmed ?? false,
				trimmedMatchCount,
				offline: execution.result.offline,
				warningsCount: warnings.length,
				phaseTimings: result.phaseTimings,
			},
		})
		return {
			content: prependToolMetadataContent(conversationId, [
				{
					type: 'text',
					text: truncateSearchText(serialized),
				},
			]),
			structuredContent: {
				conversationId,
				timing,
				result,
			},
		}
	} catch (cause) {
		const timing = finishToolTiming(timingStart)
		const error = cause instanceof Error ? cause : new Error(String(cause))
		const { errorName, errorMessage } = errorFields(error)
		logMcpEvent({
			category: 'mcp',
			tool: 'search',
			toolName: 'search',
			outcome: 'failure',
			durationMs: timing.durationMs,
			baseUrl,
			hasUser,
			userId: userId ?? undefined,
			sandboxError: false,
			errorName,
			errorMessage,
			cause: error,
		})
		return {
			content: prependToolMetadataContent(conversationId, [
				{ type: 'text', text: `Error: ${error.message}` },
			]),
			structuredContent: {
				conversationId,
				timing,
				error: error.message,
			},
			isError: true,
		}
	}
}
