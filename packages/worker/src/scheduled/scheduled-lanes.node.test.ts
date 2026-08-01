import { expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	reconcileMailboxParity: vi.fn(),
}))

vi.mock('#worker/email/mailbox-reconcile.ts', () => ({
	reconcileMailboxParity: mocks.reconcileMailboxParity,
}))

const { getScheduledLanes, runScheduledLane } =
	await import('./scheduled-lanes.ts')

test('getScheduledLanes includes mailbox_parity on every cron tick', () => {
	const env = {} as Env

	for (const scheduledAt of [
		new Date('2026-07-05T10:00:30.000Z'),
		new Date('2026-07-05T10:05:00.000Z'),
		new Date('2026-07-05T10:30:00.000Z'),
	]) {
		expect(getScheduledLanes({ env, scheduledAt })).toContain('mailbox_parity')
	}
})

test('runScheduledLane dispatches mailbox_parity through reconcileMailboxParity', async () => {
	const env = {} as Env
	const scheduledAt = new Date('2026-07-05T10:00:00.000Z')
	mocks.reconcileMailboxParity.mockResolvedValueOnce({ compared: 0 })

	await runScheduledLane({ env, lane: 'mailbox_parity', scheduledAt })

	expect(mocks.reconcileMailboxParity).toHaveBeenCalledWith({
		env,
		now: scheduledAt,
	})
})
