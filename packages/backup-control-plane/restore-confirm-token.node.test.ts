import assert from 'node:assert/strict'

import { test } from 'vitest'

import { BackupError } from './backup-policy.ts'
import { environment } from './backup-control-plane-test-support.ts'
import {
	issueRestoreConfirmToken,
	verifyRestoreConfirmToken,
} from './restore-confirm-token.ts'

test('restore confirm token accepts valid tokens and rejects expired or tampered ones', async () => {
	const env = environment()
	const now = new Date('2026-07-22T12:00:00.000Z')
	const issued = await issueRestoreConfirmToken(env, '2026-07-22', now)
	await verifyRestoreConfirmToken(env, issued, now)

	await assert.rejects(
		verifyRestoreConfirmToken(
			env,
			issued,
			new Date(now.valueOf() + 11 * 60 * 1000),
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'restore-confirm-expired',
	)

	await assert.rejects(
		verifyRestoreConfirmToken(
			env,
			{ ...issued, token: `${issued.token.slice(0, -2)}aa` },
			now,
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'restore-confirm-invalid',
	)

	await assert.rejects(
		verifyRestoreConfirmToken(env, { ...issued, day: '2026-07-21' }, now),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'restore-confirm-invalid',
	)
})
