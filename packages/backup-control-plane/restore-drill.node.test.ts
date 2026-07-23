import assert from 'node:assert/strict'

import { test } from 'vitest'

import { BackupError } from './backup-policy.ts'
import { ACCOUNT_ID, environment } from './backup-control-plane-test-support.ts'
import { assertDrillAccountIsolated } from './restore-drill.ts'

test('restore drill refuses to run when DRILL_ACCOUNT_ID equals SOURCE_ACCOUNT_ID', () => {
	const env = environment()
	env.DRILL_ACCOUNT_ID = ACCOUNT_ID
	assert.throws(
		() => assertDrillAccountIsolated(env),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'drill-account-not-isolated',
	)
})

test('restore drill accepts an isolated drill account', () => {
	const env = environment()
	assert.doesNotThrow(() => assertDrillAccountIsolated(env))
})
