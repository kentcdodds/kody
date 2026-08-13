import { expect, test } from 'vitest'
import { isRuntimeWorkerOwnedRequest } from '#worker/runtime-worker-routing.ts'

const packageAppOrigin = 'https://kodyapps.dev'

function request(url: string) {
	return new Request(url)
}

function env(input: { packageAppBaseUrl?: string } = {}) {
	return {
		PACKAGE_APP_BASE_URL: input.packageAppBaseUrl,
	} as Env
}

test('runtime-owned requests include package-app apex, user subdomains, and app-origin package paths', () => {
	const production = env({ packageAppBaseUrl: packageAppOrigin })

	expect(
		isRuntimeWorkerOwnedRequest(request(`${packageAppOrigin}/`), production),
	).toBe(true)
	expect(
		isRuntimeWorkerOwnedRequest(
			request('https://kentcdodds.kodyapps.dev/packages/hn-pulse'),
			production,
		),
	).toBe(true)
	expect(
		isRuntimeWorkerOwnedRequest(
			request(
				'https://kentcdodds.kodyapps.dev/packages/hn-pulse?__kody_handoff=token',
			),
			production,
		),
	).toBe(true)
	// Wildcard DNS still delivers nested/invalid labels; runtime owns the 404.
	expect(
		isRuntimeWorkerOwnedRequest(
			request('https://a.b.kodyapps.dev/packages/hn-pulse'),
			production,
		),
	).toBe(true)
	expect(
		isRuntimeWorkerOwnedRequest(
			request('https://heykody.app/@kentcdodds/packages/hn-pulse'),
			production,
		),
	).toBe(true)
	expect(
		isRuntimeWorkerOwnedRequest(
			request(
				'https://heykody.app/@kentcdodds/api/package-invocations/demo/run',
			),
			production,
		),
	).toBe(true)

	expect(
		isRuntimeWorkerOwnedRequest(
			request('https://heykody.app/account'),
			production,
		),
	).toBe(false)
	expect(
		isRuntimeWorkerOwnedRequest(
			request('https://heykody.app/login'),
			production,
		),
	).toBe(false)
})
