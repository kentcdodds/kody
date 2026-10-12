import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { PackagesFeature } from './packages.tsx'

test('packages workbench keeps example source available without JavaScript', async () => {
	const html = await renderToString(jsx(PackagesFeature, {}))

	expect(html).toContain('id="package-source-fallback"')
	expect(html).toMatch(
		/<noscript>[\s\S]*README\.md[\s\S]*src\/brief\.ts[\s\S]*<\/noscript>/,
	)
	expect(html).toContain('Collect the project updates I choose')
})
