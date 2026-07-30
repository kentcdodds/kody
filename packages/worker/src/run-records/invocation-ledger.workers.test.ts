import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'
import { RunLog } from './run-log-do.ts'
import {
	claimPackageInvocationRecord,
	clearRunRecords,
	exportRunRecords,
	finishPackageInvocationRecord,
	getPackageInvocationRecord,
	getRunRecord,
	releasePackageInvocationRecord,
} from './service.ts'
import {
	packageInvocationLedgerRetentionDays,
	runRecordRetentionEveryNFinishes,
	type RunRecordContext,
} from './types.ts'

function uniqueUserId(label: string) {
	return `invocation-ledger-${label}-${crypto.randomUUID()}`
}

function ledgerKey(overrides?: Partial<Record<string, string>>) {
	return {
		tokenId: overrides?.tokenId ?? 'token-1',
		packageId: overrides?.packageId ?? 'pkg-1',
		exportName: overrides?.exportName ?? './send-message',
		idempotencyKey: overrides?.idempotencyKey ?? 'evt-1',
	}
}

function claimInput(overrides?: Partial<Record<string, string | null>>) {
	return {
		id: String(overrides?.id ?? crypto.randomUUID()),
		tokenId: String(overrides?.tokenId ?? 'token-1'),
		packageId: String(overrides?.packageId ?? 'pkg-1'),
		packageKodyId: String(overrides?.packageKodyId ?? 'pkg-one'),
		exportName: String(overrides?.exportName ?? './send-message'),
		idempotencyKey: String(overrides?.idempotencyKey ?? 'evt-1'),
		requestHash: String(overrides?.requestHash ?? 'hash-1'),
		source: overrides?.source === undefined ? 'webhook' : overrides.source,
		topic: overrides?.topic === undefined ? null : overrides.topic,
	}
}

function exportContext(
	overrides?: Partial<RunRecordContext>,
): RunRecordContext {
	return {
		surface: 'export',
		name: './send-message',
		idempotencyKey: 'evt-1',
		metadata: { exportName: './send-message' },
		...overrides,
	}
}

function freshStaleBefore() {
	return new Date(Date.now() - 15 * 60 * 1000).toISOString()
}

async function seedStaleClaim(input: {
	userId: string
	idempotencyKey: string
	requestHash?: string
}) {
	const claimed = await claimPackageInvocationRecord({
		env,
		userId: input.userId,
		context: exportContext({ idempotencyKey: input.idempotencyKey }),
		invocation: claimInput({
			idempotencyKey: input.idempotencyKey,
			requestHash: input.requestHash,
		}),
		staleBefore: freshStaleBefore(),
	})
	if (claimed.outcome !== 'claimed') {
		throw new Error('Expected a fresh claim while seeding.')
	}
	// Backdate the claim so it is past the 15-minute stale window.
	const staleUpdatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString()
	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(input.userId))
	await runInDurableObject(stub, async (instance: RunLog, state) => {
		expect(instance).toBeInstanceOf(RunLog)
		state.storage.sql.exec(
			`UPDATE package_invocation_ledger SET updated_at = ? WHERE id = ?`,
			staleUpdatedAt,
			claimed.invocationId,
		)
	})
	return { invocationId: claimed.invocationId, staleUpdatedAt }
}

