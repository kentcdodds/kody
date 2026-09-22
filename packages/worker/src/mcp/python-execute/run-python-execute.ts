import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { exports as workerExports } from 'cloudflare:workers'
import { type BuiltCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
import { createStableDynamicWorkerId } from '#mcp/dynamic-worker-id.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import { finishRunRecord } from '#worker/run-records/service.ts'
import { type RunRecordHandle } from '#worker/run-records/types.ts'
import { type StorageContext } from '#mcp/storage.ts'
import {
	openPythonCapabilitySession,
	type PythonCapabilityBridgeFactory,
} from './capability-bridge.ts'
import {
	classifyPythonFailure,
	type PythonFailureTaxonomy,
} from './failure-taxonomy.ts'
import {
	pythonExecuteContractMessage,
	sourceDefinesPythonMain,
} from './language.ts'
import { buildPythonWorkerModule } from './worker-module.ts'

export const pythonExecuteMainModule = 'entry.py'

export const pythonExecuteTimeoutMs = 60_000

export type PythonExecuteMetrics = {
	backend: 'worker-loader'
	codeChars: number
	elapsedMs: number
	/**
	 * CPU milliseconds reported by the Python isolate when `resource` is
	 * available. Pyodide often has no `resource` module, so this stays null
	 * on the Worker Loader path until a run returns a number.
	 */
	cpuMs: number | null
	taxonomy: PythonFailureTaxonomy | null
	workerId: string | null
}

export type PythonExecuteRunResult = {
	result: unknown
	error?: string
	logs: Array<string>
	runId?: string
	serverTiming: Array<{ name: string; durationMs: number }>
	python: PythonExecuteMetrics
}

type PythonEvaluateResponse = {
	result?: unknown
	error?: unknown
	errorName?: unknown
	logs?: unknown
	cpuMs?: unknown
}

/**
 * Run one experimental Python module on the Worker Loader.
 *
 * The loaded isolate's id follows the TypeScript rule: user, storage scope,
 * and module graph. `params` stay off the id so repeated calls reuse the
 * isolate. `kody.call` goes through `env.BRIDGE` (`PythonCapabilityBridge`
 * on the script that owns MCP execute). A per-call token selects the live
 * session, because `LOADER.get` keeps the first binding for a worker id.
 * Unique-worker-day billing is intentionally not recorded; this lane is an
 * experiment and must not open a new billable isolate class.
 */
export async function runPythonExecute(input: {
	env: Env
	callerContext: McpCallerContext
	code: string
	params?: Record<string, unknown>
	capabilityRegistry: BuiltCapabilityRegistry
	runRecordHandle?: RunRecordHandle | null
	waitUntil?: (promise: Promise<unknown>) => void
	timeoutMs?: number
	bridgeExports?: {
		PythonCapabilityBridge?: PythonCapabilityBridgeFactory
	}
}): Promise<PythonExecuteRunResult> {
	const startedAtMs = Date.now()
	const codeChars = input.code.length
	const userId = input.callerContext.user?.userId ?? null
	const storageContext = normalizePythonStorageContext(
		input.callerContext.storageContext,
	)

	if (!sourceDefinesPythonMain(input.code)) {
		return await settle(input, {
			userId,
			startedAtMs,
			codeChars,
			workerId: null,
			cpuMs: null,
			logs: [],
			error: pythonExecuteContractMessage,
			errorName: 'RuntimeError',
			result: undefined,
		})
	}

	const loader = input.env.LOADER
	if (!loader) {
		return await settle(input, {
			userId,
			startedAtMs,
			codeChars,
			workerId: null,
			cpuMs: null,
			logs: [],
			error:
				'Python execute uses the Worker Loader binding. Enable python-execute on a runtime that provides LOADER.',
			errorName: 'RuntimeError',
			result: undefined,
		})
	}

	const bridgeFactory = readPythonCapabilityBridgeFactory(input.bridgeExports)
	if (!bridgeFactory) {
		return await settle(input, {
			userId,
			startedAtMs,
			codeChars,
			workerId: null,
			cpuMs: null,
			logs: [],
			error:
				'Python execute needs the PythonCapabilityBridge export on the script that runs MCP execute.',
			errorName: 'RuntimeError',
			result: undefined,
		})
	}

	const compatibility = createDynamicWorkerCompatibilityOptions()
	const workerOptions = {
		...compatibility,
		compatibilityFlags: [...compatibility.compatibilityFlags, 'python_workers'],
		mainModule: pythonExecuteMainModule,
		modules: {
			[pythonExecuteMainModule]: {
				py: buildPythonWorkerModule(input.code),
			},
		},
		env: {
			BRIDGE: bridgeFactory({ props: {} }),
		},
		globalOutbound: null,
	}
	const workerId = await createStableDynamicWorkerId({
		userId,
		storageContext,
		workerOptions,
	})
	const timeoutMs = input.timeoutMs ?? pythonExecuteTimeoutMs
	const execution = {
		active: true,
	}
	const session = openPythonCapabilitySession({
		call: (name, args) =>
			callPythonCapability({
				name,
				args,
				registry: input.capabilityRegistry,
				env: input.env,
				callerContext: input.callerContext,
				waitUntil: input.waitUntil,
				active: execution,
			}),
	})

	try {
		const entrypoint = loader
			.get(workerId, () => workerOptions)
			.getEntrypoint() as unknown as {
			evaluate: (invocation: {
				params: Record<string, unknown>
				token: string
			}) => Promise<PythonEvaluateResponse>
		}
		const response = await raceTimeout(
			entrypoint.evaluate({
				params: input.params ?? {},
				token: session.token,
			}),
			timeoutMs,
		)
		const logs = readLogs(response.logs)
		if (response.error) {
			return await settle(input, {
				userId,
				startedAtMs,
				codeChars,
				workerId,
				cpuMs: readCpuMs(response.cpuMs),
				logs,
				error: readErrorMessage(response.error),
				errorName:
					typeof response.errorName === 'string' ? response.errorName : null,
				result: undefined,
			})
		}
		return await settle(input, {
			userId,
			startedAtMs,
			codeChars,
			workerId,
			cpuMs: readCpuMs(response.cpuMs),
			logs,
			error: null,
			errorName: null,
			result: jsonClone(response.result),
		})
	} catch (cause) {
		return await settle(input, {
			userId,
			startedAtMs,
			codeChars,
			workerId,
			cpuMs: null,
			logs: [],
			error: getErrorMessage(cause),
			errorName: cause instanceof Error ? cause.name : 'Error',
			result: undefined,
		})
	} finally {
		session.close()
		execution.active = false
	}
}

function readPythonCapabilityBridgeFactory(bridgeExports?: {
	PythonCapabilityBridge?: PythonCapabilityBridgeFactory
}) {
	if (bridgeExports?.PythonCapabilityBridge) {
		return bridgeExports.PythonCapabilityBridge
	}
	const liveExports = workerExports as
		| { PythonCapabilityBridge?: PythonCapabilityBridgeFactory }
		| undefined
	return liveExports?.PythonCapabilityBridge ?? null
}

async function callPythonCapability(input: {
	name: string
	args: Record<string, unknown>
	registry: BuiltCapabilityRegistry
	env: Env
	callerContext: McpCallerContext
	waitUntil?: (promise: Promise<unknown>) => void
	active: { active: boolean }
}) {
	if (!input.active.active) {
		throw new Error('Execution has already completed.')
	}
	if (!input.name.trim()) {
		throw new Error('Unknown capability: (empty)')
	}
	const handler = input.registry.capabilityHandlers[input.name]
	if (!handler) {
		throw new Error(`Unknown capability: ${input.name}`)
	}
	const context: CapabilityContext = {
		env: input.env,
		callerContext: input.callerContext,
		waitUntil: input.waitUntil,
	}
	return await handler(input.args, context)
}

async function settle(
	input: {
		env: Env
		runRecordHandle?: RunRecordHandle | null
		waitUntil?: (promise: Promise<unknown>) => void
	},
	outcome: {
		userId: string | null
		startedAtMs: number
		codeChars: number
		workerId: string | null
		cpuMs: number | null
		logs: Array<string>
		error: string | null
		errorName: string | null
		result: unknown
	},
): Promise<PythonExecuteRunResult> {
	const elapsedMs = Math.max(0, Date.now() - outcome.startedAtMs)
	const taxonomy = outcome.error
		? classifyPythonFailure({
				errorName: outcome.errorName,
				message: outcome.error,
			})
		: null
	const handle = input.runRecordHandle ?? null
	if (handle) {
		await finishRunRecord({
			env: input.env,
			handle,
			status: outcome.error ? 'error' : 'success',
			logs: outcome.logs,
			error: outcome.error ?? undefined,
			result: outcome.error ? undefined : outcome.result,
			waitUntil: input.waitUntil,
		})
	}
	if (outcome.userId) {
		await recordUsage(
			input.env,
			{
				userId: outcome.userId,
				eventType: 'execute',
				durationMs: elapsedMs,
				outcome: outcome.error ? 'error' : 'success',
				surface: 'execute',
			},
			{ waitUntil: input.waitUntil },
		)
	}
	const exposeRunId = Boolean(
		handle && (outcome.error || handle.persistence === 'eager'),
	)
	return {
		result: outcome.error ? undefined : outcome.result,
		...(outcome.error ? { error: outcome.error } : {}),
		logs: outcome.logs,
		...(exposeRunId && handle ? { runId: handle.id } : {}),
		serverTiming: [{ name: 'python-execute', durationMs: elapsedMs }],
		python: {
			backend: 'worker-loader',
			codeChars: outcome.codeChars,
			elapsedMs,
			cpuMs: outcome.cpuMs,
			taxonomy,
			workerId: outcome.workerId,
		},
	}
}

function raceTimeout<T>(work: Promise<T>, timeoutMs: number) {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error('Python execute timed out.'))
		}, timeoutMs)
		work.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(cause: unknown) => {
				clearTimeout(timer)
				reject(cause)
			},
		)
	})
}

function normalizePythonStorageContext(
	storageContext: McpCallerContext['storageContext'],
): StorageContext | null {
	if (!storageContext) return null
	return {
		sessionId: storageContext.sessionId ?? null,
		appId: storageContext.appId ?? null,
		packageId: storageContext.packageId ?? null,
		storageId: storageContext.storageId ?? null,
	}
}

function readLogs(value: unknown): Array<string> {
	if (!Array.isArray(value)) return []
	return value.map((entry) => String(entry))
}

function readCpuMs(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null
	return Math.max(0, Math.round(value))
}

function readErrorMessage(value: unknown) {
	if (typeof value === 'string' && value.trim()) return value
	return 'Python execute failed.'
}

function jsonClone(value: unknown) {
	if (value === undefined) return undefined
	return JSON.parse(JSON.stringify(value)) as unknown
}
