import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import {
	buildKodyOfficialGuideUrlForTest,
	kodyOfficialGuideCapability,
	kodyOfficialGuideCatalog,
} from './kody-official-guide.ts'
import { withMswNodeServer } from '#worker/test-support/msw-node-server.ts'

const ctx = {
	env: {} as Env,
	callerContext: {
		baseUrl: 'https://kody.example',
		user: null,
	},
}

test('kody_official_guide fetches markdown and surfaces fetch failures', async () => {
	const url = buildKodyOfficialGuideUrlForTest('package_subscriptions')
	await withMswNodeServer(
		[
			http.get(url, () =>
				HttpResponse.text('# Hello\n\nbody', {
					headers: { 'content-type': 'text/markdown' },
				}),
			),
		],
		async () => {
			const result = await kodyOfficialGuideCapability.handler(
				{ guide: 'package_subscriptions' },
				ctx,
			)
			expect(result.body).toBe('# Hello\n\nbody')
			expect(result.title).toBe(
				kodyOfficialGuideCatalog.package_subscriptions.title,
			)
		},
	)

	await withMswNodeServer(
		[
			http.get(buildKodyOfficialGuideUrlForTest('connect_secret'), () =>
				HttpResponse.text('missing', { status: 404 }),
			),
		],
		async () => {
			await expect(
				kodyOfficialGuideCapability.handler({ guide: 'connect_secret' }, ctx),
			).rejects.toThrow(/Kody guide fetch failed: HTTP 404/)
		},
	)

	await withMswNodeServer(
		[
			http.get(buildKodyOfficialGuideUrlForTest('generated_ui_oauth'), () =>
				HttpResponse.error(),
			),
		],
		async () => {
			await expect(
				kodyOfficialGuideCapability.handler(
					{ guide: 'generated_ui_oauth' },
					ctx,
				),
			).rejects.toThrow(/Kody guide fetch failed: Failed to fetch/)
		},
	)
})
