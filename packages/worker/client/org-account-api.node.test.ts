import { afterEach, expect, test, vi } from 'vitest'
import { accountJobsRouteLoader } from '#client/routes/account-jobs-shared.ts'
import { accountSecretsRouteLoader } from '#client/routes/account-secrets-shared.ts'

afterEach(() => {
	vi.unstubAllGlobals()
})

function stubBrowser(body: unknown, status = 200) {
	vi.stubGlobal('window', { location: { origin: 'https://kody.test' } })
	const fetchMock = vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify(body), {
				status,
				headers: { 'Content-Type': 'application/json' },
			}),
	)
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

// A client navigation from another org: the loader runs before the URL
// commits, so the default Referer would name the source org.
test('the secrets loader names the destination org page as referrer', async () => {
	const fetchMock = stubBrowser({ ok: true, secrets: [] })
	await accountSecretsRouteLoader(
		new URL('https://kody.test/@acme/-/secrets?q=api'),
		new AbortController().signal,
	)
	expect(fetchMock).toHaveBeenCalledWith(
		'/account/secrets.json?q=api',
		expect.objectContaining({
			referrer: 'https://kody.test/@acme/-/secrets?q=api',
		}),
	)
})

test('the jobs loader names the destination org page as referrer', async () => {
	const fetchMock = stubBrowser({ ok: true, jobs: [] })
	await accountJobsRouteLoader(
		new URL('https://kody.test/@acme/-/jobs'),
		new AbortController().signal,
	)
	expect(fetchMock).toHaveBeenCalledWith(
		'/account/jobs.json',
		expect.objectContaining({
			referrer: 'https://kody.test/@acme/-/jobs',
		}),
	)
})

test('a denied org is an error, and a signed-out load goes to login', async () => {
	stubBrowser({ ok: false, error: 'Organization not found.' }, 404)
	await expect(
		accountSecretsRouteLoader(
			new URL('https://kody.test/@ghost/-/secrets'),
			new AbortController().signal,
		),
	).rejects.toThrow('Unable to load your secrets.')
	await expect(
		accountJobsRouteLoader(
			new URL('https://kody.test/@ghost/-/jobs'),
			new AbortController().signal,
		),
	).rejects.toThrow('Unable to load scheduled jobs.')

	stubBrowser({ ok: false }, 401)
	await expect(
		accountJobsRouteLoader(
			new URL('https://kody.test/@acme/-/jobs'),
			new AbortController().signal,
		),
	).resolves.toMatchObject({ to: '/login' })
})
