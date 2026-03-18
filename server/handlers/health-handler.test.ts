/// <reference types="bun" />
import { expect, test } from 'bun:test'
import { RequestContext } from 'remix/fetch-router'
import { createHealthHandler } from './health.ts'

function createHealthRequestContext() {
	return new RequestContext(new Request('https://example.com/health'))
}

test('health handler returns ok with null commit SHA when unset', async () => {
	const handler = createHealthHandler({ APP_COMMIT_SHA: undefined })

	const response = await handler.action(createHealthRequestContext())

	expect(response.status).toBe(200)
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	expect(response.headers.get('X-App-Commit-Sha')).toBe('unknown')
	await expect(response.json()).resolves.toEqual({ ok: true, commitSha: null })
})

test('health handler returns the configured commit SHA', async () => {
	const handler = createHealthHandler({
		APP_COMMIT_SHA: 'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e',
	})

	const response = await handler.action(createHealthRequestContext())

	expect(response.status).toBe(200)
	expect(response.headers.get('X-App-Commit-Sha')).toBe(
		'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e',
	)
	await expect(response.json()).resolves.toEqual({
		ok: true,
		commitSha: 'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e',
	})
})
