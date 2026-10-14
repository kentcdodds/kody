import { afterEach, expect, test, vi } from 'vitest'
import { loadApprovalBundle } from './approval-bundle.tsx'

const href = '/@acme/-/approvals/bundle-1'
const signal = new AbortController().signal

function respond(body: unknown, status: number) {
	const fetchMock = vi.fn(
		async () => new Response(JSON.stringify(body), { status }),
	)
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

afterEach(() => {
	vi.unstubAllGlobals()
})

test('the bundle loads from its JSON API', async () => {
	const view = { ok: true, bundle: { id: 'bundle-1' }, groups: [] }
	const fetchMock = respond(view, 200)
	expect(await loadApprovalBundle(href, signal)).toEqual({
		kind: 'data',
		data: { ok: true, view },
	})
	expect(fetchMock).toHaveBeenCalledWith(
		'/@acme/-/approvals/bundle-1.json',
		expect.objectContaining({ credentials: 'include' }),
	)
})

test('signed-out viewers log in and come back to the bundle', async () => {
	respond({ ok: false }, 401)
	expect(await loadApprovalBundle(href, signal)).toEqual({
		kind: 'redirect',
		to: `/login?redirectTo=${encodeURIComponent(href)}`,
	})
})

test('someone else’s bundle is not found, and an old one is expired', async () => {
	respond({ ok: false }, 404)
	expect(await loadApprovalBundle(href, signal)).toEqual({
		kind: 'data',
		data: { ok: false, reason: 'not-found' },
	})
	respond({ ok: false, reason: 'expired' }, 410)
	expect(await loadApprovalBundle(href, signal)).toEqual({
		kind: 'data',
		data: { ok: false, reason: 'expired' },
	})
})

test('other failures throw', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('<html></html>', { status: 500 })),
	)
	await expect(loadApprovalBundle(href, signal)).rejects.toThrow(
		'Kody could not load these approvals (HTTP 500).',
	)
})
