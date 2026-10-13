import { afterEach, expect, test, vi } from 'vitest'
import {
	commitLastUsedOrgAfterPrefetchAdopt,
	lastUsedOrgCommitApiPath,
	orgAccountApiFetchInit,
	resetOrgAccountPrefetchCookieState,
} from '#client/org-account-api.ts'
import { accountJobsRouteLoader } from '#client/routes/account-jobs-shared.ts'
import { accountSecretsRouteLoader } from '#client/routes/account-secrets-shared.ts'
import { orgAccountClientLoaders } from '#client/routes/org-account-routes.tsx'
import { orgOwnedAccountApiSection } from '#universal/org-pages.ts'
import { prefetchRouteOnIntent } from './intent-prefetch.ts'

afterEach(() => {
	vi.unstubAllGlobals()
	resetOrgAccountPrefetchCookieState()
})

test('prefetch AbortSignal marks X-Kody-Prefetch; adopt commits that page only', async () => {
	const fetchMock = stubBrowser({ ok: true })
	const acme = 'https://kody.test/@acme/-/waiting'
	const other = 'https://kody.test/@other/-/waiting'
	prefetchRouteOnIntent(
		'/@acme/-/waiting',
		async (_url, signal) => {
			fetch('/account/waiting.json', orgAccountApiFetchInit(acme, signal))
			return {}
		},
		new URL(acme),
	)
	prefetchRouteOnIntent(
		'/@other/-/waiting',
		async (_url, signal) => {
			fetch('/account/waiting.json', orgAccountApiFetchInit(other, signal))
			return {}
		},
		new URL(other),
	)
	await Promise.resolve()
	expect(fetchMock).toHaveBeenCalled()
	const prefetchInit = fetchMock.mock.calls[0]?.[1]
	expect(prefetchInit?.headers).toMatchObject({ 'X-Kody-Prefetch': '1' })

	fetchMock.mockClear()
	// Adopting a different page must not consume acme's pending cookie write.
	commitLastUsedOrgAfterPrefetchAdopt('/account')
	expect(fetchMock).not.toHaveBeenCalled()

	const navigation = new AbortController()
	commitLastUsedOrgAfterPrefetchAdopt('/@acme/-/waiting', navigation.signal)
	await Promise.resolve()
	expect(fetchMock).toHaveBeenCalledWith(
		lastUsedOrgCommitApiPath,
		expect.objectContaining({
			referrer: acme,
			credentials: 'include',
		}),
	)
	const commitInit = fetchMock.mock.calls[0]?.[1]
	expect(commitInit?.headers).toEqual({ Accept: 'application/json' })
	// Cookie write must not ride the navigation AbortSignal: a follow-up hop
	// would abort it and drop last-used for an org page already opened.
	expect(commitInit?.signal).toBeUndefined()

	fetchMock.mockClear()
	commitLastUsedOrgAfterPrefetchAdopt('/@acme/-/waiting', navigation.signal)
	expect(fetchMock).not.toHaveBeenCalled()
})

test('query-bearing settings prefetch key matches adopt', async () => {
	const fetchMock = stubBrowser({ ok: true })
	const settings = 'https://kody.test/@acme/-/settings?tab=members'
	prefetchRouteOnIntent(
		'/@acme/-/settings?tab=members',
		async (_url, signal) => {
			fetch('/@acme/-/settings.json', orgAccountApiFetchInit(settings, signal))
			return {}
		},
		new URL(settings),
	)
	await Promise.resolve()
	fetchMock.mockClear()
	commitLastUsedOrgAfterPrefetchAdopt('/@acme/-/settings?tab=members')
	expect(fetchMock).toHaveBeenCalledWith(
		lastUsedOrgCommitApiPath,
		expect.objectContaining({ referrer: settings }),
	)
})

test('adopt commits last-used via dedicated path for Connections pages', async () => {
	const fetchMock = stubBrowser({ ok: true })
	const connections = 'https://kody.test/@acme/-/agents'
	prefetchRouteOnIntent(
		'/@acme/-/agents',
		async (_url, signal) => {
			fetch(
				'/account/connected-agents.json',
				orgAccountApiFetchInit(connections, signal),
			)
			return {}
		},
		new URL(connections),
	)
	await Promise.resolve()
	fetchMock.mockClear()
	commitLastUsedOrgAfterPrefetchAdopt('/@acme/-/agents')
	expect(fetchMock).toHaveBeenCalledWith(
		lastUsedOrgCommitApiPath,
		expect.objectContaining({
			referrer: connections,
			credentials: 'include',
		}),
	)
})

test('aborted navigation does not commit last-used org', async () => {
	const fetchMock = stubBrowser({ ok: true })
	const destination = 'https://kody.test/@acme/-/secrets'
	prefetchRouteOnIntent(
		'/@acme/-/secrets',
		async (_url, signal) => {
			fetch(
				'/account/secrets.json',
				orgAccountApiFetchInit(destination, signal),
			)
			return {}
		},
		new URL(destination),
	)
	await Promise.resolve()
	fetchMock.mockClear()
	const navigation = new AbortController()
	navigation.abort()
	commitLastUsedOrgAfterPrefetchAdopt('/@acme/-/secrets', navigation.signal)
	expect(fetchMock).not.toHaveBeenCalled()
})

test('a real navigation signal overlapping prefetch is not marked prefetch', () => {
	stubBrowser({ ok: true })
	const navigation = new AbortController()
	const init = orgAccountApiFetchInit(
		'https://kody.test/@acme/-/secrets',
		navigation.signal,
	)
	expect(init.headers).toEqual({ Accept: 'application/json' })
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

// Every org route loader, from the client route table: each org-owned
// `/account/<section>.json` load names the destination page, so a new section
// cannot bind the org being left.
test('every org route loader names the destination org page as referrer', async () => {
	const fetchMock = stubBrowser({ ok: true })
	const wrongReferrers: Array<string> = []
	let orgOwnedFetches = 0
	for (const [pattern, loader] of Object.entries(orgAccountClientLoaders)) {
		if (!pattern.startsWith('/@:orgSlug/-/')) continue
		const destination = `https://kody.test${pattern
			.replace(/\(.*?\)/g, '')
			.replace(':orgSlug', 'acme')
			.replace(/:\w+/g, 'x')}?q=1`
		fetchMock.mockClear()
		await loader(new URL(destination), new AbortController().signal).catch(
			() => null,
		)
		for (const [input, init] of fetchMock.mock.calls) {
			const path = new URL(String(input), 'https://kody.test').pathname
			const section = orgOwnedAccountApiSection(path)
			if (!section) continue
			orgOwnedFetches += 1
			if (init?.referrer !== destination) {
				wrongReferrers.push(`${pattern} → ${path}: ${init?.referrer}`)
			}
		}
	}
	expect(orgOwnedFetches).toBeGreaterThan(0)
	expect(wrongReferrers).toEqual([])
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