test('claim + finish journey: one call each, replay record, run row lifecycle', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	const userId = uniqueUserId('journey')

	const claimed = await claimPackageInvocationRecord({
		env,
		userId,
		context: exportContext(),
		invocation: claimInput(),
		staleBefore: freshStaleBefore(),
	})
	expect(claimed.outcome).toBe('claimed')
	if (claimed.outcome !== 'claimed') throw new Error('unreachable')
	expect(claimed.reclaimed).toBe(false)
	expect(claimed.handle).not.toBeNull()

	// The eager running row landed in the same DO call as the ledger claim.
	const running = await getRunRecord({
		env,
		userId,
		runId: claimed.handle!.id,
	})
	expect(running?.run).toMatchObject({
		status: 'running',
		surface: 'export',
		idempotencyKey: 'evt-1',
		invocationId: claimed.invocationId,
	})

	// A duplicate claim sees the in-progress owner instead of double-claiming.
	const duplicate = await claimPackageInvocationRecord({
		env,
		userId,
		context: exportContext(),
		invocation: claimInput(),
		staleBefore: freshStaleBefore(),
	})
	expect(duplicate.outcome).toBe('existing')
	if (duplicate.outcome !== 'existing') throw new Error('unreachable')
	expect(duplicate.record).toMatchObject({
		id: claimed.invocationId,
		status: 'in_progress',
		requestHash: 'hash-1',
	})

	const responseJson = JSON.stringify({
		status: 200,
		body: { ok: true, result: { sent: true } },
	})
	const finished = await finishPackageInvocationRecord({
		env,
		userId,
		handle: claimed.handle,
		invocationId: claimed.invocationId,
		claimUpdatedAt: claimed.claimUpdatedAt,
		ledgerStatus: 'completed',
		responseJson,
		status: 'success',
		logs: ['sent'],
		result: { sent: true },
	})
	expect(finished).toMatchObject({ ledgerUpdated: true, record: null })

	const record = await getPackageInvocationRecord({
		env,
		userId,
		key: ledgerKey(),
	})
	expect(record).toMatchObject({
		id: claimed.invocationId,
		status: 'completed',
		responseJson,
	})

	// The terminal run row (with logs and result snapshot) landed in the same
	// DO call as the ledger response.
	const terminalRun = await getRunRecord({
		env,
		userId,
		runId: claimed.handle!.id,
	})
	expect(terminalRun?.run).toMatchObject({
		status: 'success',
		invocationId: claimed.invocationId,
		metadata: expect.objectContaining({ result: { sent: true } }),
	})
	expect(terminalRun?.logs.map((log) => log.message)).toEqual(['sent'])
})

test('stale in-progress claims are reclaimed atomically; mismatched hashes are not', async () => {
	const userId = uniqueUserId('stale-reclaim')
	const seeded = await seedStaleClaim({ userId, idempotencyKey: 'evt-stale' })

	// A different request hash never reclaims (mismatch resolution owns it).
	const mismatch = await claimPackageInvocationRecord({
		env,
		userId,
		context: exportContext({ idempotencyKey: 'evt-stale' }),
		invocation: claimInput({
			idempotencyKey: 'evt-stale',
			requestHash: 'other-hash',
		}),
		staleBefore: freshStaleBefore(),
	})
	expect(mismatch.outcome).toBe('existing')

	const reclaimed = await claimPackageInvocationRecord({
		env,
		userId,
		context: exportContext({ idempotencyKey: 'evt-stale' }),
		invocation: claimInput({ idempotencyKey: 'evt-stale' }),
		staleBefore: freshStaleBefore(),
	})
	expect(reclaimed.outcome).toBe('claimed')
	if (reclaimed.outcome !== 'claimed') throw new Error('unreachable')
	expect(reclaimed).toMatchObject({
		invocationId: seeded.invocationId,
		reclaimed: true,
	})
	expect(reclaimed.claimUpdatedAt > seeded.staleUpdatedAt).toBe(true)

	// The superseded attempt's finish is fenced out of the ledger but its own
	// run row still lands terminal.
	const staleAttemptHandle = {
		id: crypto.randomUUID(),
		userId,
		startedAt: new Date().toISOString(),
		persistence: 'eager' as const,
		context: exportContext({ idempotencyKey: 'evt-stale' }),
	}
	const fenced = await finishPackageInvocationRecord({
		env,
		userId,
		handle: staleAttemptHandle,
		invocationId: seeded.invocationId,
		claimUpdatedAt: seeded.staleUpdatedAt,
		ledgerStatus: 'failed',
		responseJson: JSON.stringify({ status: 500, body: { ok: false } }),
		status: 'error',
		error: new Error('superseded attempt'),
	})
	expect(fenced.ledgerUpdated).toBe(false)
	expect(fenced.record).toMatchObject({
		id: seeded.invocationId,
		status: 'in_progress',
		updatedAt: reclaimed.claimUpdatedAt,
	})
	const fencedRun = await getRunRecord({
		env,
		userId,
		runId: staleAttemptHandle.id,
	})
	expect(fencedRun?.run.status).toBe('error')

	// The reclaiming attempt finishes normally.
	const finished = await finishPackageInvocationRecord({
		env,
		userId,
		handle: reclaimed.handle,
		invocationId: reclaimed.invocationId,
		claimUpdatedAt: reclaimed.claimUpdatedAt,
		ledgerStatus: 'failed',
		responseJson: JSON.stringify({ status: 500, body: { ok: false } }),
		status: 'error',
		error: new Error('handler failed'),
	})
	expect(finished.ledgerUpdated).toBe(true)
	const record = await getPackageInvocationRecord({
		env,
		userId,
		key: ledgerKey({ idempotencyKey: 'evt-stale' }),
	})
	expect(record?.status).toBe('failed')
})

