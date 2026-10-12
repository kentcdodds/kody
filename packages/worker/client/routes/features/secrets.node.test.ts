import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { SecretsFeature } from './secrets.tsx'

test('secrets feature page links to onboarding', async () => {
	const html = await renderToString(jsx(SecretsFeature, {}))

	expect(html).toContain('href="/onboarding"')
	expect(html).toContain('Connect your agent')
	expect(html.match(/href="\/onboarding"/g)?.length).toBeGreaterThanOrEqual(2)
})
