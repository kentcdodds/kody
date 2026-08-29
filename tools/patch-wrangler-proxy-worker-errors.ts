/**
 * Keep `wrangler dev` alive when one proxied request fails.
 *
 * Wrangler 4.114+ treats `Error inside ProxyWorker` as fatal, so a transient
 * `Network connection lost` (unread `request.clone()` tee, idle keep-alive
 * race, or isolate kill) exits the process. Playwright then fail-fasts the
 * rest of the suite (workers-sdk#14926 / #15203). Upstream #15207 and #15252
 * keep that error request-scoped; they are not in a released wrangler yet.
 *
 * This rewrite adds the same exemption wrangler already uses for other
 * ProxyController disconnects. Drop it when a released wrangler logs the
 * error without exiting (see the Cleanup issue on the introducing PR).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

export const wranglerProxyWorkerErrorReason = 'Error inside ProxyWorker'

export const patchedProxyControllerExemption = `event.source === "ProxyController" && (event.reason === "${wranglerProxyWorkerErrorReason}" || event.reason.startsWith("Failed to send message to")`

const fullDevEnvExemption =
	'event.source === "ProxyController" && (event.reason.startsWith("Failed to send message to") || event.reason.startsWith("Could not connect to InspectorProxyWorker"))'

const apiDevEnvExemption =
	'event.source === "ProxyController" && event.reason.startsWith("Failed to send message to")'

const patchedFullDevEnvExemption = `event.source === "ProxyController" && (event.reason === "${wranglerProxyWorkerErrorReason}" || event.reason.startsWith("Failed to send message to") || event.reason.startsWith("Could not connect to InspectorProxyWorker"))`

const patchedApiDevEnvExemption = `event.source === "ProxyController" && (event.reason === "${wranglerProxyWorkerErrorReason}" || event.reason.startsWith("Failed to send message to"))`

export type PatchWranglerProxyWorkerErrorsResult =
	| { status: 'already-present' }
	| { status: 'patched'; replacements: number }
	| { status: 'missing-bundle'; cliPath: string }

export function defaultWranglerCliPath(repoRoot = process.cwd()) {
	return path.join(
		repoRoot,
		'node_modules',
		'wrangler',
		'wrangler-dist',
		'cli.js',
	)
}

export function rewriteWranglerProxyWorkerErrors(source: string) {
	if (source.includes(patchedProxyControllerExemption)) {
		return { status: 'already-present' as const, source, replacements: 0 }
	}

	let next = source
	let replacements = 0
	if (next.includes(fullDevEnvExemption)) {
		next = next.replaceAll(fullDevEnvExemption, patchedFullDevEnvExemption)
		replacements += 1
	}
	if (next.includes(apiDevEnvExemption)) {
		next = next.replaceAll(apiDevEnvExemption, patchedApiDevEnvExemption)
		replacements += 1
	}

	if (replacements === 0) {
		throw new Error(
			'Could not find wrangler ProxyController handleErrorEvent exemptions to patch. ' +
				'Inspect node_modules/wrangler/wrangler-dist/cli.js for handleErrorEvent. ' +
				'If a released wrangler already keeps Error inside ProxyWorker non-fatal, ' +
				'delete tools/patch-wrangler-proxy-worker-errors.ts. ' +
				'Otherwise update the rewrite for the new bundle. ' +
				'See workers-sdk#14926, #15207, and #15252.',
		)
	}

	return { status: 'patched' as const, source: next, replacements }
}

export function patchWranglerProxyWorkerErrors(
	cliPath = defaultWranglerCliPath(),
): PatchWranglerProxyWorkerErrorsResult {
	if (!existsSync(cliPath)) {
		return { status: 'missing-bundle', cliPath }
	}

	const original = readFileSync(cliPath, 'utf8')
	const rewritten = rewriteWranglerProxyWorkerErrors(original)
	if (rewritten.status === 'already-present') {
		return { status: 'already-present' }
	}
	if (rewritten.source !== original) {
		writeFileSync(cliPath, rewritten.source)
	}
	return { status: 'patched', replacements: rewritten.replacements }
}

export function main() {
	const result = patchWranglerProxyWorkerErrors()
	if (result.status === 'missing-bundle') {
		console.warn(
			`Skipping wrangler ProxyWorker patch; missing ${result.cliPath}`,
		)
		return
	}
	if (result.status === 'patched') {
		console.log(
			`Patched wrangler ProxyWorker errors as non-fatal (${result.replacements} handleErrorEvent site(s)).`,
		)
	}
}

if (isExecutedDirectly(import.meta.url)) {
	main()
}