test('release deletes the in-progress claim and its running row so retries are clean', async () => {
	const userId = uniqueUserId('release')
	const claimed = await claimPackageInvocationRecord({
		env,
		userId,
		context: exportContext({ idempotencyKey: 'evt-release' }),
		invocation: claimInput({ idempotencyKey: 'evt-release' }),
		staleBefore: freshStaleBefore(),
	})
	if (claimed.outcome !== 'claimed') throw new Error('Expected fresh claim.')

	const released = await releasePackageInvocationRecord({
		env,
		userId,
		invocationId: claimed.invocationId,
		claimUpdatedAt: claimed.claimUpdatedAt,
		handle: claimed.handle,
	})
	expect(released).toMatchObject({ released: true, record: null })
	expect(
		await getPackageInvocationRecord({
			env,
			userId,
			key: ledgerKey({ idempotencyKey: 'evt-release' }),
		}),
	).toBeNull()
	expect(
		await getRunRecord({ env, userId, runId: claimed.handle!.id }),
	).toBeNull()

	// A stale release token cannot delete a newer claim; the caller gets the
	// current owner back instead.
	const second = await claimPackageInvocationRecord({
		env,
		userId,
		context: exportContext({ idempotencyKey: 'evt-release' }),
		invocation: claimInput({ idempotencyKey: 'evt-release' }),
		staleBefore: freshStaleBefore(),
	})
	if (second.outcome !== 'claimed') throw new Error('Expected fresh claim.')
	const fencedRelease = await releasePackageInvocationRecord({
		env,
		userId,
		invocationId: second.invocationId,
		claimUpdatedAt: new Date(0).toISOString(),
		handle: null,
	})
	expect(fencedRelease.released).toBe(false)
	expect(fencedRelease.record).toMatchObject({
		id: second.invocationId,
		status: 'in_progress',
	})
})

