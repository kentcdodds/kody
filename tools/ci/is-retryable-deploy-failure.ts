import { readFileSync } from 'node:fs'
import { isExecutedDirectly } from '../node-runtime.ts'

const ansiEscapePattern = new RegExp(`${'\u001b'}\\[[0-9;]*m`, 'g')

/**
 * Cloudflare upload and secret-bulk failures that are worth a bounded retry.
 * 10021 (startup CPU) is treated as retryable because production uploads of
 * the same script often pass on the next attempt; persistent over-limit
 * still fails after the workflow's attempt budget. Wrangler "Received a
 * malformed response from the API" is the same edge flake class as
 * `isRetryableCloudflareApiError` in resource-utils — including a 200 on
 * GET /deployments whose JSON body is truncated. Secret-bulk 5xx stays
 * covered even when that wrangler phrase is absent.
 */
const retryableDeployFailurePatterns = [
	/workflows\.api\.error\.internal_server/i,
	/Cloudflare API[\s\S]*\[code:\s*10001\]/i,
	/Cloudflare API[\s\S]*\[code:\s*10021\]/i,
	/Script startup exceeded CPU time limit/i,
	/Received a malformed response from the API/i,
	/upstream connect error or disconnect\/reset/i,
	/Secrets failed to upload[\s\S]*-> 5\d\d/i,
	// Preview runtime uploads (~19MB) hit Cloudflare gateway timeouts on
	// GET .../deployments; production already retries these via wrangler, but
	// the outer workflow retry must recognize them too (#3512).
	/504 Gateway Timeout/i,
	/Gateway Timeout/i,
	/-> 504\b/i,
] as const

function stripDeployLogAnsi(text: string) {
	return text.replace(ansiEscapePattern, '')
}

export function isRetryableDeployFailure(logText: string) {
	const text = stripDeployLogAnsi(logText)
	return retryableDeployFailurePatterns.some((pattern) => pattern.test(text))
}

export function main(args = process.argv.slice(2)) {
	const logPath = args[0]
	if (!logPath) {
		console.error(
			'Usage: node tools/ci/is-retryable-deploy-failure.ts <deploy-log>',
		)
		process.exitCode = 1
		return
	}
	try {
		process.exitCode = isRetryableDeployFailure(readFileSync(logPath, 'utf8'))
			? 0
			: 1
	} catch {
		process.exitCode = 1
	}
}

if (isExecutedDirectly(import.meta.url)) {
	main()
}
