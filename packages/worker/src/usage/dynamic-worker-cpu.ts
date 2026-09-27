import { WorkerEntrypoint } from 'cloudflare:workers'
import { recordUsage } from './record-usage.ts'

export const dynamicWorkerCpuEventType = 'dynamic_worker_cpu'

export type DynamicWorkerUsageTailProps = {
	userId: string
	workerId: string
}

/**
 * Tail worker attached to Worker Loader isolates (`WorkerCode.tails`). The
 * runtime delivers one trace event per invocation after the response, so
 * recording here adds no latency to the run. `cpuTime` is Cloudflare's own
 * per-invocation CPU measurement; wall time is never used as a CPU stand-in.
 * Props are identity only: `LOADER.get` keeps the first factory's WorkerCode
 * for a worker id, and the id already hashes the user. Zero CPU is still
 * recorded, so `event_count` doubles as tail delivery coverage against
 * `dynamic_worker_invoke` (tails are best-effort).
 */
export class DynamicWorkerUsageTail extends WorkerEntrypoint<
	Env,
	DynamicWorkerUsageTailProps
> {
	async tail(events: Array<TraceItem>) {
		await Promise.all(
			events.map((event) =>
				recordDynamicWorkerCpu({
					env: this.env,
					props: this.ctx.props,
					event,
				}),
			),
		)
	}
}

export async function recordDynamicWorkerCpu(input: {
	env: Pick<Env, 'USAGE_EVENTS' | 'APP_DB'>
	props: DynamicWorkerUsageTailProps
	event: Pick<TraceItem, 'cpuTime' | 'wallTime' | 'outcome'>
}): Promise<void> {
	const cpuMs = Number(input.event.cpuTime)
	if (!input.props.userId || !Number.isFinite(cpuMs) || cpuMs < 0) return
	const wallMs = Number(input.event.wallTime)
	await recordUsage(input.env, {
		userId: input.props.userId,
		eventType: dynamicWorkerCpuEventType,
		entityId: input.props.workerId,
		cpuMs: Math.round(cpuMs),
		durationMs: Number.isFinite(wallMs) ? Math.round(wallMs) : null,
		outcome: input.event.outcome === 'ok' ? 'success' : 'error',
	})
}
