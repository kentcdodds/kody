import { expect, test, vi } from 'vitest'
import { type LoadedKodyGraphPackages } from '#worker/package-runtime/module-graph-import-rewriting.ts'

const compilerMock = vi.hoisted(() => {
	const stalledServiceResolvers: Array<(service: unknown) => void> = []
	let creationCount = 0
	let stallNextCreation = true
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
			if (stallNextCreation) {
				stallNextCreation = false
				return new Promise((resolve) => {
					stalledServiceResolvers.push(resolve)
				})
			}
			return Promise.resolve(createService())
		}),
		stallNext() {
			stallNextCreation = true
		},
		resolveStalled() {
			for (const resolve of stalledServiceResolvers) {
				resolve(createService())
			}
		},
		getCreationCount() {
			return creationCount
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

test('cancelled typecheck holders cannot strand the queue or exhaust its slots', async () => {
	vi.useFakeTimers()
	const input = {
		source: 'export default function main() { return "ok" }',
		packages: new Map() as LoadedKodyGraphPackages,
	}
	const cancelledCalls: Array<Promise<unknown>> = []

	for (let cycle = 1; cycle <= 5; cycle += 1) {
		if (cycle > 1) compilerMock.stallNext()
		cancelledCalls.push(assertAdHocExecuteTypechecks(input))
		await vi.waitFor(() => {
			expect(compilerMock.getCreationCount()).toBe(cycle)
		})
		// Model workerd cancelling the request context: its timers and
		// continuation disappear, while isolate module state survives.
		vi.clearAllTimers()

		const blocked = assertAdHocExecuteTypechecks(input)
		const blockedExpectation = expect(blocked).rejects.toSatisfy(
			(error: unknown) => {
				expect(error).toBeInstanceOf(ExecuteTypecheckError)
				expect((error as Error).message).toContain('queue budget')
				return true
			},
		)
		await vi.advanceTimersByTimeAsync(12_001)
		await blockedExpectation
	}

	await expect(assertAdHocExecuteTypechecks(input)).resolves.toBeDefined()

	compilerMock.resolveStalled()
	await expect(Promise.all(cancelledCalls)).resolves.toBeDefined()
	vi.useRealTimers()
})
