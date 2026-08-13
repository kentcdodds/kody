/**
 * MCP protocol lane metrics.
 *
 * `/mcp` serves two lanes: the sessionful Durable Object `McpAgent` lane for
 * 2025-era protocol revisions ("legacy") and the stateless SDK v2 lane for
 * 2026-07-28+ revisions ("modern"). The legacy lane can only be retired once
 * real traffic stops using it, so every authenticated `/mcp` request records
 * one data point describing which lane served it, the protocol revision, the
 * JSON-RPC method, and the connecting client.
 *
 * Data points go to the `MCP_PROTOCOL_EVENTS` Analytics Engine dataset —
 * deliberately not the primary D1 database: the retirement readout is a pure
 * aggregate (no joins), and `writeDataPoint` is non-blocking so recording
 * stays off the request hot path. Without the binding (local dev, tests)
 * recording is a no-op. Recording never throws.
 *
 * Retirement readout (Analytics Engine SQL API; counts must be weighted by
 * `_sample_interval` because Analytics Engine samples at high volume):
 *
 * ```sql
 * SELECT blob1 AS lane, blob4 AS client_name, SUM(_sample_interval) AS requests
 * FROM kody_mcp_protocol_events
 * WHERE timestamp > NOW() - INTERVAL '30' DAY
 * GROUP BY lane, client_name
 * ORDER BY requests DESC
 * ```
 */

import {
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
	isLegacyRequest,
} from '@modelcontextprotocol/server'
import { isRecord } from '@kody-internal/shared/is-record.ts'

export type McpProtocolLane = 'legacy' | 'modern'

export type McpProtocolEventEnv = {
	MCP_PROTOCOL_EVENTS?: AnalyticsEngineDataset
}

export type McpProtocolClassification = {
	lane: McpProtocolLane
	/** JSON-RPC method for POSTs, `http:GET` / `http:DELETE` for session operations. */
	method: string
	/** Protocol revision claimed by the request (`_meta` envelope or negotiated header). */
	protocolVersion: string
	clientName: string
	clientVersion: string
	/**
	 * Parsed JSON body for POST requests, when parseable. Callers forward it
	 * to the stateless handler so the body is parsed at most once per request.
	 */
	parsedBody?: unknown
}

function readString(value: unknown): string {
	return typeof value === 'string' ? value : ''
}

/** First JSON-RPC message of a body (batch arrays classify by their first entry). */
function firstJsonRpcMessage(body: unknown): Record<string, unknown> | null {
	if (Array.isArray(body)) {
		const first = body.find(isRecord)
		return first ?? null
	}
	return isRecord(body) ? body : null
}

/**
 * Classify one authenticated `/mcp` request into its serving lane and extract
 * the metric fields. Uses the SDK's own {@link isLegacyRequest} predicate —
 * the exact classifier `createMcpHandler` runs — so routing and metrics can
 * never disagree. The request body is read from a clone; the request stays
 * fully readable for whichever lane serves it.
 */
export async function classifyMcpProtocolRequest(
	request: Request,
): Promise<McpProtocolClassification> {
	let parsedBody: unknown
	let hasParsedBody = false
	if (request.method === 'POST') {
		try {
			parsedBody = await request.clone().json()
			hasParsedBody = true
		} catch {
			// Empty or invalid JSON classifies legacy; the lane handler owns
			// the error response.
		}
	}
	const legacy = hasParsedBody
		? await isLegacyRequest(request, parsedBody)
		: await isLegacyRequest(request)
	const lane: McpProtocolLane = legacy ? 'legacy' : 'modern'

	if (request.method !== 'POST') {
		return {
			lane,
			method: `http:${request.method}`,
			protocolVersion: readString(request.headers.get('mcp-protocol-version')),
			clientName: '',
			clientVersion: '',
		}
	}

	const message = firstJsonRpcMessage(parsedBody)
	const method = readString(message?.['method']) || 'unknown'
	const meta = isRecord(message?.['params'])
		? message['params']['_meta']
		: undefined
	const params = isRecord(message?.['params']) ? message['params'] : undefined

	// Modern requests carry the revision in the `_meta` envelope; legacy
	// requests send the negotiated `mcp-protocol-version` header (or name the
	// offered revision in the `initialize` params).
	const protocolVersion =
		(isRecord(meta) ? readString(meta[PROTOCOL_VERSION_META_KEY]) : '') ||
		readString(request.headers.get('mcp-protocol-version')) ||
		(method === 'initialize' ? readString(params?.['protocolVersion']) : '')

	const clientInfo = isRecord(meta)
		? meta[CLIENT_INFO_META_KEY]
		: method === 'initialize'
			? params?.['clientInfo']
			: undefined

	return {
		lane,
		method,
		protocolVersion,
		clientName: isRecord(clientInfo) ? readString(clientInfo['name']) : '',
		clientVersion: isRecord(clientInfo)
			? readString(clientInfo['version'])
			: '',
		...(hasParsedBody ? { parsedBody } : {}),
	}
}

/**
 * Record one lane data point. Non-blocking, never throws, no-op without the
 * Analytics Engine binding.
 */
export function recordMcpProtocolEvent(
	env: McpProtocolEventEnv,
	input: Omit<McpProtocolClassification, 'parsedBody'> & {
		userId?: string
		requestHost?: string
	},
): void {
	try {
		env.MCP_PROTOCOL_EVENTS?.writeDataPoint({
			// Indexed by lane so Analytics Engine sampling stays independent
			// per lane and low-volume modern traffic is never drowned out.
			indexes: [input.lane],
			blobs: [
				input.lane,
				input.method,
				input.protocolVersion,
				input.clientName,
				input.clientVersion,
				input.userId ?? '',
				// blob7: request host, so domain migrations can measure which
				// users still connect through a legacy hostname.
				input.requestHost ?? '',
			],
			doubles: [1],
		})
	} catch (error) {
		console.warn('mcp-protocol-event-failed', error)
	}
}
