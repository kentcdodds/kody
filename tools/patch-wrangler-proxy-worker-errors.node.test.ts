import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	defaultWranglerCliPath,
	patchWranglerProxyWorkerErrors,
	rewriteWranglerProxyWorkerErrors,
} from './patch-wrangler-proxy-worker-errors.ts'

const fullDevEnvBundle = `
handleErrorEvent(event) {
  if (event.source === "ProxyController" && (event.reason.startsWith("Failed to send message to") || event.reason.startsWith("Could not connect to InspectorProxyWorker"))) {
    logger.debug(event.reason)
  } else this.emit("error", event)
}
`

const apiDevEnvBundle = `
handleErrorEvent(event) {
  else if (event.source === "ProxyController" && event.reason.startsWith("Failed to send message to")) {
    logger.debug(event.reason)
  } else this.emit("error", event)
}
`

/** Independent oracle for the ProxyWorker exemption reason string. */
const proxyWorkerErrorReason = 'Error inside ProxyWorker'
const patchedExemptionNeedle = `event.reason === "${proxyWorkerErrorReason}"`

test('rewriteWranglerProxyWorkerErrors keeps ProxyWorker errors request-scoped', () => {
	const both = `${fullDevEnvBundle}\n${apiDevEnvBundle}`
	const first = rewriteWranglerProxyWorkerErrors(both)
	expect(first.status).toBe('patched')
	expect(first.replacements).toBe(2)
	expect(first.source).toContain(patchedExemptionNeedle)
	expect(first.source).toContain(
		`event.reason === "${proxyWorkerErrorReason}" || event.reason.startsWith("Failed to send message to") || event.reason.startsWith("Could not connect to InspectorProxyWorker")`,
	)
	expect(first.source).not.toContain(
		'event.source === "ProxyController" && event.reason.startsWith("Failed to send message to")',
	)

	const second = rewriteWranglerProxyWorkerErrors(first.source)
	expect(second.status).toBe('already-present')
	expect(second.source).toBe(first.source)
})

test('rewriteWranglerProxyWorkerErrors fails when the exemption sites disappear', () => {
	expect(() =>
		rewriteWranglerProxyWorkerErrors(
			'handleErrorEvent(event) { this.emit("error", event) }',
		),
	).toThrow(/workers-sdk#14926/)
})

test('patchWranglerProxyWorkerErrors writes the rewrite and is idempotent', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'kody-wrangler-patch-'))
	try {
		const cliPath = path.join(dir, 'cli.js')
		await writeFile(cliPath, `${fullDevEnvBundle}\n${apiDevEnvBundle}`)

		const first = patchWranglerProxyWorkerErrors(cliPath)
		expect(first).toEqual({ status: 'patched', replacements: 2 })
		const written = await readFile(cliPath, 'utf8')
		expect(written).toContain(patchedExemptionNeedle)

		const second = patchWranglerProxyWorkerErrors(cliPath)
		expect(second).toEqual({ status: 'already-present' })
		expect(await readFile(cliPath, 'utf8')).toBe(written)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('installed wrangler bundle still has a patchable or already-patched handleErrorEvent', () => {
	const result = patchWranglerProxyWorkerErrors(defaultWranglerCliPath())
	expect(result.status).not.toBe('missing-bundle')
	expect(['patched', 'already-present']).toContain(result.status)
})
