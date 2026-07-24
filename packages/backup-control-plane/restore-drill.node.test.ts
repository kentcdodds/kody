import assert from 'node:assert/strict'

import { test } from 'vitest'

import { BackupError } from './backup-policy.ts'
import { ACCOUNT_ID, environment } from './backup-control-plane-test-support.ts'
import { assertDrillAccountIsolated } from './restore-drill.ts'

test('restore drill refuses same account and accepts an isolated account', () => {
	const env = environment()
	env.DRILL_ACCOUNT_ID = ACCOUNT_ID
	assert.throws(
		() => assertDrillAccountIsolated(env),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'drill-account-not-isolated',
	)
	assert.doesNotThrow(() => assertDrillAccountIsolated(environment()))
})
