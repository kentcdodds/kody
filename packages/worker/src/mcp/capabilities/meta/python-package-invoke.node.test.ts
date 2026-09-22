import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as AccessControlModule from '#mcp/capabilities/access-control.ts'

const mockModule = vi.hoisted(() => ({
	pythonEnabled: false,
	runPythonExecute: vi.fn(),
}))

vi.mock(
	'#mcp/capabilities/access-control.ts',
	async (importOriginal: () => Promise<typeof AccessControlModule>) => {
		const actual = await importOriginal()
		return {
			...actual,
			resolveCallerFeatureFlags: async () => ({
				'python-execute': mockModule.pythonEnabled,
			}),
			assertCallerCanAccessCapability: async () => {
				if (!mockModule.pythonEnabled) {
					throw new Error(
						'MCP user lacks required feature flag "python-execute" for capability "pythonPackageInvoke".',
					)
				}
			},
		}
	},
)

vi.mock('#mcp/python-execute/run-python-execute.ts', () => ({
	runPythonExecute: (...args: Array<unknown>) =>
		mockModule.runPythonExecute(...args),
}))

const { pythonPackageInvokeCapability } =
	await import('./python-package-invoke.ts')

const callerContext = createMcpCallerContext({
	baseUrl: 'https://example.com',
	user: {
		userId: 'user-python',
		email: 'python@example.com',
		displayName: 'Python',
	},
})

const manifest = {
	name: 'csv-stats',
	language: 'python' as const,
	exports: {
		summarize:
			'def main(params):\n    return {"rows": len(params.get("rows", []))}\n',
	},
}

test('pythonPackageInvoke stays hidden until the experiment flag is on, then runs the chosen export', async () => {
	expect(pythonPackageInvokeCapability.featureFlag).toBe('python-execute')
	mockModule.pythonEnabled = false
	await expect(
		pythonPackageInvokeCapability.handler(
			{ manifest, export: 'summarize' },
			{ env: {} as Env, callerContext },
		),
	).rejects.toThrow(
		'MCP user lacks required feature flag "python-execute" for capability "pythonPackageInvoke".',
	)
	expect(mockModule.runPythonExecute).not.toHaveBeenCalled()

	mockModule.pythonEnabled = true
	mockModule.runPythonExecute.mockResolvedValueOnce({
		result: { rows: 2 },
		logs: [],
		python: {
			backend: 'worker-loader',
			codeChars: manifest.exports.summarize.length,
			elapsedMs: 5,
			cpuMs: null,
			taxonomy: null,
			workerId: 'kody-pkg',
		},
		serverTiming: [],
	})
	const result = await pythonPackageInvokeCapability.handler(
		{
			manifest,
			export: 'summarize',
			params: { rows: [{ sku: 'a' }, { sku: 'b' }] },
		},
		{ env: {} as Env, callerContext },
	)
	expect(result).toMatchObject({
		ok: true,
		exportName: 'summarize',
		result: { rows: 2 },
		taxonomy: null,
	})
	expect(mockModule.runPythonExecute).toHaveBeenCalledWith(
		expect.objectContaining({
			code: manifest.exports.summarize,
			params: { rows: [{ sku: 'a' }, { sku: 'b' }] },
		}),
	)
})
