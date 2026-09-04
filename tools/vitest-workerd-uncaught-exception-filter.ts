/**
 * Workerd logs Durable Object / WorkerEntrypoint RPC rejections as
 * `uncaught exception` even when the caller catches them. That noise shows up
 * in every `test:workers` / pre-push run for suites that assert expected
 * failures (read-only storage SQL, retriever fetch denial, forced SQL
 * rollbacks). Drop only those known incidental dumps; any other workerd log
 * still prints so a real isolate crash is never hidden.
 *
 * Wired as workers-unit `globalSetup` (Node-side). Companion to
 * `silenceExpectedConsoleErrors` / `silenceIncidentalRuntimeWarnings`, which
 * cannot see these because they never go through JS `console`.
 */

export const incidentalWorkerdUncaughtExceptionNeedles = [
	'Read-only storage.sql only allows a single SELECT',
	'Outbound fetch is not available in retriever runs.',
	'forced second chunk failure',
] as const

export type WorkerdLogFilterState = {
	skippingIncidentalException: boolean
	pending: string
}

export function createWorkerdLogFilterState(): WorkerdLogFilterState {
	return { skippingIncidentalException: false, pending: '' }
}

export function isIncidentalWorkerdUncaughtExceptionLine(
	line: string,
): boolean {
	if (!line.includes('uncaught exception;')) return false
	return incidentalWorkerdUncaughtExceptionNeedles.some((needle) =>
		line.includes(needle),
	)
}

export function isWorkerdExceptionContinuationLine(line: string): boolean {
	return /^\s+at\s/.test(line) || line.startsWith('stack:')
}

export function consumeWorkerdLogChunk(
	state: WorkerdLogFilterState,
	chunk: string,
): string {
	const data = state.pending + chunk
	const lines = data.split('\n')
	const incomplete = lines.pop() ?? ''
	const emit: Array<string> = []
	for (const line of lines) {
		if (isIncidentalWorkerdUncaughtExceptionLine(line)) {
			state.skippingIncidentalException = true
			continue
		}
		if (
			state.skippingIncidentalException &&
			(line.trim() === '' || isWorkerdExceptionContinuationLine(line))
		) {
			continue
		}
		state.skippingIncidentalException = false
		emit.push(line)
	}

	const holdIncomplete =
		incomplete.startsWith('uncaught') ||
		incomplete.includes('uncaught exception;') ||
		(state.skippingIncidentalException &&
			(incomplete.length === 0 ||
				incomplete.trim() === '' ||
				isWorkerdExceptionContinuationLine(incomplete)))
	if (holdIncomplete) {
		state.pending = incomplete
		return emit.length === 0 ? '' : `${emit.join('\n')}\n`
	}
	state.pending = ''
	if (emit.length === 0) return incomplete
	if (incomplete.length === 0) return `${emit.join('\n')}\n`
	return `${emit.join('\n')}\n${incomplete}`
}

export function flushWorkerdLogFilter(state: WorkerdLogFilterState): string {
	const leftover = state.pending
	state.pending = ''
	if (leftover.length === 0) return ''
	if (isIncidentalWorkerdUncaughtExceptionLine(leftover)) return ''
	if (
		state.skippingIncidentalException &&
		isWorkerdExceptionContinuationLine(leftover)
	) {
		return ''
	}
	return leftover
}

type WriteCallback = (error?: Error | null) => void

function chunkToString(
	chunk: string | Uint8Array,
	encoding: BufferEncoding | undefined,
): string {
	if (typeof chunk === 'string') return chunk
	return Buffer.from(chunk).toString(encoding ?? 'utf8')
}

export function installWorkerdUncaughtExceptionFilter(
	streams: Array<NodeJS.WriteStream> = [process.stderr],
): () => void {
	const restores: Array<() => void> = []
	for (const stream of streams) {
		const originalWrite = stream.write.bind(stream)
		const state = createWorkerdLogFilterState()
		stream.write = ((
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | WriteCallback,
			maybeCallback?: WriteCallback,
		) => {
			const encoding =
				typeof encodingOrCallback === 'function'
					? undefined
					: encodingOrCallback
			const callback =
				typeof encodingOrCallback === 'function'
					? encodingOrCallback
					: maybeCallback
			const emit = consumeWorkerdLogChunk(state, chunkToString(chunk, encoding))
			if (emit.length === 0) {
				callback?.()
				return true
			}
			if (typeof encoding === 'string') {
				return originalWrite(emit, encoding, callback)
			}
			if (callback) return originalWrite(emit, callback)
			return originalWrite(emit)
		}) as typeof stream.write
		restores.push(() => {
			const leftover = flushWorkerdLogFilter(state)
			if (leftover.length > 0) originalWrite(leftover)
			stream.write = originalWrite
		})
	}
	return () => {
		for (const restore of restores) restore()
	}
}

export default function setup() {
	return installWorkerdUncaughtExceptionFilter()
}
