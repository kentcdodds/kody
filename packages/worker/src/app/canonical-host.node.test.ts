import { expect, test } from 'vitest'
import {
	isAllowedRequestHost,
	refuseNonCanonicalProductionHost,
} from '#app/canonical-host.ts'

const productionEnv = {
	SENTRY_ENVIRONMENT: 'production',
	APP_BASE_URL: 'https://kody.codes',
	PACKAGE_APP_BASE_URL: 'https://kody.run',
	APP_LEGACY_HOSTS: 'heykody.dev',
}

const workersDevHome = new Request(
	'https://kody-production.kody-a99.workers.dev/',
)
const workersDevHealth = new Request(
	'https://kody-production.kody-a99.workers.dev/health',
)
const workersDevPlatformHealth = new Request(
	'https://kody-platform.kody-a99.workers.dev/__platform/health',
)
const workersDevRuntimeHealth = new Request(
	'https://kody-runtime.kody-a99.workers.dev/__runtime/health',
)

async function expectNotFound(response: Response | null) {
	expect(response).not.toBeNull()
	expect(response?.status).toBe(404)
	expect(response?.headers.get('Cache-Control')).toBe('no-store')
	await expect(response?.json()).resolves.toEqual({ error: 'not_found' })
}

test('production refuses workers.dev except health probes, and accepts product hosts', async () => {
	expect(
		isAllowedRequestHost({
			request: new Request('https://kody.codes/mcp'),
			env: productionEnv,
		}),
	).toBe(true)
	expect(
		isAllowedRequestHost({
			request: new Request('https://KODY.CODES./login'),
			env: productionEnv,
		}),
	).toBe(true)
	expect(
		isAllowedRequestHost({
			request: new Request('https://heykody.dev/blog'),
			env: productionEnv,
		}),
	).toBe(true)
	expect(
		isAllowedRequestHost({
			request: new Request('https://kody.run/'),
			env: productionEnv,
		}),
	).toBe(true)
	expect(
		isAllowedRequestHost({
			request: new Request('https://kentcdodds.kody.run/packages/demo/'),
			env: productionEnv,
		}),
	).toBe(true)

	expect(
		isAllowedRequestHost({
			request: workersDevHome,
			env: productionEnv,
		}),
	).toBe(false)
	await expectNotFound(
		refuseNonCanonicalProductionHost({
			request: workersDevHome,
			env: productionEnv,
			allowedHealthPath: '/health',
		}),
	)
	await expectNotFound(
		refuseNonCanonicalProductionHost({
			request: new Request('https://kody-production.kody-a99.workers.dev/mcp'),
			env: productionEnv,
			allowedHealthPath: '/health',
		}),
	)
	await expectNotFound(
		refuseNonCanonicalProductionHost({
			request: new Request(
				'https://kody-production.kody-a99.workers.dev/health/components',
			),
			env: productionEnv,
			allowedHealthPath: '/health',
		}),
	)

	expect(
		refuseNonCanonicalProductionHost({
			request: workersDevHealth,
			env: productionEnv,
			allowedHealthPath: '/health',
		}),
	).toBeNull()
	expect(
		refuseNonCanonicalProductionHost({
			request: workersDevPlatformHealth,
			env: productionEnv,
			allowedHealthPath: '/__platform/health',
		}),
	).toBeNull()
	expect(
		refuseNonCanonicalProductionHost({
			request: workersDevRuntimeHealth,
			env: productionEnv,
			allowedHealthPath: '/__runtime/health',
		}),
	).toBeNull()
	await expectNotFound(
		refuseNonCanonicalProductionHost({
			request: workersDevRuntimeHealth,
			env: productionEnv,
			allowedHealthPath: '/health',
		}),
	)

	expect(
		refuseNonCanonicalProductionHost({
			request: workersDevHome,
			env: { ...productionEnv, SENTRY_ENVIRONMENT: 'preview' },
			allowedHealthPath: '/health',
		}),
	).toBeNull()
	expect(
		refuseNonCanonicalProductionHost({
			request: new Request('http://localhost:3742/'),
			env: { WRANGLER_IS_LOCAL_DEV: 'true', SENTRY_ENVIRONMENT: 'production' },
			allowedHealthPath: '/health',
		}),
	).toBeNull()
	expect(
		refuseNonCanonicalProductionHost({
			request: workersDevHome,
			env: { ...productionEnv, SENTRY_ENVIRONMENT: 'test' },
			allowedHealthPath: '/health',
		}),
	).toBeNull()
})
