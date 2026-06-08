import { expect, test } from 'vitest'
import { RequestContext } from 'remix/router'
import { createHealthHandler } from '#app/handlers/health.ts'

function createHealthRequestContext() {
	return new RequestContext(new Request('https://example.com/health'))
}

test('health handler reports cache and commit SHA metadata for unset and configured builds', async () => {
	const scenarios = [
		{
			appCommitSha: undefined,
			headerCommitSha: 'unknown',
			bodyCommitSha: null,
		},
		{
			appCommitSha: 'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e',
			headerCommitSha: 'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e',
			bodyCommitSha: 'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e',
		},
	] as const

	for (const scenario of scenarios) {
		const handler = createHealthHandler({
			APP_COMMIT_SHA: scenario.appCommitSha,
		})
		const response = await handler.handler(createHealthRequestContext())

		expect(response.status).toBe(200)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(response.headers.get('X-App-Commit-Sha')).toBe(
			scenario.headerCommitSha,
		)
		expect(await response.json()).toEqual({
			ok: true,
			commitSha: scenario.bodyCommitSha,
		})
	}
})
