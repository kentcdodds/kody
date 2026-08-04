import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import {
	collectHealthComponents,
	createHealthComponentsHandler,
	healthComponentIds,
	type HealthComponentsReport,
} from '#app/handlers/health-components.ts'

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

test('collectHealthComponents reports every component healthy with latency', async () => {
	const report = await collectHealthComponents(createHealthyBindings())

	expect(report.ok).toBe(true)
	expect(report.commitSha).toBe('abc123')
	expect(report.components.map((component) => component.id)).toEqual([
		...healthComponentIds,
	])
	for (const component of report.components) {
		expect(component.ok).toBe(true)
		expect(component.latencyMs).toBeGreaterThanOrEqual(0)
		expect(component.error).toBeUndefined()
	}
})

test('collectHealthComponents marks a throwing binding as failed without failing the rest', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
	try {
		const bindings = createHealthyBindings()
		bindings.APP_DB = {
			prepare: () => ({
				first: async () => {
					throw new Error('database is unavailable')
				},
			}),
		} as unknown as D1Database
		const report = await collectHealthComponents(bindings)

		expect(report.ok).toBe(false)
		const appDb = report.components.find(
			(component) => component.id === 'app_db',
		)
		expect(appDb).toMatchObject({ ok: false, error: 'error' })
		const others = report.components.filter(
			(component) => component.id !== 'app_db',
		)
		for (const component of others) {
			expect(component.ok).toBe(true)
		}
	} finally {
		warnSpy.mockRestore()
	}
})

test('collectHealthComponents marks missing bindings as unavailable', async () => {
	const report = await collectHealthComponents({
		APP_COMMIT_SHA: undefined,
	})

	expect(report.ok).toBe(false)
	expect(report.commitSha).toBeNull()
	for (const component of report.components) {
		expect(component).toMatchObject({ ok: false, error: 'unavailable' })
	}
})

test('handler returns 200 when healthy and memoizes results within the cache window', async () => {
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
})

test('concurrent requests at cache expiry share one in-flight collection', async () => {
	let prepareCalls = 0
	let releaseFirst: (() => void) | undefined
	const gate = new Promise<void>((resolve) => {
		releaseFirst = resolve
	})
	const bindings = createHealthyBindings()
	bindings.APP_DB = {
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
	const handler = createHealthComponentsHandler(bindings)

	const first = handler.handler(createRequestContext())
	const second = handler.handler(createRequestContext())
	releaseFirst?.()
	const [firstResponse, secondResponse] = await Promise.all([first, second])

	expect(firstResponse.status).toBe(200)
	expect(secondResponse.status).toBe(200)
	expect(prepareCalls).toBe(1)
})

test('handler returns 503 when any component fails', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
	try {
		const bindings = createHealthyBindings()
		bindings.OAUTH_KV = {
			get: async () => {
				throw new Error('kv is down')
			},
		} as unknown as KVNamespace
		const handler = createHealthComponentsHandler(bindings)

		const response = await handler.handler(createRequestContext())

		expect(response.status).toBe(503)
		const body = (await response.json()) as HealthComponentsReport
		expect(body.ok).toBe(false)
		const kv = body.components.find((component) => component.id === 'kv')
		expect(kv).toMatchObject({ ok: false, error: 'error' })
	} finally {
		warnSpy.mockRestore()
	}
})
