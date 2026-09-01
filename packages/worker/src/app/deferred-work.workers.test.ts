import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { deferWork, runWithDeferredWork } from '#app/deferred-work.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

test('deferred work resolves after the response and is kept alive by waitUntil', async () => {
	const ctx = createExecutionContext()
	const order = new Array<string>()
	let release = () => {}
	const blocked = new Promise<void>((resolve) => {
		release = resolve
	})

	const response = await runWithDeferredWork(
		(promise) => ctx.waitUntil(promise),
		async () => {
			void deferWork('deferred-work-test', async () => {
				await blocked
				order.push('work')
			})
			order.push('response')
			return new Response('ok')
		},
	)

	expect(response.status).toBe(200)
	expect(order).toEqual(['response'])

	release()
	await waitOnExecutionContext(ctx)
	expect(order).toEqual(['response', 'work'])
})

test('deferred work still runs and swallows failures without a sink', async () => {
	consoleWarn.mockImplementation(() => {})

	await expect(
		deferWork('deferred-work-test', async () => {
			throw new Error('boom')
		}),
	).resolves.toBeUndefined()
	expect(consoleWarn).toHaveBeenCalledWith(
		'deferred-work-test',
		expect.any(Error),
	)
})
