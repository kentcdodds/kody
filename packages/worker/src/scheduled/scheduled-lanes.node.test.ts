import { expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	reconcileMailboxParity: vi.fn(),
}))

vi.mock('#worker/email/mailbox-reconcile.ts', () => ({
	reconcileMailboxParity: mocks.reconcileMailboxParity,
}))

const { getScheduledLanes, runScheduledLane, shouldRunMailboxParityCron } =
	await import('./scheduled-lanes.ts')

test('shouldRunMailboxParityCron gates to the top of each UTC hour', () => {
	expect(shouldRunMailboxParityCron(new Date('2026-07-05T10:00:30.000Z'))).toBe(
		true,
	)
	expect(shouldRunMailboxParityCron(new Date('2026-07-05T10:05:00.000Z'))).toBe(
		false,
	)
	expect(shouldRunMailboxParityCron(new Date('2026-07-05T10:30:00.000Z'))).toBe(
		false,
	)
})

test('getScheduledLanes includes mailbox_parity only on the hourly gate', () => {
	const env = {} as Env

	expect(
		getScheduledLanes({
			env,
			scheduledAt: new Date('2026-07-05T10:00:30.000Z'),
		}),
	).toContain('mailbox_parity')
	expect(
		getScheduledLanes({
			env,
			scheduledAt: new Date('2026-07-05T10:30:00.000Z'),
		}),
	).not.toContain('mailbox_parity')
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
