import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'

async function extractCreatePackageAppWorkerSource() {
	const sourceText = await readFile(
		new URL('./package-app.ts', import.meta.url),
		'utf8',
	)
	const start = sourceText.indexOf(
		'function createWorkflowsProxy(runtimeBridge) {',
	)
	const end = sourceText.indexOf(
		'\nfunction createAuthenticatedFetchHelper',
		start,
	)
	if (start < 0 || end < 0) {
		throw new Error('createWorkflowsProxy source was not found.')
	}
	const proxySource = sourceText.slice(start, end).replaceAll('\\\\', '\\')
	return `${proxySource}; return createWorkflowsProxy(runtimeBridge);`
}

async function createWorkflowsProxyForTest(runtimeBridge: unknown) {
	return new Function(
		'runtimeBridge',
		await extractCreatePackageAppWorkerSource(),
	)(runtimeBridge) as {
		create(input: unknown): Promise<unknown>
	}
}

test('package app workflows proxy validates required workflow input fields', async () => {
	const workflows = await createWorkflowsProxyForTest({
		workflowCreate: async (input: unknown) => input,
	})

	await expect(workflows.create(undefined)).rejects.toThrow(
		'workflows.create requires a workflow input object.',
	)
	await expect(workflows.create({})).rejects.toThrow(
		'workflows.create requires exactly one of exportName or code.',
	)
	await expect(
		workflows.create({
			exportName: './run-event',
			code: 'export default async function main() {}',
			runAt: '2026-05-03T12:00:00.000Z',
			idempotencyKey: 'event-key',
		}),
	).rejects.toThrow(
		'workflows.create requires exactly one of exportName or code.',
	)
	await expect(
		workflows.create({
			exportName: './run-event',
			code: '',
			runAt: '2026-05-03T12:00:00.000Z',
			idempotencyKey: 'event-key',
		}),
	).resolves.toEqual({
		exportName: './run-event',
		runAt: new Date('2026-05-03T12:00:00.000Z'),
		idempotencyKey: 'event-key',
	})
	await expect(
		workflows.create({
			workflowName: 'shade-event',
			exportName: './run-event',
			runAt: 'not-a-date',
			idempotencyKey: 'event-key',
		}),
	).rejects.toThrow(
		'workflows.create requires a valid runAt ISO-8601 date-time string or Date.',
	)
	await expect(
		workflows.create({
			workflowName: 'shade-event',
			exportName: './run-event',
			runAt: 'May 3, 2026 12:00:00',
			idempotencyKey: 'event-key',
		}),
	).rejects.toThrow(
		'workflows.create requires a valid runAt ISO-8601 date-time string or Date.',
	)
})

test('package app workflows proxy forwards inline code workflow input', async () => {
	const workflows = await createWorkflowsProxyForTest({
		workflowCreate: async (input: unknown) => input,
	})
	const code = 'export default async function main() { return { ok: true } }'
	const result = await workflows.create({
		code,
		runAt: '2026-05-03T12:00:00.000Z',
		idempotencyKey: 'event-key',
		params: { eventId: 'event-1' },
	})

	expect(result).toEqual({
		code,
		runAt: new Date('2026-05-03T12:00:00.000Z'),
		idempotencyKey: 'event-key',
		params: { eventId: 'event-1' },
	})
})

test('package app workflows proxy forwards validated input to runtime bridge', async () => {
	const workflows = await createWorkflowsProxyForTest({
		workflowCreate: async (input: unknown) => input,
	})
	const result = await workflows.create({
		workflowName: ' shade-event ',
		exportName: './run-event',
		runAt: '2026-05-03T12:00:00.000Z',
		idempotencyKey: 'event-key',
		params: { eventId: 'event-1' },
	})

	expect(result).toEqual({
		workflowName: ' shade-event ',
		exportName: './run-event',
		runAt: new Date('2026-05-03T12:00:00.000Z'),
		idempotencyKey: 'event-key',
		params: { eventId: 'event-1' },
	})
})
