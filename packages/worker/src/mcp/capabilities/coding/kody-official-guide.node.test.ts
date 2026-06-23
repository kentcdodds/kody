import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import {
	buildKodyOfficialGuideUrlForTest,
	kodyOfficialGuideCapability,
} from './kody-official-guide.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'

const ctx = {
	env: {} as Env,
	callerContext: {
		baseUrl: 'https://kody.example',
		user: null,
	},
}

test('kody_official_guide fetches markdown and surfaces fetch failures', async () => {
	const url = buildKodyOfficialGuideUrlForTest('package_subscriptions')
	{
		using _server = createMswNodeServer([
			http.get(url, () =>
				HttpResponse.text('# Hello\n\nbody', {
					headers: { 'content-type': 'text/markdown' },
				}),
			),
		])
		const result = await kodyOfficialGuideCapability.handler(
			{ guide: 'package_subscriptions' },
			ctx,
		)
		expect(result.body).toBe('# Hello\n\nbody')
	}

	{
		using _server = createMswNodeServer([
			http.get(buildKodyOfficialGuideUrlForTest('connect_secret'), () =>
				HttpResponse.text('missing', { status: 404 }),
			),
		])
		await expect(
			kodyOfficialGuideCapability.handler({ guide: 'connect_secret' }, ctx),
		).rejects.toThrow(/Kody guide fetch failed: HTTP 404/)
	}

	{
		using _server = createMswNodeServer([
			http.get(buildKodyOfficialGuideUrlForTest('generated_ui_oauth'), () =>
				HttpResponse.error(),
			),
		])
		await expect(
			kodyOfficialGuideCapability.handler({ guide: 'generated_ui_oauth' }, ctx),
		).rejects.toThrow(/Kody guide fetch failed: Failed to fetch/)
	}
})
