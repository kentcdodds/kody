import { expect, test } from 'vitest'
import {
	appWorkerGuidePath,
	appWorkerHealthPath,
} from '@kody-internal/shared/app-worker.ts'
import { getGuideById, guides } from '#worker/guides/catalog.ts'
import appWorker from './app-worker.ts'

const guide = guides[0]
if (!guide) throw new Error('expected at least one bundled guide')

function env(input: { fetch?: typeof fetch } = {}) {
	return {
		COOKIE_SECRET: 'LOCAL_AND_PREVIEW_COOKIE_SECRET_32_CHARS_MINIMUM',
		SECRET_STORE_KEY: 'LOCAL_TEST_SECRET_STORE_KEY_32_CHARS_MINIMUM_OK',
		APP_COMMIT_SHA: 'abc1234',
		ASSETS: {
			fetch: input.fetch ?? (async () => new Response(null, { status: 404 })),
		},
	} as unknown as Env
}

test('app worker health reports commit sha', async () => {
	const response = await appWorker.fetch(
		new Request(`https://kody-app.internal${appWorkerHealthPath}`),
		env(),
		{} as ExecutionContext,
	)
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		status: 'ok',
		commitSha: 'abc1234',
		cookieSecretConfigured: true,
	})
})

test('app worker serves official guide JSON for coding_guide_get', async () => {
	const bundled = getGuideById(guide.id)
	expect(bundled).not.toBeNull()
	const response = await appWorker.fetch(
		new Request(`https://kody-app.internal${appWorkerGuidePath(guide.id)}`),
		env(),
		{} as ExecutionContext,
	)
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		title: bundled?.title,
		body: bundled?.body,
	})
})

test('app worker 404s unknown official guides', async () => {
	const response = await appWorker.fetch(
		new Request(`https://kody-app.internal${appWorkerGuidePath('not-a-guide')}`),
		env(),
		{} as ExecutionContext,
	)
	expect(response.status).toBe(404)
})
