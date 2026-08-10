/**
 * Dual-lane progress reporting for MCP tool handlers.
 *
 * Both SDK generations pass a second callback argument that can carry a
 * client `progressToken` plus a way to send `notifications/progress`:
 * - SDK v1 (`McpAgent` DO lane): `RequestHandlerExtra.sendNotification`
 * - SDK v2 (stateless 2026 lane): `ServerContext.mcpReq.notify`
 *
 * Tools normalize that shape once here so execute / capabilities stay
 * lane-agnostic and SDK-v2-migration-safe (issue #1191).
 */

export type McpProgressUpdate = {
	progress: number
	total?: number
	message?: string
}

export type McpReportProgress = (update: McpProgressUpdate) => Promise<void>

export type McpProgressToken = string | number

type McpProgressNotification = {
	method: 'notifications/progress'
	params: {
		progressToken: McpProgressToken
		progress: number
		total?: number
		message?: string
	}
}

/**
 * Minimal dual-lane tool-call context. Call sites pass whatever the concrete
 * SDK handed them; unknown / missing fields simply disable progress.
 */
export type McpToolCallExtra = {
	_meta?: {
		progressToken?: McpProgressToken
		[key: string]: unknown
	}
	sendNotification?: (notification: McpProgressNotification) => Promise<void>
	mcpReq?: {
		_meta?: {
			progressToken?: McpProgressToken
			[key: string]: unknown
		}
		notify?: (notification: McpProgressNotification) => Promise<void>
	}
}

function resolveProgressToken(
	extra: McpToolCallExtra | null | undefined,
): McpProgressToken | null {
	const token =
		extra?._meta?.progressToken ?? extra?.mcpReq?._meta?.progressToken
	if (token === undefined || token === null) return null
	return token
}

function resolveProgressSender(
	extra: McpToolCallExtra | null | undefined,
): ((notification: McpProgressNotification) => Promise<void>) | null {
	if (typeof extra?.sendNotification === 'function') {
		return extra.sendNotification.bind(extra)
	}
	if (typeof extra?.mcpReq?.notify === 'function') {
		return extra.mcpReq.notify.bind(extra.mcpReq)
	}
	return null
}

/**
 * Build a best-effort progress reporter. Returns `null` when the client did
 * not send a progress token or the transport cannot notify. Failed notifies
 * are swallowed so a disconnected SSE stream never fails the tool call.
 */
export function createProgressReporter(
	extra: McpToolCallExtra | null | undefined,
): McpReportProgress | null {
	const progressToken = resolveProgressToken(extra)
	const send = resolveProgressSender(extra)
	if (progressToken === null || send === null) return null

	return async (update) => {
		try {
			await send({
				method: 'notifications/progress',
				params: {
					progressToken,
					progress: update.progress,
					...(update.total === undefined ? {} : { total: update.total }),
					...(update.message === undefined ? {} : { message: update.message }),
				},
			})
		} catch {
			// Client may have dropped the stream; keep the tool running.
		}
	}
}

/** Human-friendly (slightly playful) labels for execute `serverTiming` phases. */
export const executeProgressPhaseMessages = {
	bundle: 'Tying the execute bundle with a tidy little bow…',
	hydrate: 'Hydrating modules — pouring a shot of runtime espresso…',
	'provider-assembly':
		'Laying out the toolbox so capabilities are within reach…',
	sandbox: 'Stepping into the sandbox — shoes off, code on…',
} as const

export type ExecuteProgressPhase = keyof typeof executeProgressPhaseMessages

/** Client progress order must match emission order (never move backward). */
const executeProgressPhaseOrder = [
	'bundle',
	'hydrate',
	'provider-assembly',
	'sandbox',
] as const satisfies ReadonlyArray<ExecuteProgressPhase>

export async function reportExecutePhaseProgress(
	reportProgress: McpReportProgress | null | undefined,
	phase: ExecuteProgressPhase,
) {
	if (!reportProgress) return
	const index = executeProgressPhaseOrder.indexOf(phase)
	await reportProgress({
		progress: index < 0 ? 0 : index + 1,
		total: executeProgressPhaseOrder.length,
		message: executeProgressPhaseMessages[phase],
	})
}

/** No-op helper so call sites can always `await reportProgress?.(…)` safely. */
export async function reportCapabilityProgress(
	reportProgress: McpReportProgress | null | undefined,
	update: McpProgressUpdate,
) {
	if (!reportProgress) return
	await reportProgress(update)
}
