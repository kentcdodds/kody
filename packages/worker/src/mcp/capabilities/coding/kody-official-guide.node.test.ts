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

test('coding_guide_get serves every bundled guide and rejects unknown ids', async () => {
	// Stable ids agents already rely on must keep resolving.
	for (const id of [
		'package_authoring',
		'package_lifecycle',
		'integration_bootstrap',
		'oauth',
		'connect_secret',
		'platform_friction',
	]) {
		const guide = guides.find((entry) => entry.id === id)
		expect(guide, `catalog is missing guide id "${id}"`).toBeDefined()
	}

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

	// Unknown ids are rejected by the enum input schema before the handler.
	await expect(
		kodyOfficialGuideCapability.handler({ guide: 'does_not_exist' }, ctx),
	).rejects.toThrow(/Invalid option/)
})
