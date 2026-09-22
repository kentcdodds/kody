import { WorkerEntrypoint, exports } from 'cloudflare:workers'

const sessions = new Map()

export class Bridge extends WorkerEntrypoint {
	async call(token, name, args) {
		const session = sessions.get(token)
		if (!session) {
			throw new Error('Python execute session is not active.')
		}
		return await session(name, args)
	}
}

const compatibilityDate = '2026-04-16'
const javascriptFlags = [
	'nodejs_compat',
	'global_fetch_strictly_public',
	'enhanced_error_serialization',
]

const pythonMinimal = `from workers import WorkerEntrypoint

class Default(WorkerEntrypoint):
    async def evaluate(self, invocation):
        return "n=" + str(invocation["n"])
`

const pythonBridge = `from workers import WorkerEntrypoint
from pyodide.ffi import to_js
from js import Object

class Default(WorkerEntrypoint):
    async def evaluate(self, invocation):
        echoed = await self.env.BRIDGE.call(
            invocation["token"],
            "echo",
            {"n": invocation["n"]},
        )
        return to_js({"echoed": echoed}, dict_converter=Object.fromEntries)
`

const javascriptMinimal = `import { WorkerEntrypoint } from "cloudflare:workers"
export default class extends WorkerEntrypoint {
  async evaluate(invocation) {
    return { ok: true, n: invocation.n }
  }
}
`

const javascriptHostCall = `import { WorkerEntrypoint } from "cloudflare:workers"
export default class extends WorkerEntrypoint {
  async evaluate(dispatchers, invocation) {
    const echoed = await dispatchers.kody.call("echo", { n: invocation.n })
    return { echoed }
  }
}
`

export default {
	async fetch(request, env) {
		const url = new globalThis.URL(request.url)
		if (url.pathname === '/health') {
			return new globalThis.Response('ok')
		}
		const rounds = clampRounds(url.searchParams.get('rounds'))
		const startedAt = new Date().toISOString()
		const scenarios = []
		scenarios.push(
			await runScenario({
				env,
				name: 'javascript-minimal',
				rounds,
				language: 'javascript',
				invoke: (entry, round) => entry.evaluate({ n: round }),
				expect: (response, round) =>
					response?.ok === true && response?.n === round,
				options: () => ({
					compatibilityDate,
					compatibilityFlags: javascriptFlags,
					mainModule: 'entry.js',
					modules: { 'entry.js': javascriptMinimal },
					globalOutbound: null,
				}),
			}),
		)
		scenarios.push(
			await runScenario({
				env,
				name: 'python-minimal',
				rounds,
				language: 'python',
				invoke: (entry, round) => entry.evaluate({ n: round }),
				expect: (response, round) => response === `n=${round}`,
				options: () => ({
					compatibilityDate,
					compatibilityFlags: [...javascriptFlags, 'python_workers'],
					mainModule: 'entry.py',
					modules: { 'entry.py': { py: pythonMinimal } },
					globalOutbound: null,
				}),
			}),
		)
		scenarios.push(
			await runScenario({
				env,
				name: 'javascript-host-call',
				rounds,
				language: 'javascript',
				invoke: (entry, round) =>
					entry.evaluate(
						{
							kody: {
								async call(name, args) {
									return { name, args }
								},
							},
						},
						{ n: round },
					),
				expect: (response, round) => response?.echoed?.args?.n === round,
				options: () => ({
					compatibilityDate,
					compatibilityFlags: javascriptFlags,
					mainModule: 'entry.js',
					modules: { 'entry.js': javascriptHostCall },
					globalOutbound: null,
				}),
			}),
		)
		scenarios.push(
			await runScenario({
				env,
				name: 'python-bridge',
				rounds,
				language: 'python',
				invoke: async (entry, round) => {
					const token = globalThis.crypto.randomUUID()
					sessions.set(token, async (name, args) => ({ name, args }))
					try {
						return await entry.evaluate({ n: round, token })
					} finally {
						sessions.delete(token)
					}
				},
				expect: (response, round) => response?.echoed?.args?.n === round,
				options: () => ({
					compatibilityDate,
					compatibilityFlags: [...javascriptFlags, 'python_workers'],
					mainModule: 'entry.py',
					modules: { 'entry.py': { py: pythonBridge } },
					env: {
						BRIDGE: exports.Bridge({ props: {} }),
					},
					globalOutbound: null,
				}),
			}),
		)
		return globalThis.Response.json({
			suite: 'dynamic-worker-cold-warm',
			ranAt: startedAt,
			rounds,
			note: 'Each sample times LOADER.get + getEntrypoint().evaluate inside an already running parent. processColdMs is the first new isolate for that scenario in this process. newIdColdMs are later fresh ids (new module isolate, workerd already warm). warmMs is a second evaluate on the same id. Kody execute reuses an id for the UTC day when the module graph is unchanged and params stay off the id. A new agent snippet is a new id.',
			scenarios,
		})
	},
}

async function runScenario(input) {
	const samples = []
	for (let round = 0; round < input.rounds; round++) {
		const workerId = `${input.name}-${round}-${globalThis.crypto.randomUUID()}`
		const cold = await timeEvaluate(input, workerId, round)
		const warm = await timeEvaluate(input, workerId, round)
		samples.push({
			round,
			workerId,
			coldMs: cold.ms,
			warmMs: warm.ms,
			coldOk: cold.ok,
			warmOk: warm.ok,
			coldError: cold.error,
			warmError: warm.error,
		})
	}
	const processCold = samples[0]
	const later = samples.slice(1)
	return {
		name: input.name,
		language: input.language,
		processColdMs: processCold?.coldMs ?? null,
		processColdOk: processCold?.coldOk ?? false,
		newIdColdMs: later.map((sample) => sample.coldMs),
		warmMs: samples.map((sample) => sample.warmMs),
		medianNewIdColdMs: median(later.map((sample) => sample.coldMs)),
		medianWarmMs: median(samples.map((sample) => sample.warmMs)),
		samples,
	}
}

async function timeEvaluate(input, workerId, round) {
	const started = Date.now()
	try {
		const entry = input.env.LOADER.get(workerId, () =>
			input.options(),
		).getEntrypoint()
		const response = await input.invoke(entry, round)
		return {
			ms: Date.now() - started,
			ok: input.expect(response, round),
			error: null,
		}
	} catch (error) {
		return {
			ms: Date.now() - started,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

function clampRounds(value) {
	const parsed = Number(value ?? '5')
	if (!Number.isInteger(parsed)) return 5
	return Math.min(8, Math.max(2, parsed))
}

function median(values) {
	const sorted = values
		.filter((value) => Number.isFinite(value))
		.sort((a, b) => a - b)
	if (sorted.length === 0) return null
	const middle = Math.floor(sorted.length / 2)
	if (sorted.length % 2 === 1) return sorted[middle]
	return Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}
