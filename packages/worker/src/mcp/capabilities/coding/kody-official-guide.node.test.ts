import { expect, test } from 'vitest'
import { kodyOfficialGuideCapability } from './kody-official-guide.ts'
import { guides } from '#worker/guides/catalog.ts'

const ctx = {
	env: {} as Env,
	callerContext: {
		baseUrl: 'https://kody.example',
		user: null,
	},
}

test('coding_guide_get serves every bundled guide without frontmatter', async () => {
	expect(guides.length).toBeGreaterThan(0)
	for (const guide of guides) {
		const result = await kodyOfficialGuideCapability.handler(
			{ guide: guide.id },
			ctx,
		)
		expect(result.title).toBe(guide.title)
		// Body is served without the frontmatter block and starts at the
		// authored heading.
		expect(result.body.startsWith('#')).toBe(true)
		expect(result.body).not.toContain('\n---\nid:')
		expect(result.body.length).toBeGreaterThan(200)
	}
})

test('coding_guide_get input schema lists advertised guides in the web catalog authored order', () => {
	const properties = kodyOfficialGuideCapability.inputSchema.properties as
		| Record<string, { description?: string }>
		| undefined
	const description = properties?.guide?.description ?? ''
	expect(description.length).toBeGreaterThan(0)

	const expectedOrder = guides
		.filter((guide) => !guide.unadvertised)
		.map((guide) => guide.id)
	expect(expectedOrder.length).toBeGreaterThan(0)

	const positions = expectedOrder.map((id) => description.indexOf(`\`${id}\`:`))
	expect(positions.every((position) => position !== -1)).toBe(true)
	expect(positions).toEqual([...positions].toSorted((a, b) => a - b))
})
