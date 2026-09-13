import {
	userMeterNamespace,
	userMeterRpc,
	type UserMeterEnv,
} from '#worker/entitlements/user-meter-client.ts'

/**
 * Best-effort last-heard time for an inbound MCP OAuth `clientId`. Written
 * from successful bearer validation onto the per-user UserMeter (0002:
 * high-write, userId-addressed). Isolate + DO debounce keep this off the
 * awaited MCP hot path.
 */
const inboundMcpConnectionLastUsedMinIntervalMs = 5 * 60 * 1000

const lastTouchByKey = new Map<string, number>()
const debounceMapPruneLimit = 512

function inboundMcpConnectionLastUsedDebounceCutoffIso(
	lastUsedAt: string,
	intervalMs = inboundMcpConnectionLastUsedMinIntervalMs,
) {
	const nextMs = Date.parse(lastUsedAt)
	if (!Number.isFinite(nextMs)) {
		throw new Error(
			`Inbound MCP last-used timestamp must be an ISO datetime; got ${JSON.stringify(lastUsedAt)}.`,
		)
	}
	return new Date(nextMs - intervalMs).toISOString()
}

export function shouldSkipInboundMcpConnectionLastUsedTouch(input: {
	previousLastUsedAt: string | null
	nextLastUsedAt: string
	intervalMs?: number
}) {
	if (!input.previousLastUsedAt) return false
	return (
		input.previousLastUsedAt >=
		inboundMcpConnectionLastUsedDebounceCutoffIso(
			input.nextLastUsedAt,
			input.intervalMs,
		)
	)
}

function debounceKey(userId: string, clientId: string) {
	return `${userId}\0${clientId}`
}

function pruneDebounceMap(nowMs: number) {
	if (lastTouchByKey.size < debounceMapPruneLimit) return
	for (const [key, touchedAt] of lastTouchByKey) {
		if (nowMs - touchedAt >= inboundMcpConnectionLastUsedMinIntervalMs) {
			lastTouchByKey.delete(key)
		}
	}
}

function shouldSkipIsolateDebounce(
	userId: string,
	clientId: string,
	nowMs: number,
) {
	pruneDebounceMap(nowMs)
	const key = debounceKey(userId, clientId)
	const previous = lastTouchByKey.get(key)
	if (
		previous != null &&
		nowMs - previous < inboundMcpConnectionLastUsedMinIntervalMs
	) {
		return true
	}
	lastTouchByKey.set(key, nowMs)
	return false
}

export async function recordInboundMcpConnectionLastUsed(input: {
	env: UserMeterEnv
	userId: string
	clientId: string
	lastUsedAt?: string
	nowMs?: number
}): Promise<void> {
	const clientId = input.clientId.trim()
	if (!clientId || !userMeterNamespace(input.env)) return
	const nowMs = input.nowMs ?? Date.now()
	if (shouldSkipIsolateDebounce(input.userId, clientId, nowMs)) return
	const lastUsedAt = input.lastUsedAt ?? new Date(nowMs).toISOString()
	await userMeterRpc({
		env: input.env,
		userId: input.userId,
	}).touchInboundConnectionLastUsed({
		clientId,
		lastUsedAt,
	})
}

export async function listInboundMcpConnectionLastUsed(input: {
	env: UserMeterEnv
	userId: string
}): Promise<Map<string, string>> {
	const lastUsed = new Map<string, string>()
	if (!userMeterNamespace(input.env)) return lastUsed
	const rows = await userMeterRpc({
		env: input.env,
		userId: input.userId,
	}).listInboundConnectionLastUsed()
	for (const row of rows) {
		lastUsed.set(row.clientId, row.lastUsedAt)
	}
	return lastUsed
}

export async function forgetInboundMcpConnectionLastUsed(input: {
	env: UserMeterEnv
	userId: string
	clientId: string
}): Promise<void> {
	const clientId = input.clientId.trim()
	if (!clientId || !userMeterNamespace(input.env)) return
	lastTouchByKey.delete(debounceKey(input.userId, clientId))
	await userMeterRpc({
		env: input.env,
		userId: input.userId,
	}).forgetInboundConnectionLastUsed({ clientId })
}
