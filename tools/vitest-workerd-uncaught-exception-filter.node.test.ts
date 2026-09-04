import { expect, test, vi } from 'vitest'
import {
	consumeWorkerdLogChunk,
	createWorkerdLogFilterState,
	flushWorkerdLogFilter,
	installWorkerdUncaughtExceptionFilter,
	isIncidentalWorkerdUncaughtExceptionLine,
	isWorkerdExceptionContinuationLine,
} from './vitest-workerd-uncaught-exception-filter.ts'

const readOnlySqlDump = [
	'uncaught exception; source = Uncaught (in promise); stack = Error: Read-only storage.sql only allows a single SELECT, EXPLAIN, or schema PRAGMA statement. Pass writable: true to allow multi-statement or mutating queries.',
	'    at assertSqlAllowed (/workspace/packages/worker/src/storage-runner.ts:407:9)',
	'    at StorageRunnerBase.sqlQuery (/workspace/packages/worker/src/storage-runner.ts:574:17)',
	'    at workspace/node_modules/@cloudflare/vitest-pool-workers/dist/worker/lib/cloudflare/test-internal.mjs:365:47',
].join('\n')

const retrieverFetchDump = [
	'uncaught exception; source = Uncaught (in promise); stack = Error: Outbound fetch is not available in retriever runs.',
	'    at executeGatewayFetch (/workspace/packages/worker/src/mcp/fetch-gateway.ts:189:10)',
	'    at KodyFetchGateway.fetch (/workspace/packages/worker/src/mcp/fetch-gateway.ts:131:10)',
].join('\n')

const jsgFetchDump = [
	'uncaught exception; exception = workerd/jsg/_virtual_includes/iterator/workerd/jsg/value.h:1477: failed: jsg.Error: Outbound fetch is not available in retriever runs.',
	'stack: /workspace/node_modules/@cloudflare/workerd-linux-64/bin/workerd@33a76d0 /workspace/node_modules/@cloudflare/workerd-linux-64/bin/workerd@33a836c',
].join('\n')

const sqlConstraintDump = [
	'uncaught exception; source = Uncaught (in promise); stack = Error: forced second chunk failure: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)',
	'    at /workspace/node_modules/@sentry/cloudflare/src/instrumentations/instrumentSqlStorage.ts:53:83',
].join('\n')

const unexpectedDump = [
	'uncaught exception; source = Uncaught (in promise); stack = Error: storage lease was lost',
	'    at assertLease (/workspace/packages/worker/src/email/system-email-authority.ts:12:3)',
].join('\n')

test('classifies only the known incidental uncaught-exception banners', () => {
	expect(
		isIncidentalWorkerdUncaughtExceptionLine(readOnlySqlDump.split('\n')[0]!),
	).toBe(true)
	expect(
		isIncidentalWorkerdUncaughtExceptionLine(
			retrieverFetchDump.split('\n')[0]!,
		),
	).toBe(true)
	expect(
		isIncidentalWorkerdUncaughtExceptionLine(jsgFetchDump.split('\n')[0]!),
	).toBe(true)
	expect(
		isIncidentalWorkerdUncaughtExceptionLine(sqlConstraintDump.split('\n')[0]!),
	).toBe(true)

	expect(
		isIncidentalWorkerdUncaughtExceptionLine(unexpectedDump.split('\n')[0]!),
	).toBe(false)
	expect(
		isIncidentalWorkerdUncaughtExceptionLine('Test Files  91 passed'),
	).toBe(false)
	expect(
		isIncidentalWorkerdUncaughtExceptionLine(
			`stderr | workers-unit | ${readOnlySqlDump.split('\n')[0]!}`,
		),
	).toBe(true)
	expect(
		isWorkerdExceptionContinuationLine(
			'    at assertSqlAllowed (/workspace/packages/worker/src/storage-runner.ts:407:9)',
		),
	).toBe(true)
	expect(
		isWorkerdExceptionContinuationLine(
			'stack: /workspace/node_modules/@cloudflare/workerd-linux-64/bin/workerd@33a76d0',
		),
	).toBe(true)
})

test('drops incidental dumps and keeps unexpected isolate errors and vitest output', () => {
	const state = createWorkerdLogFilterState()
	const kept = [
		consumeWorkerdLogChunk(state, `${readOnlySqlDump}\n`),
		consumeWorkerdLogChunk(state, `${retrieverFetchDump}\n`),
		consumeWorkerdLogChunk(state, `${jsgFetchDump}\n`),
		consumeWorkerdLogChunk(state, `${sqlConstraintDump}\n`),
		consumeWorkerdLogChunk(state, `${unexpectedDump}\n`),
		consumeWorkerdLogChunk(state, ' RUN  v4.1.11 /workspace\n'),
		consumeWorkerdLogChunk(state, ' Test Files  91 passed (91)\n'),
		flushWorkerdLogFilter(state),
	].join('')

	expect(kept).toBe(
		`${unexpectedDump}\n RUN  v4.1.11 /workspace\n Test Files  91 passed (91)\n`,
	)
})

test('handles dumps split across writes without leaking stack frames', () => {
	const state = createWorkerdLogFilterState()
	const first = consumeWorkerdLogChunk(
		state,
		'uncaught exception; source = Uncaught (in promise); stack = Error: Outbound fetch is not available in retriever runs.\n    at execute',
	)
	const second = consumeWorkerdLogChunk(
		state,
		'GatewayFetch (/workspace/packages/worker/src/mcp/fetch-gateway.ts:189:10)\n',
	)
	expect(first).toBe('')
	expect(second).toBe('')
	expect(flushWorkerdLogFilter(state)).toBe('')
})

test('passes through incomplete non-exception writes immediately', () => {
	const state = createWorkerdLogFilterState()
	expect(consumeWorkerdLogChunk(state, 'Test Files  ')).toBe('Test Files  ')
	expect(consumeWorkerdLogChunk(state, '91 passed')).toBe('91 passed')
	expect(flushWorkerdLogFilter(state)).toBe('')
})

test('install wraps a stream write and restores it', () => {
	const writes: Array<string> = []
	const stream = {
		write: vi.fn(
			(chunk: string, _encoding?: unknown, callback?: () => void) => {
				writes.push(String(chunk))
				callback?.()
				return true
			},
		),
	} as unknown as NodeJS.WriteStream

	const restore = installWorkerdUncaughtExceptionFilter([stream])
	stream.write(`${readOnlySqlDump}\n`)
	stream.write('ok\n')
	restore()
	stream.write('after-restore\n')

	expect(writes).toEqual(['ok\n', 'after-restore\n'])
})
