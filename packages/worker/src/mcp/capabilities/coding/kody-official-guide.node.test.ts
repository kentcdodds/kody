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

test('codingGuideGet serves every bundled guide without frontmatter', async () => {
	expect(guides.length).toBeGreaterThan(0)
	for (const guide of guides) {
		const result = await kodyOfficialGuideCapability.handler(
			{ guide: guide.id },
			ctx,
		)
		expect(result.title).toBe(guide.title)
		// Body is served without the frontmatter block. Oversized guides
		// return a contents index instead of the full authored markdown.
		expect(result.body.startsWith('#')).toBe(true)
		expect(result.body).not.toContain('\n---\nid:')
		expect(result.body.length).toBeGreaterThan(200)
		if (guide.body.length > 24_000) {
			expect(result.bodyMode).toBe('toc')
			expect(result.body).toContain('## Contents')
			expect(result.body).not.toBe(guide.body)
		} else {
			expect(result.bodyMode).toBe('full')
			expect(result.body).toBe(guide.body)
		}
	}

	const section = await kodyOfficialGuideCapability.handler(
		{ guide: 'package_subscriptions', section: 'repo.pushed' },
		ctx,
	)
	expect(section.bodyMode).toBe('section')
	expect(section.section?.slug).toBe('repo.pushed')
	expect(section.body).toContain('type RepoPushedEvent')
	expect(section.body).not.toContain('type FleetEntitlementCrossedEvent')
})
