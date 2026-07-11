import { afterEach, beforeEach, vi, type MockInstance } from 'vitest'

// Epic Stack-style console guard. Tests fail loudly when code under test
// calls console.error/console.warn unless the test opts in with
// `consoleError.mockImplementation(() => {})` (and can then assert on the
// calls). console.info/console.debug are operational logging and are silenced
// by default; assert on the exported spies when a test cares about them.
export let consoleError: MockInstance<(typeof console)['error']>
export let consoleWarn: MockInstance<(typeof console)['warn']>
export let consoleInfo: MockInstance<(typeof console)['info']>
export let consoleDebug: MockInstance<(typeof console)['debug']>

const originalError = console.error.bind(console)
const originalWarn = console.warn.bind(console)

function failOnUnexpectedCall(
	method: 'error' | 'warn',
	original: (...args: Array<unknown>) => void,
) {
	return (...args: Array<unknown>) => {
		original(...args)
		throw new Error(
			`Unexpected console.${method} call. If this is expected, import console${
				method === 'error' ? 'Error' : 'Warn'
			} from #worker/test-support/console-spies.ts, call .mockImplementation(() => {}) in the test, and assert on the calls.`,
		)
	}
}

// For tests that exercise paths with known operational warnings/errors that
// are incidental to the behavior under test: swallow exactly the expected
// messages and fail on anything else, so silencing can never hide a new
// unexpected log. Prefer asserting on the spy directly when the message
// itself is part of the tested contract.
function silenceExpectedCalls(
	method: 'error' | 'warn',
	spy: () => MockInstance<(...args: Array<unknown>) => void>,
	patterns: Array<RegExp | string>,
) {
	spy().mockImplementation((...args: Array<unknown>) => {
		const [first] = args
		if (
			typeof first === 'string' &&
			patterns.some((pattern) =>
				typeof pattern === 'string' ? pattern === first : pattern.test(first),
			)
		) {
			return
		}
		throw new Error(
			`Unexpected console.${method} call (not in this test's expected-message allowlist): ${String(first)}`,
		)
	})
}

export function silenceExpectedConsoleWarns(patterns: Array<RegExp | string>) {
	silenceExpectedCalls('warn', () => consoleWarn, patterns)
}

export function silenceExpectedConsoleErrors(patterns: Array<RegExp | string>) {
	silenceExpectedCalls('error', () => consoleError, patterns)
}

beforeEach(() => {
	consoleError = vi
		.spyOn(console, 'error')
		.mockImplementation(failOnUnexpectedCall('error', originalError))
	consoleWarn = vi
		.spyOn(console, 'warn')
		.mockImplementation(failOnUnexpectedCall('warn', originalWarn))
	consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
	consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => {})
})

// vitest-shared.ts enables clearMocks/mockReset but not restoreMocks, so
// restore these spies explicitly to hand the real console methods back
// between tests instead of leaving spy wrappers installed.
afterEach(() => {
	consoleError.mockRestore()
	consoleWarn.mockRestore()
	consoleInfo.mockRestore()
	consoleDebug.mockRestore()
})
