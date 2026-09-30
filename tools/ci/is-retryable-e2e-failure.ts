import { readFileSync } from 'node:fs'
import { isExecutedDirectly } from '../node-runtime.ts'

const ansiEscapePattern = new RegExp(`${'\u001b'}\\[[0-9;]*m`, 'g')

/**
 * Playwright prints this when `webServer.command` exits before `/health`
 * is reachable. No tests ran. Safe to retry once — a real config bug
 * fails the second attempt too. Covers the Vite
 * `ReferenceError: __LOAD__ is not defined` runner-worker crash during
 * Cloudflare live export-type inspection (Validate #36669175020). Do not
 * match `__LOAD__` alone: a recovered first start plus a later genuine
 * assertion failure must not retry the suite.
 */
const e2eWebServerStartFailurePattern =
	/Process from config\.webServer was not able to start/

const midSuiteWebServerDeathPatterns = [
	/E2eWebServerDeadError/,
	/ECONNREFUSED (?:127\.0\.0\.1|localhost):3847/,
	/ERR_CONNECTION_REFUSED at https?:\/\/(?:127\.0\.0\.1|localhost):3847/,
] as const

function stripE2eLogAnsi(text: string) {
	return text.replace(ansiEscapePattern, '')
}

export function isRetryableE2eFailure(logText: string) {
	const text = stripE2eLogAnsi(logText)
	if (midSuiteWebServerDeathPatterns.some((pattern) => pattern.test(text))) {
		return true
	}
	return e2eWebServerStartFailurePattern.test(text)
}

export function main(args = process.argv.slice(2)) {
	const logPath = args[0]
	if (!logPath) {
		console.error(
			'Usage: node tools/ci/is-retryable-e2e-failure.ts <e2e-attempt-log>',
		)
		process.exitCode = 1
		return
	}
	try {
		process.exitCode = isRetryableE2eFailure(readFileSync(logPath, 'utf8'))
			? 0
			: 1
	} catch {
		process.exitCode = 1
	}
}

if (isExecutedDirectly(import.meta.url)) {
	main()
}
