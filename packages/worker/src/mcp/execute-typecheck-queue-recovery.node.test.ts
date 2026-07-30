import { expect, test, vi } from 'vitest'
import { type LoadedKodyGraphPackages } from '#worker/package-runtime/module-graph-import-rewriting.ts'

const compilerMock = vi.hoisted(() => {
	let resolveFirstService: ((service: unknown) => void) | undefined
	let creationCount = 0
	const createService = () => {
		const files = new Map<string, string>()
		return {
			fileSystem: {
				read: (path: string) => files.get(path) ?? null,
				write: (path: string, content: string) => files.set(path, content),
				delete: (path: string) => files.delete(path),
				list: (prefix?: string) =>
					[...files.keys()].filter(
						(path) => prefix === undefined || path.startsWith(prefix),
					),
				flush: async () => undefined,
			},
			languageService: {
				getSyntacticDiagnostics: () => [],
				getSemanticDiagnostics: () => [],
				dispose: vi.fn(),
			},
		}
	}
	return {
		createTypescriptLanguageService: vi.fn(() => {
			creationCount += 1
			if (creationCount === 1) {
				return new Promise((resolve) => {
					resolveFirstService = resolve
				})
			}
			return Promise.resolve(createService())
		}),
		resolveFirst() {
			resolveFirstService?.(createService())
		},
	}
})

vi.mock('@cloudflare/worker-bundler/typescript', () => ({
	createTypescriptLanguageService: compilerMock.createTypescriptLanguageService,
}))

import {
	assertAdHocExecuteTypechecks,
	ExecuteTypecheckError,
} from './execute-typecheck.ts'

test('a cancelled typecheck holder cannot strand the isolate queue', async () => {
	vi.useFakeTimers()
	const input = {
		source: 'export default function main() { return "ok" }',
		packages: new Map() as LoadedKodyGraphPackages,
	}

	const cancelled = assertAdHocExecuteTypechecks(input)
	await vi.waitFor(() => {
		expect(compilerMock.createTypescriptLanguageService).toHaveBeenCalledTimes(
			1,
		)
	})
	// Model workerd cancelling the request context: its timers and continuation
	// disappear, while isolate module state survives for the next request.
	vi.clearAllTimers()

	const blocked = assertAdHocExecuteTypechecks(input)
	const blockedExpectation = expect(blocked).rejects.toSatisfy(
		(error: unknown) => {
			expect(error).toBeInstanceOf(ExecuteTypecheckError)
			expect((error as Error).message).toContain('queue budget')
			return true
		},
	)
	await vi.advanceTimersByTimeAsync(10_001)
	await blockedExpectation

	await expect(assertAdHocExecuteTypechecks(input)).resolves.toBeDefined()

	compilerMock.resolveFirst()
	await expect(cancelled).resolves.toBeDefined()
	vi.useRealTimers()
})
