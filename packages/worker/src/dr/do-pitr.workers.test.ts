import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { type DurableObjectPitrRpc, pitrUnavailableCode } from './do-pitr.ts'
import {
	mailboxDurableObjectName,
	runLogDurableObjectName,
	storageRunnerDurableObjectName,
	userMeterDurableObjectName,
} from '#worker/user-scoped-durable-object-name.ts'

async function expectPitrUnavailable(object: DurableObjectPitrRpc) {
	await expect(
		object.getRecoveryBookmark({ timestampMs: Date.now() }),
	).rejects.toThrow(pitrUnavailableCode)
	await expect(
		object.restoreToBookmark({ bookmark: 'local-test-bookmark' }),
	).rejects.toThrow(pitrUnavailableCode)
}

test('all user-scoped Durable Objects expose PITR RPCs and degrade clearly in local Workers', async () => {
	const userId = `pitr-${crypto.randomUUID()}`
	await runInDurableObject(
		env.MAILBOX.get(env.MAILBOX.idFromName(mailboxDurableObjectName(userId))),
		expectPitrUnavailable,
	)
	await runInDurableObject(
		env.RUN_LOG.get(env.RUN_LOG.idFromName(runLogDurableObjectName(userId))),
		expectPitrUnavailable,
	)
	await runInDurableObject(
		env.USER_METER.get(
			env.USER_METER.idFromName(userMeterDurableObjectName(userId)),
		),
		expectPitrUnavailable,
	)
	await runInDurableObject(
		env.STORAGE_RUNNER.get(
			env.STORAGE_RUNNER.idFromName(
				storageRunnerDurableObjectName(userId, 'package:pitr-test'),
			),
		),
		expectPitrUnavailable,
	)
})
