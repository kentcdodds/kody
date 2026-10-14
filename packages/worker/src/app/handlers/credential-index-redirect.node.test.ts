import { expect, test, vi } from 'vitest'
import { withCredentialIndexRedirect } from './credential-index-redirect.ts'

const call = (path: string) => {
	const inner = {
		middleware: [] as Array<never>,
		handler: vi.fn(async (_ctx: unknown) => new Response('section page')),
	}
	const wrapped = withCredentialIndexRedirect(inner)
	return {
		inner,
		response: wrapped.handler({
			request: new Request(`https://kody.test${path}`),
			params: { orgSlug: 'acme' },
		}),
	}
}

test('an old index page redirects to the Credentials list', async () => {
	const { inner, response } = call('/@acme/-/integrations?q=git')
	const res = await response
	expect(res.status).toBe(302)
	expect(res.headers.get('Location')).toBe(
		'/@acme/-/credentials?q=git&kind=oauth',
	)
	expect(inner.handler).not.toHaveBeenCalled()
})

test('deeper paths still reach the section handler', async () => {
	const { inner, response } = call('/@acme/-/secrets/approve?token=t')
	await expect((await response).text()).resolves.toBe('section page')
	expect(inner.handler).toHaveBeenCalledTimes(1)
})
