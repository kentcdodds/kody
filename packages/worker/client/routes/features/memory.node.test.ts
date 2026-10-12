import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { MemoryFeature } from './memory.tsx'

test('memory hero and update scene share one writing preference', async () => {
	const html = await renderToString(jsx(MemoryFeature, {}))

	expect(html).toContain('id="ms-hero-note"')
	expect(html).toContain('id="ms-updated-note"')
	expect(html).toContain('Lead with the decision. Keep updates short.')
	expect(html).toContain('id="ms-update"')
	expect(html).toContain('Make updates more detailed')
})
