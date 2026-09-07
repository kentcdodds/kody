/**
 * Best-effort coalesced fleet last-success heartbeat for MCP execute.
 *
 * Writes a timestamp only — no user identities, code, results, or credentials.
 * Isolate memory plus a short KV compare keep this off the hot D1 writer.
 * Failures are swallowed so customer execute never depends on the heartbeat.
 */

export const fleetExecuteLastSuccessKvKey = 'fleet-execute-last-success:v1'
export const fleetExecuteHeartbeatCoalesceMs = 45_000

export type FleetExecuteLastSuccess = {
	at: number
}

export type FleetExecuteHeartbeatMemory = {
	lastWriteAt: number
}

const isolateMemory: FleetExecuteHeartbeatMemory = { lastWriteAt: 0 }

export type FleetExecuteHeartbeatKv = Pick<KVNamespace, 'get' | 'put'>

export async function recordFleetExecuteLastSuccess(input: {
	kv?: FleetExecuteHeartbeatKv | null
	now?: number
	coalesceMs?: number
	memory?: FleetExecuteHeartbeatMemory
}): Promise<void> {
	try {
		const kv = input.kv
		if (!kv) return
		const now = input.now ?? Date.now()
		const coalesceMs = input.coalesceMs ?? fleetExecuteHeartbeatCoalesceMs
		const memory = input.memory ?? isolateMemory
		if (now - memory.lastWriteAt < coalesceMs) return
		const existing = await readFleetExecuteLastSuccess({ kv })
		if (existing && now - existing.at < coalesceMs) {
			memory.lastWriteAt = existing.at
			return
		}
		await kv.put(
			fleetExecuteLastSuccessKvKey,
			JSON.stringify({ at: now } satisfies FleetExecuteLastSuccess),
		)
		memory.lastWriteAt = now
	} catch (error) {
		console.warn(
			'fleet-execute-heartbeat-failed',
			error instanceof Error ? error.message : String(error),
		)
	}
}

export async function readFleetExecuteLastSuccess(input: {
	kv?: FleetExecuteHeartbeatKv | null
}): Promise<FleetExecuteLastSuccess | null> {
	try {
		const raw = await input.kv?.get(fleetExecuteLastSuccessKvKey)
		if (!raw) return null
		const parsed = JSON.parse(raw) as Partial<FleetExecuteLastSuccess>
		if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)) {
			return null
		}
		return { at: parsed.at }
	} catch {
		return null
	}
}

export function scheduleFleetExecuteLastSuccess(input: {
	waitUntil?: ((promise: Promise<unknown>) => void) | undefined
	kv?: FleetExecuteHeartbeatKv | null
	now?: number
	memory?: FleetExecuteHeartbeatMemory
}): void {
	try {
		input.waitUntil?.(
			recordFleetExecuteLastSuccess({
				kv: input.kv,
				now: input.now,
				memory: input.memory,
			}),
		)
	} catch (error) {
		console.warn(
			'fleet-execute-heartbeat-schedule-failed',
			error instanceof Error ? error.message : String(error),
		)
	}
}
