import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { pitrUnavailableCode } from './do-pitr.ts'
import {
	mailboxDurableObjectName,
	runLogDurableObjectName,
	storageRunnerDurableObjectName,
	userMeterDurableObjectName,
} from '#worker/user-scoped-durable-object-name.ts'

test('all user-scoped Durable Objects expose PITR RPCs and degrade clearly in local Workers', async () => {
	const userId = `pitr-${crypto.randomUUID()}`
	const objects = [
		env.MAILBOX.get(env.MAILBOX.idFromName(mailboxDurableObjectName(userId))),
		env.RUN_LOG.get(env.RUN_LOG.idFromName(runLogDurableObjectName(userId))),
		env.USER_METER.get(
			env.USER_METER.idFromName(userMeterDurableObjectName(userId)),
		),
		env.STORAGE_RUNNER.get(
			env.STORAGE_RUNNER.idFromName(
				storageRunnerDurableObjectName(userId, 'package:pitr-test'),
			),
		),
	]

	for (const object of objects) {
		await expect(
			object.getRecoveryBookmark({ timestampMs: Date.now() }),
		).rejects.toThrow(pitrUnavailableCode)
		await expect(
			object.restoreToBookmark({ bookmark: 'local-test-bookmark' }),
		).rejects.toThrow(pitrUnavailableCode)
	}
})
