import { isExecutedDirectly } from './node-runtime.ts'

export const defaultWorkerPort = 3742
export const defaultWorkerPortCount = 10
export const defaultHealthTimeoutMs = 1_500

export function workerPortRange(
	startPort = defaultWorkerPort,
	count = defaultWorkerPortCount,
) {
	return Array.from({ length: count }, (_, index) => startPort + index)
}

export function workerOriginForPort(port: number) {
	return `http://localhost:${port}`
}

export function healthUrlForOrigin(origin: string) {
	return `${origin.replace(/\/$/, '')}/health`
}

export function parsePortFromOrigin(origin: string) {
	try {
		const port = Number.parseInt(new URL(origin).port, 10)
		return Number.isFinite(port) && port > 0 ? port : null
	} catch {
		return null
	}
}

export async function isWorkerHealthOk(
	origin: string,
	options: {
		timeoutMs?: number
		fetchImpl?: typeof fetch
	} = {},
) {
	const timeoutMs = options.timeoutMs ?? defaultHealthTimeoutMs
	const fetchImpl = options.fetchImpl ?? fetch
	const controller = new AbortController()
	const timer = setTimeout(() => {
		controller.abort()
	}, timeoutMs)
	try {
		const response = await fetchImpl(healthUrlForOrigin(origin), {
			signal: controller.signal,
		})
		await response.body?.cancel()
		return response.ok
	} catch {
		return false
	} finally {
		clearTimeout(timer)
	}
}

export async function findHealthyWorkerOrigin(
	ports: ReadonlyArray<number>,
	options: {
		timeoutMs?: number
		fetchImpl?: typeof fetch
		probe?: (origin: string) => Promise<boolean>
	} = {},
) {
	const probe =
		options.probe ??
		((origin: string) =>
			isWorkerHealthOk(origin, {
				timeoutMs: options.timeoutMs,
				fetchImpl: options.fetchImpl,
			}))
	for (const port of ports) {
		const origin = workerOriginForPort(port)
		if (await probe(origin)) return origin
	}
	return null
}

if (isExecutedDirectly(import.meta.url)) {
	const origin = await findHealthyWorkerOrigin(workerPortRange())
	if (origin) {
		console.log(`App running at ${origin}`)
		process.exit(0)
	}
	console.error('No healthy local origin found.')
	process.exit(1)
}
