import { afterEach, expect, test, vi } from 'vitest'
import { loadCredentialApproval } from './package-credential-approval.tsx'

const href =
	'/@acme/digest/approve-credentials?default%5Bgithub%5D=org:acme-bot&reason=Hi'
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

test('the proposal query goes to the approval API unchanged', async () => {
	const view = { ok: true, changes: [], errors: [], fingerprint: 'fp' }
	const fetchMock = respond(view, 200)
	expect(await loadCredentialApproval(href, signal)).toEqual({
		kind: 'data',
		data: { ok: true, view },
	})
	expect(fetchMock).toHaveBeenCalledWith(
		'/profiles/acme/packages/digest/approve-credentials.json?default%5Bgithub%5D=org:acme-bot&reason=Hi',
		expect.objectContaining({ credentials: 'include' }),
	)
})

test('signed-out viewers log in and come back with the proposal', async () => {
	respond({ ok: false }, 401)
	expect(await loadCredentialApproval(href, signal)).toEqual({
		kind: 'redirect',
		to: `/login?redirectTo=${encodeURIComponent(href)}`,
	})
})

test('not found covers other paths and viewers without package:execute', async () => {
	const notFound = { kind: 'data', data: { ok: false, notFound: true } }
	respond({ ok: false }, 404)
	expect(await loadCredentialApproval(href, signal)).toEqual(notFound)
	expect(
		await loadCredentialApproval('/@acme/-/approve-credentials', signal),
	).toEqual(notFound)
})

test('other failures throw so the page offers a prompt for the agent', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('<html></html>', { status: 500 })),
	)
	await expect(loadCredentialApproval(href, signal)).rejects.toThrow(
		'Kody could not load this approval (HTTP 500).',
	)
})
