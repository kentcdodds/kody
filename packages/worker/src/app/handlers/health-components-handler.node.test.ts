import { expect, test } from 'vitest'
import { RequestContext } from 'remix/router'
import {
	collectHealthComponents,
	createHealthComponentsHandler,
	healthComponentIds,
	type HealthComponentsReport,
} from '#app/handlers/health-components.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

function createHealthyBindings() {
	return {
		APP_COMMIT_SHA: 'abc123',
		APP_DB: {
			prepare: () => ({ first: async () => ({ 1: 1 }) }),
		} as unknown as D1Database,
		AUDIT_DB: {
			prepare: () => ({ first: async () => ({ 1: 1 }) }),
		} as unknown as D1Database,
		OAUTH_KV: { get: async () => null } as unknown as KVNamespace,
		COMMUNITY_ASSETS: { head: async () => null } as unknown as R2Bucket,
	}
}

function createRequestContext() {
	return new RequestContext(
		new Request('https://example.com/health/components'),
	)
}

test('collectHealthComponents reports healthy, failed, and unavailable bindings', async () => {
	const healthy = await collectHealthComponents(createHealthyBindings())
	expect(healthy.ok).toBe(true)
	expect(healthy.commitSha).toBe('abc123')
	expect(healthy.components.map((component) => component.id)).toEqual([
		...healthComponentIds,
	])
	for (const component of healthy.components) {
		expect(component.ok).toBe(true)
		expect(component.latencyMs).toBeGreaterThanOrEqual(0)
		expect(component.error).toBeUndefined()
	}

	consoleWarn.mockImplementation(() => {})
	const bindings = createHealthyBindings()
	bindings.APP_DB = {
		prepare: () => ({
			first: async () => {
				throw new Error('database is unavailable')
			},
		}),
	} as unknown as D1Database
	const failed = await collectHealthComponents(bindings)
	expect(failed.ok).toBe(false)
	expect(
		failed.components.find((component) => component.id === 'app_db'),
	).toMatchObject({ ok: false, error: 'error' })
	for (const component of failed.components.filter(
		(entry) => entry.id !== 'app_db',
	)) {
		expect(component.ok).toBe(true)
	}
	expect(consoleWarn).toHaveBeenCalledWith(
		'health-component-failed',
		expect.any(String),
	)

	const missing = await collectHealthComponents({
		APP_COMMIT_SHA: undefined,
	})
	expect(missing.ok).toBe(false)
	expect(missing.commitSha).toBeNull()
	for (const component of missing.components) {
		expect(component).toMatchObject({ ok: false, error: 'unavailable' })
	}
})

test('D1 checks retry transient blips but fail fast on other errors', async () => {
	let auditAttempts = 0
	const bindings = createHealthyBindings()
	bindings.AUDIT_DB = {
		prepare: () => ({
			first: async () => {
				auditAttempts += 1
				if (auditAttempts === 1) {
					throw new Error('D1_ERROR: Network connection lost.')
				}
				return { 1: 1 }
			},
		}),
	} as unknown as D1Database
	const recovered = await collectHealthComponents(bindings)
	expect(auditAttempts).toBe(2)
	expect(recovered.ok).toBe(true)
	expect(
		recovered.components.find((component) => component.id === 'audit_db'),
	).toMatchObject({ ok: true })

	consoleWarn.mockImplementation(() => {})
	let appAttempts = 0
	const failingBindings = createHealthyBindings()
	failingBindings.APP_DB = {
		prepare: () => ({
			first: async () => {
				appAttempts += 1
				throw new Error('no such table: users')
			},
		}),
	} as unknown as D1Database
	const failed = await collectHealthComponents(failingBindings)
	expect(appAttempts).toBe(1)
	expect(failed.ok).toBe(false)
	expect(
		failed.components.find((component) => component.id === 'app_db'),
	).toMatchObject({ ok: false, error: 'error' })

	let persistentAttempts = 0
	const persistentBindings = createHealthyBindings()
	persistentBindings.AUDIT_DB = {
		prepare: () => ({
			first: async () => {
				persistentAttempts += 1
				throw new Error('D1_ERROR: Network connection lost.')
			},
		}),
	} as unknown as D1Database
	const persistent = await collectHealthComponents(persistentBindings)
	expect(persistentAttempts).toBe(3)
	expect(persistent.ok).toBe(false)
	expect(
		persistent.components.find((component) => component.id === 'audit_db'),
	).toMatchObject({ ok: false, error: 'error' })
})

test('health components handler memoizes, coalesces in-flight work, and returns 503 on failure', async () => {
	let prepareCalls = 0
	const bindings = createHealthyBindings()
	bindings.APP_DB = {
		prepare: () => {
			prepareCalls += 1
			return { first: async () => ({ 1: 1 }) }
		},
	} as unknown as D1Database
	const handler = createHealthComponentsHandler(bindings)

	const first = await handler.handler(createRequestContext())
	const second = await handler.handler(createRequestContext())
	expect(first.status).toBe(200)
	expect(first.headers.get('Cache-Control')).toBe('no-store')
	expect(second.status).toBe(200)
	expect(prepareCalls).toBe(1)
	const body = (await first.json()) as HealthComponentsReport
	expect(body.ok).toBe(true)
	expect(body.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

	let releaseFirst: (() => void) | undefined
	const gate = new Promise<void>((resolve) => {
		releaseFirst = resolve
	})
	prepareCalls = 0
	const concurrentBindings = createHealthyBindings()
	concurrentBindings.APP_DB = {
		prepare: () => {
			prepareCalls += 1
			return {
				first: async () => {
					await gate
					return { 1: 1 }
				},
			}
		},
	} as unknown as D1Database
	const concurrentHandler = createHealthComponentsHandler(concurrentBindings)
	const firstInFlight = concurrentHandler.handler(createRequestContext())
	const secondInFlight = concurrentHandler.handler(createRequestContext())
	releaseFirst?.()
	const [firstResponse, secondResponse] = await Promise.all([
		firstInFlight,
		secondInFlight,
	])
	expect(firstResponse.status).toBe(200)
	expect(secondResponse.status).toBe(200)
	expect(prepareCalls).toBe(1)

	consoleWarn.mockImplementation(() => {})
	const failingBindings = createHealthyBindings()
	failingBindings.OAUTH_KV = {
		get: async () => {
			throw new Error('kv is down')
		},
	} as unknown as KVNamespace
	const failingHandler = createHealthComponentsHandler(failingBindings)
	const response = await failingHandler.handler(createRequestContext())
	expect(response.status).toBe(503)
	const failedBody = (await response.json()) as HealthComponentsReport
	expect(failedBody.ok).toBe(false)
	expect(
		failedBody.components.find((component) => component.id === 'kv'),
	).toMatchObject({ ok: false, error: 'error' })
	expect(consoleWarn).toHaveBeenCalledWith(
		'health-component-failed',
		expect.any(String),
	)
})
