import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { openapiSpecSummarizeCapability } from './openapi-spec-summarize.ts'

const ctx = {
	env: {} as Env,
	callerContext: {
		baseUrl: 'https://kody.example',
		user: null,
	},
}

const JSON_SPEC_URL = 'https://provider.example/openapi.json'

test('openapi_spec_summarize surfaces fetch failures without response body content', async () => {
	using _server = createMswNodeServer([
		http.get(JSON_SPEC_URL, () =>
			HttpResponse.json(
				{ secretLeak: 'should-not-appear-in-error' },
				{ status: 502 },
			),
		),
	])

	await expect(
		openapiSpecSummarizeCapability.handler({ specUrl: JSON_SPEC_URL }, ctx),
	).rejects.toThrow(/HTTP 502/)

	await expect(
		openapiSpecSummarizeCapability.handler({ specUrl: JSON_SPEC_URL }, ctx),
	).rejects.not.toThrow(/should-not-appear-in-error/)
})
