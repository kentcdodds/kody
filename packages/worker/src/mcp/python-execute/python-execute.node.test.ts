import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { pythonExecuteAllowedModules } from './allowed-modules.ts'
import { classifyPythonFailure } from './failure-taxonomy.ts'
import {
	pythonExecuteContractMessage,
	pythonExecuteFlagOffMessage,
	pythonExecuteInvokeConflictMessage,
	resolvePythonExecuteRequest,
} from './language.ts'
import { pythonCapabilityBridgeBinding } from './capability-bridge.ts'
import { readPythonPackageExport } from './package-sketch.ts'
import { runPythonExecute } from './run-python-execute.ts'
import { buildPythonWorkerModule } from './worker-module.ts'
import { classifyPythonFailure as classifyPythonFailureJs } from '../../../../../tools/python-execute-eval/classify-python-failure.mjs'

const execFileAsync = promisify(execFile)
const harnessPath = path.join(
	import.meta.dirname,
	'../../../../../tools/python-execute-eval/sandbox-harness.py',
)

const taxonomySamples = [
	{
		errorName: 'SyntaxError',
		message: 'invalid syntax',
		taxonomy: 'syntax',
	},
	{
		errorName: 'ModuleNotFoundError',
		message: "No module named 'numpy'",
		taxonomy: 'missing_lib',
	},
	{
		errorName: 'ImportError',
		message: 'blocked module: os',
		taxonomy: 'missing_lib',
	},
	{
		errorName: 'RuntimeError',
		message: 'Unknown capability: notes.missing',
		taxonomy: 'capability_misuse',
	},
	{
		errorName: 'JsException',
		message: 'Error: Unknown capability: echo',
		taxonomy: 'capability_misuse',
	},
	{
		errorName: 'RuntimeError',
		message: 'kody.call args are a JSON object.',
		taxonomy: 'capability_misuse',
	},
	{
		errorName: 'RuntimeError',
		message: pythonExecuteContractMessage,
		taxonomy: 'contract',
	},
	{
		errorName: 'TimeoutError',
		message: 'Python execute timed out.',
		taxonomy: 'runtime',
	},
] as const

