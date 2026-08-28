import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	dispatchUserEmailOutboundPausedSubscriptionEvent: vi.fn(async () => []),
}))

vi.mock('./outbound-paused-package-subscriptions.ts', () => ({
	dispatchUserEmailOutboundPausedSubscriptionEvent:
		mocks.dispatchUserEmailOutboundPausedSubscriptionEvent,
}))

const { applyOutboundEmailAbusePause } = await import('./outbound-abuse.ts')

test('outbound pause notify does not wait for package fan-out when waitUntil is provided', async () => {
	consoleWarn.mockImplementation(() => {})
	mocks.dispatchUserEmailOutboundPausedSubscriptionEvent.mockImplementationOnce(
		() => new Promise(() => {}),
	)
	const first = vi.fn().mockResolvedValue({
		username: 'ada',
		email: 'ada@example.com',
	})
	const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
	const prepare = vi.fn((sql: string) => {
		if (sql.includes('email_outbound_paused_at')) {
			return { bind: () => ({ run }) }
		}
		return { bind: () => ({ first }) }
	})
	const waitUntil = vi.fn()
	const env = {
		APP_DB: { prepare },
		APP_BASE_URL: 'https://kody.codes',
		BUNDLE_ARTIFACTS_KV: {},
	} as unknown as Env

	await expect(
		applyOutboundEmailAbusePause({
			env,
			userId: 'user-1',
			deliveryStatus: 'complained',
			eventRecorded: true,
			waitUntil,
		}),
	).resolves.toEqual({ paused: true })
	expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise))
	expect(consoleWarn).toHaveBeenCalledWith('email-outbound-paused', {
		deliveryStatus: 'complained',
	})
	consoleWarn.mockReset()
})
