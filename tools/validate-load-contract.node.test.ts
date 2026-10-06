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

/** Quoted commands inside the leading `concurrently …` phase (before the serial `&&` tail). */
function concurrentValidateLegs(validate: string) {
	const lastAnd = validate.lastIndexOf('&&')
	expect(lastAnd).toBeGreaterThan(0)
	const concurrentPortion = validate.slice(0, lastAnd)
	expect(concurrentPortion).toMatch(/^concurrently\b/)
	const legs = [...concurrentPortion.matchAll(/"([^"]+)"/g)].map(
		(match) => match[1]!,
	)
	expect(legs.length).toBeGreaterThan(10)
	return { concurrentPortion, legs, serialTail: validate.slice(lastAnd + 2) }
}

test('validate runs worker-startup-time:check only after the parallel phase', () => {
	const validate = readValidateScript()
	const { concurrentPortion, serialTail } = concurrentValidateLegs(validate)
	expect(serialTail.trim()).toBe('npm run worker-startup-time:check')
	expect(concurrentPortion).not.toContain('worker-startup-time:check')
	expect(concurrentPortion).toContain('worker-startup-bundles:check')
})

test('validate runs skills-lock and markdown file-ref checks in the parallel phase', () => {
	const validate = readValidateScript()
	const { legs, serialTail } = concurrentValidateLegs(validate)
	expect(legs).toContain('npm run skills-lock:check')
	expect(legs).toContain('npm run docs:check-file-refs')
	expect(serialTail).not.toContain('skills-lock:check')
	expect(serialTail).not.toContain('docs:check-file-refs')
})

test('validate sets KODY_VALIDATE_LOAD=1 on the test-workers leg only', () => {
	const validate = readValidateScript()
	const { legs, serialTail } = concurrentValidateLegs(validate)
	// Whole-script once: catches `KODY_VALIDATE_LOAD=1 concurrently …` inheritance.
	expect(validate.match(/KODY_VALIDATE_LOAD=1/g)).toHaveLength(1)
	const loadLegs = legs.filter((leg) => /\bKODY_VALIDATE_LOAD=/.test(leg))
	expect(loadLegs).toEqual(['CI=1 KODY_VALIDATE_LOAD=1 npm run test:workers'])
	expect(serialTail).not.toMatch(/\bKODY_VALIDATE_LOAD=/)
})
