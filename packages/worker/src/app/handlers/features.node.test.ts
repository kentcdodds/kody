import { expect, test } from 'vitest'
import { createLegacyFeatureCredentialsRedirectHandler } from './features.ts'

test('retired secrets and integrations feature pages redirect to credentials', async () => {
	const handler = createLegacyFeatureCredentialsRedirectHandler({} as Env)
	for (const path of ['/features/secrets', '/features/integrations?ref=x']) {
		const response = await handler.handler({
			request: new Request(`https://kody.test${path}`),
			params: {},
		} as never)
		expect(response.status).toBe(301)
		expect(response.headers.get('Location')).toBe(
			`/features/credentials${new URL(`https://kody.test${path}`).search}`,
		)
	}
})
