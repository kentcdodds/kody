/**
 * Detect when the Playwright `webServer` (Wrangler / workerd) has exited
 * mid-suite. Remaining tests would otherwise burn CI retries on
 * ECONNREFUSED / ERR_CONNECTION_REFUSED (see KODY main Validate flake on
 * #1316). Once marked dead, every later check fails immediately with a clear
 * message pointing at the `logs.local/` CI artifact.
 */

export class E2eWebServerDeadError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'E2eWebServerDeadError'
	}
}

let webServerDead = false

const connectionRefusedPattern =
	/(?:ECONNREFUSED|ERR_CONNECTION_REFUSED|net::ERR_CONNECTION_REFUSED)/i

export function isE2eWebServerConnectionError(error: unknown): boolean {
	const seen = new Set<unknown>()
	const queue: Array<unknown> = [error]
	while (queue.length > 0) {
		const current = queue.shift()
		if (current === undefined || current === null || seen.has(current)) {
			continue
		}
		seen.add(current)
		if (typeof current === 'string') {
			if (connectionRefusedPattern.test(current)) return true
			continue
		}
		if (typeof current !== 'object') continue
		if (
			'code' in current &&
			typeof current.code === 'string' &&
			current.code === 'ECONNREFUSED'
		) {
			return true
		}
		if (
			'message' in current &&
			typeof current.message === 'string' &&
			connectionRefusedPattern.test(current.message)
		) {
			return true
		}
		if ('cause' in current) queue.push(current.cause)
		if (
			'errors' in current &&
			Array.isArray((current as { errors?: unknown }).errors)
		) {
			for (const nested of (current as { errors: Array<unknown> }).errors) {
				queue.push(nested)
			}
		}
	}
	return false
}

export function isE2eWebServerMarkedDead() {
	return webServerDead
}

/** Test-only: clear the process-local dead latch between unit cases. */
export function resetE2eWebServerLivenessForTests() {
	webServerDead = false
}

function webServerDeadMessage(origin: string, detail?: string) {
	const suffix = detail ? ` (${detail})` : ''
	return (
		`Playwright webServer (wrangler) is not reachable at ${origin}${suffix}. ` +
		'The process likely exited mid-suite — remaining tests will fail fast. ' +
		'On CI, download the e2e-wrangler-logs artifact (logs.local/) from the ' +
		'failed 🎭 E2E job.'
	)
}

export function markE2eWebServerDead(origin: string, detail?: string): never {
	webServerDead = true
	throw new E2eWebServerDeadError(webServerDeadMessage(origin, detail))
}

/**
 * If `error` is a connection-refused / already-dead signal, mark the suite
 * dead and throw {@link E2eWebServerDeadError}. Otherwise return so the caller
 * can rethrow the original error.
 */
export function throwIfE2eWebServerDead(
	error: unknown,
	origin = 'http://127.0.0.1:3847',
): void {
	if (error instanceof E2eWebServerDeadError) {
		webServerDead = true
		throw error
	}
	if (webServerDead || isE2eWebServerConnectionError(error)) {
		const detail =
			error instanceof Error
				? error.message
				: typeof error === 'string'
					? error
					: undefined
		markE2eWebServerDead(origin, detail)
	}
}

/**
 * Probe `/health`. Any HTTP response means the server is still listening;
 * connection failures latch the suite as dead.
 */
export async function assertE2eWebServerAlive(
	baseURL: string | undefined,
): Promise<void> {
	const origin = new URL(baseURL ?? 'http://127.0.0.1:3847').origin
	if (webServerDead) {
		throw new E2eWebServerDeadError(webServerDeadMessage(origin))
	}

	const healthUrl = new URL('/health', origin)
	try {
		await fetch(healthUrl, { signal: AbortSignal.timeout(3_000) })
	} catch (error) {
		throwIfE2eWebServerDead(error, origin)
		throw error
	}
}
