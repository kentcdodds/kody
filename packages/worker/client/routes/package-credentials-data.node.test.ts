import { afterEach, expect, test, vi } from 'vitest'
import { loadPackageCredentialsPage } from './package-credentials-data.ts'

const detail = {
	ok: true,
	username: 'jane',
	kodyId: 'daily-digest',
	isPrivate: true,
	listing: null,
	ownerProfilePublic: true,
	viewerIsOwner: true,
	viewerCanManage: true,
	ownerPackage: {
		id: 'pkg-1',
		kodyId: 'daily-digest',
		name: 'daily-digest',
		description: 'Morning email digest',
		isPrivate: true,
		hasCommunityListing: false,
		publishedCommit: null,
	},
}

const view = {
	ok: true,
	package: { id: 'pkg-1', kodyId: 'daily-digest', canManage: true },
	needs: [],
	triggers: [],
	locked: [],
	incomplete: [],
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function stubFetch(responses: { detail: Response; view: Response }) {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input)
		return url.endsWith('/credentials.json')
			? responses.view.clone()
			: responses.detail.clone()
	})
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

const href = '/@jane/daily-digest/mappings'
const signal = new AbortController().signal

afterEach(() => {
	vi.unstubAllGlobals()
})

test('loads the chrome and the credentials view together', async () => {
	const fetchMock = stubFetch({ detail: json(detail), view: json(view) })
	const result = await loadPackageCredentialsPage(href, signal)
	expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
		'/profiles/jane/packages/daily-digest.json',
		'/profiles/jane/packages/daily-digest/credentials.json',
	])
	expect(result).toEqual({
		kind: 'data',
		data: {
			ok: true,
			shell: {
				username: 'jane',
				kodyId: 'daily-digest',
				name: 'daily-digest',
				description: 'Morning email digest',
				isPrivate: true,
				isListed: false,
				listingId: null,
				defaultBranch: null,
				publishedCommit: null,
				ownerProfilePublic: true,
				viewerCanManage: true,
			},
			view,
			viewError: null,
		},
	})
})

test('a credentials API failure keeps the chrome and reports the error', async () => {
	stubFetch({
		detail: json(detail),
		view: new Response('<html>oops</html>', { status: 500 }),
	})
	const result = await loadPackageCredentialsPage(href, signal)
	expect(result.kind === 'data' && result.data.ok && result.data).toMatchObject(
		{
			view: null,
			viewError: 'Kody could not load this package’s credentials (HTTP 500).',
		},
	)

	stubFetch({
		detail: json(detail),
		view: json({ ok: false, error: 'Package source is missing.' }, 400),
	})
	const withMessage = await loadPackageCredentialsPage(href, signal)
	expect(
		withMessage.kind === 'data' && withMessage.data.ok && withMessage.data,
	).toMatchObject({ view: null, viewError: 'Package source is missing.' })
})

test('signed-out viewers go to login and come back to the tab', async () => {
	stubFetch({ detail: json({ ok: false }, 401), view: json({}, 401) })
	expect(await loadPackageCredentialsPage(`${href}?x=1`, signal)).toEqual({
		kind: 'redirect',
		to: `/login?redirectTo=${encodeURIComponent(`${href}?x=1`)}`,
	})
})

test('a moved package redirects to the same tab at its new path', async () => {
	for (const viewStatus of [404, 401]) {
		stubFetch({
			detail: json({ ok: false, redirectTo: '/@acme/daily-digest' }, 404),
			view: json({ ok: false }, viewStatus),
		})
		expect(await loadPackageCredentialsPage(href, signal)).toEqual({
			kind: 'redirect',
			to: '/@acme/daily-digest/mappings',
		})
	}
})

test('viewers outside the package org get not found', async () => {
	const notFound = { kind: 'data', data: { ok: false, notFound: true } }
	stubFetch({
		detail: json({ ...detail, viewerIsOwner: false }),
		view: json({ ok: false }, 404),
	})
	expect(await loadPackageCredentialsPage(href, signal)).toEqual(notFound)

	expect(
		await loadPackageCredentialsPage('/@jane/-/credentials', signal),
	).toEqual(notFound)
})

test('readers without run access keep the chrome and learn why', async () => {
	stubFetch({ detail: json(detail), view: json({ ok: false }, 404) })
	const result = await loadPackageCredentialsPage(href, signal)
	expect(result.kind === 'data' && result.data.ok && result.data).toMatchObject(
		{ view: null, viewError: expect.stringContaining('not run it') },
	)
})

test('a credentials network failure keeps the chrome', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).endsWith('/credentials.json')) {
				throw new TypeError('Failed to fetch')
			}
			return json(detail)
		}),
	)
	const result = await loadPackageCredentialsPage(href, signal)
	expect(result.kind === 'data' && result.data.ok && result.data).toMatchObject(
		{
			shell: { name: 'daily-digest' },
			view: null,
			viewError: expect.stringContaining('could not reach the server'),
		},
	)
})