test('DO-local retention prunes terminal ledger rows after 90 days and keeps in-progress rows', async () => {
	const userId = uniqueUserId('retention')
	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(userId))
	const expiredCreatedAt = new Date(
		Date.now() -
			(packageInvocationLedgerRetentionDays + 1) * 24 * 60 * 60 * 1000,
	).toISOString()
	const insertLedgerRow = (input: {
		id: string
		idempotencyKey: string
		status: string
		createdAt: string
	}) =>
		runInDurableObject(stub, async (instance: RunLog, state) => {
			expect(instance).toBeInstanceOf(RunLog)
			state.storage.sql.exec(
				`INSERT INTO package_invocation_ledger (
					id, token_id, package_id, package_kody_id, export_name,
					idempotency_key, request_hash, source, topic, status,
					response_json, created_at, updated_at
				) VALUES (?, 'token-1', 'pkg-1', 'pkg-one', './send-message', ?, 'hash-1',
					NULL, NULL, ?, NULL, ?, ?)`,
				input.id,
				input.idempotencyKey,
				input.status,
				input.createdAt,
				input.createdAt,
			)
		})
	await insertLedgerRow({
		id: 'expired-terminal',
		idempotencyKey: 'evt-expired',
		status: 'completed',
		createdAt: expiredCreatedAt,
	})
	await insertLedgerRow({
		id: 'expired-in-progress',
		idempotencyKey: 'evt-expired-open',
		status: 'in_progress',
		createdAt: expiredCreatedAt,
	})
	await insertLedgerRow({
		id: 'recent-terminal',
		idempotencyKey: 'evt-recent',
		status: 'completed',
		createdAt: new Date().toISOString(),
	})

	// Arm retention so the next finish runs a full pass.
	await runInDurableObject(stub, async (_instance: RunLog, state) => {
		state.storage.sql.exec(
			`INSERT INTO run_log_meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			'finishes_since_retention',
			runRecordRetentionEveryNFinishes - 1,
		)
	})
	const claimed = await claimPackageInvocationRecord({
		env,
		userId,
		context: null,
		invocation: claimInput({ idempotencyKey: 'evt-trigger' }),
		staleBefore: freshStaleBefore(),
	})
	if (claimed.outcome !== 'claimed') throw new Error('Expected fresh claim.')
	await finishPackageInvocationRecord({
		env,
		userId,
		handle: null,
		invocationId: claimed.invocationId,
		claimUpdatedAt: claimed.claimUpdatedAt,
		ledgerStatus: 'completed',
		responseJson: null,
		status: 'success',
	})

	expect(
		await getPackageInvocationRecord({
			env,
			userId,
			key: ledgerKey({ idempotencyKey: 'evt-expired' }),
		}),
	).toBeNull()
	expect(
		await getPackageInvocationRecord({
			env,
			userId,
			key: ledgerKey({ idempotencyKey: 'evt-expired-open' }),
		}),
	).toMatchObject({ id: 'expired-in-progress', status: 'in_progress' })
	expect(
		await getPackageInvocationRecord({
			env,
			userId,
			key: ledgerKey({ idempotencyKey: 'evt-recent' }),
		}),
	).toMatchObject({ id: 'recent-terminal', status: 'completed' })
})

test('account export pages runs first, then ledger rows, through one cursor; clearAll purges both', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	const userId = uniqueUserId('export')
	const keys = ['evt-a', 'evt-b', 'evt-c']
	for (const key of keys) {
		const claimed = await claimPackageInvocationRecord({
			env,
			userId,
			context: exportContext({ idempotencyKey: key }),
			invocation: claimInput({ idempotencyKey: key }),
			staleBefore: freshStaleBefore(),
		})
		if (claimed.outcome !== 'claimed') throw new Error('Expected fresh claim.')
		await finishPackageInvocationRecord({
			env,
			userId,
			handle: claimed.handle,
			invocationId: claimed.invocationId,
			claimUpdatedAt: claimed.claimUpdatedAt,
			ledgerStatus: 'completed',
			responseJson: JSON.stringify({ status: 200, body: { ok: true } }),
			status: 'success',
		})
	}

	const seenRunIds = new Set<string>()
	const seenLedgerIds = new Set<string>()
	let startAfter: string | null = null
	for (let page = 0; page < 10; page += 1) {
		const exported = await exportRunRecords({
			env,
			userId,
			pageSize: 2,
			startAfter,
		})
		for (const run of exported.runs) seenRunIds.add(run.id)
		for (const row of exported.packageInvocations) seenLedgerIds.add(row.id)
		if (!exported.truncated) break
		startAfter = exported.nextStartAfter
	}
	expect(seenRunIds.size).toBe(3)
	expect(seenLedgerIds.size).toBe(3)

	await clearRunRecords({ env, userId })
	const afterClear = await exportRunRecords({ env, userId, pageSize: 10 })
	expect(afterClear).toMatchObject({
		runs: [],
		packageInvocations: [],
		truncated: false,
	})
	expect(
		await getPackageInvocationRecord({
			env,
			userId,
			key: ledgerKey({ idempotencyKey: 'evt-a' }),
		}),
	).toBeNull()
})
