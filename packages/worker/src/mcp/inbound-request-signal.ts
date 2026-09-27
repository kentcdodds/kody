import { AsyncLocalStorage } from 'node:async_hooks'

const inboundRequestSignalStorage = new AsyncLocalStorage<AbortSignal>()

/** The inbound HTTP request's abort signal, when this turn is serving one. */
export function getInboundRequestSignal() {
	return inboundRequestSignalStorage.getStore()
}

/**
 * Bind `request.signal` for MCP tool handlers. Durable Object RPC does not
 * carry AsyncLocalStorage, so each lane sets this inside the isolate that
 * actually runs the tool.
 */
export async function runWithInboundRequestSignal<T>(
	signal: AbortSignal | undefined,
	callback: () => Promise<T>,
): Promise<T> {
	if (!signal) return await callback()
	return await inboundRequestSignalStorage.run(signal, callback)
}
