import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { FeaturesOverview } from './overview.tsx'

test('features overview gives every primitive card an interactive widget', async () => {
	const html = await renderToString(jsx(FeaturesOverview, {}))

	expect(html.match(/data-primitive="/g)).toHaveLength(6)
	expect(html.match(/class="pw pw-/g)).toHaveLength(6)
	for (const id of [
		'memory',
		'secrets',
		'packages',
		'triggers',
		'integrations',
		'apps',
	]) {
		expect(html).toContain(`data-primitive="${id}"`)
		expect(html).toContain(`href="/features/${id}"`)
	}
	expect(html).toContain('aria-pressed="true"')
	expect(html).toContain('aria-pressed="false"')
	expect(html).not.toContain('data-motion')
})
