import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { FeaturesOverview } from './overview.tsx'

test('features overview gives every primitive card an interactive widget', async () => {
	const html = await renderToString(jsx(FeaturesOverview, {}))

	expect(html).toMatch(/data-primitive="/)
	expect(html).toMatch(/class="pw pw-/)
	expect(html).toMatch(/href="\/features\//)
	expect(html).toContain('aria-pressed="true"')
	expect(html).toContain('aria-pressed="false"')
	expect(html).not.toContain('data-motion')
})
