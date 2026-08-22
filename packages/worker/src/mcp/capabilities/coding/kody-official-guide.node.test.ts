import { expect, test } from 'vitest'
import {
	kodyOfficialGuideCapability,
	loadOfficialGuide,
} from './kody-official-guide.ts'
import { appWorkerGuidePath } from '@kody-internal/shared/app-worker.ts'
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

test('coding_guide_get loads the body from APP_SURFACE when bound', async () => {
	const guide = guides[0]
	if (!guide) throw new Error('expected at least one bundled guide')
	const requested: Array<string> = []
	const env = {
		APP_SURFACE: {
			fetch: async (request: Request) => {
				requested.push(new URL(request.url).pathname)
				return Response.json({
					title: 'Surface title',
					body: '# Surface body',
				})
			},
		},
	} as unknown as Env

	await expect(loadOfficialGuide({ guideId: guide.id, env })).resolves.toEqual({
		title: 'Surface title',
		body: '# Surface body',
	})
	expect(requested).toEqual([appWorkerGuidePath(guide.id)])
})
