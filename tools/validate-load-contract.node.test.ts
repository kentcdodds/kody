import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

/**
 * #2475: under full-parallel Cloud Agent `npm run validate`, startup CPU and
 * workers-unit (mcp-auth) flaked from contention. The durable fixes are:
 * - `worker-startup-time:check` after the concurrent phase (#2872)
 * - `KODY_VALIDATE_LOAD=1` on the test-workers leg only (#2944 / #2939)
 * Do not move the CPU check back into concurrently or drop the load flag.
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function readValidateScript() {
	const packageJson = JSON.parse(
		readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
	) as { scripts?: { validate?: string } }
	const validate = packageJson.scripts?.validate
	expect(typeof validate).toBe('string')
	return validate as string
}

test('validate runs worker-startup-time:check only after the parallel phase', () => {
	const validate = readValidateScript()
	expect(validate).toMatch(/&&\s*npm run worker-startup-time:check\s*$/)
	const concurrentPortion = validate.slice(0, validate.lastIndexOf('&&'))
	expect(concurrentPortion).not.toContain('worker-startup-time:check')
	expect(concurrentPortion).toContain('worker-startup-bundles:check')
})

test('validate sets KODY_VALIDATE_LOAD=1 on the test-workers leg only', () => {
	const validate = readValidateScript()
	expect(validate).toContain('CI=1 KODY_VALIDATE_LOAD=1 npm run test:workers')
	expect(validate).not.toMatch(/KODY_VALIDATE_LOAD=1\s+npm run test:node/)
	expect(validate).not.toMatch(/KODY_VALIDATE_LOAD=1\s+npm run test:e2e/)
	expect(validate).not.toMatch(/KODY_VALIDATE_LOAD=1\s+npm run test:mcp/)
})