test('python execute keeps the flag off, grades failures, and bridges kody.call through the worker loader', async () => {
	expect(
		resolvePythonExecuteRequest({
			code: 'export default async function main() { return 1 }',
			pythonEnabled: false,
		}),
	).toEqual({
		language: 'typescript',
		code: 'export default async function main() { return 1 }',
	})
	expect(() =>
		resolvePythonExecuteRequest({
			code: 'def main(params):\n    return params\n',
			language: 'python',
			pythonEnabled: false,
		}),
	).toThrow(pythonExecuteFlagOffMessage)
	expect(
		resolvePythonExecuteRequest({
			code: 'def main(params):\n    return params\n',
			language: 'python',
			pythonEnabled: true,
		}).language,
	).toBe('python')
	expect(() =>
		resolvePythonExecuteRequest({
			code: 'def main(params):\n    return params\n',
			invoke: 'kody:@acme/demo/run',
			language: 'python',
			pythonEnabled: true,
		}),
	).toThrow(pythonExecuteInvokeConflictMessage)

	for (const sample of taxonomySamples) {
		expect(classifyPythonFailure(sample)).toBe(sample.taxonomy)
		expect(classifyPythonFailureJs(sample)).toBe(sample.taxonomy)
	}

	const harness = await readFile(harnessPath, 'utf8')
	const allowedMatch = harness.match(/_ALLOWED = \(([^)]*)\)/s)
	expect(allowedMatch?.[1]).toBeTruthy()
	const harnessAllowed = [
		...(allowedMatch?.[1] ?? '').matchAll(/"([^"]+)"/g),
	].map((match) => match[1])
	expect(harnessAllowed).toEqual([...pythonExecuteAllowedModules])
	expect(harness).toContain(pythonExecuteContractMessage)

	const userSource =
		'async def main(params):\n    return await kody.call("echo", params)\n'
	const moduleSource = buildPythonWorkerModule(userSource)
	expect(moduleSource).toContain('class Default(WorkerEntrypoint)')
	expect(moduleSource).toContain('self.env.BRIDGE')
	expect(moduleSource).toContain('to_js')
	expect(moduleSource).not.toContain('python_workers')
	const directory = await mkdtemp(path.join(tmpdir(), 'kody-python-execute-'))
	const modulePath = path.join(directory, 'entry.py')
	await writeFile(modulePath, moduleSource)
	await execFileAsync('python3', ['-m', 'py_compile', modulePath])
	await rm(directory, { recursive: true, force: true })

	const manifestSource = readPythonPackageExport(
		{
			name: 'echo-notes',
			language: 'python',
			exports: {
				summarize: userSource,
			},
		},
		'summarize',
	)
	expect(manifestSource).toBe(userSource)
	expect(() =>
		readPythonPackageExport(
			{
				name: 'echo-notes',
				language: 'python',
				exports: { summarize: 'x = 1\n' },
			},
			'summarize',
		),
	).toThrow(/def main/)

	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-python',
			email: 'python@example.com',
			displayName: 'Python',
		},
	})
	const loaded: Array<{ name: string; flags: Array<string> }> = []
	const bridgeExports = {
		PythonCapabilityBridge: () => pythonCapabilityBridgeBinding(),
	}
	const env = {
		LOADER: {
			get(
				name: string,
				getCode: () => {
					compatibilityFlags?: Array<string>
					env?: {
						BRIDGE?: {
							call: (
								token: string,
								capability: string,
								args: Record<string, unknown> | null,
							) => Promise<unknown>
						}
					}
				},
			) {
				const code = getCode()
				loaded.push({
					name,
					flags: code.compatibilityFlags ?? [],
				})
				return {
					getEntrypoint() {
						return {
							async evaluate(invocation: {
								token: string
								params: Record<string, unknown>
							}) {
								const bridge = code.env?.BRIDGE
								if (!bridge) {
									throw new Error('missing python capability bridge')
								}
								const echoed = await bridge.call(
									invocation.token,
									'echo',
									invocation.params,
								)
								return { result: echoed, logs: ['ran'], cpuMs: 3 }
							},
						}
					},
				}
			},
		},
	} as unknown as Env
	const registry = {
		capabilityHandlers: {
			echo: async (args: Record<string, unknown>) => ({ echoed: args }),
		},
	}
	const first = await runPythonExecute({
		env,
		callerContext,
		code: userSource,
		params: { n: 2 },
		capabilityRegistry: registry as never,
		bridgeExports,
	})
	const second = await runPythonExecute({
		env,
		callerContext,
		code: userSource,
		params: { n: 9 },
		capabilityRegistry: registry as never,
		bridgeExports,
	})
	expect(first.error).toBeUndefined()
	expect(first.result).toEqual({ echoed: { n: 2 } })
	expect(first.logs).toEqual(['ran'])
	expect(first.python).toMatchObject({
		backend: 'worker-loader',
		taxonomy: null,
		cpuMs: 3,
		codeChars: userSource.length,
	})
	expect(first.serverTiming[0]?.name).toBe('python-execute')
	expect(loaded).toHaveLength(2)
	expect(loaded[0]?.flags).toContain('python_workers')
	expect(loaded[0]?.name).toBe(loaded[1]?.name)
	expect(second.result).toEqual({ echoed: { n: 9 } })

	const missingMain = await runPythonExecute({
		env,
		callerContext,
		code: 'x = 1\n',
		capabilityRegistry: registry as never,
		bridgeExports,
	})
	expect(missingMain.python.taxonomy).toBe('contract')
	expect(missingMain.error).toBe(pythonExecuteContractMessage)

	const unknown = await runPythonExecute({
		env,
		callerContext,
		code: userSource,
		params: {},
		capabilityRegistry: {
			capabilityHandlers: {},
		} as never,
		bridgeExports,
	})
	expect(unknown.python.taxonomy).toBe('capability_misuse')
	expect(unknown.error).toContain('Unknown capability: echo')
})
