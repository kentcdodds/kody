import { setTimeout as delay } from 'node:timers/promises'
import { writeFile } from 'node:fs/promises'
import { cloudflareApiRequest } from './resource-utils.ts'

type Namespace = { id: string; class?: string; script?: string }
type DurableObject = { id?: string; hasStoredData?: boolean }

async function withRetry<T>(run: () => Promise<T>) {
	let lastError: unknown
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			return await run()
		} catch (error) {
			lastError = error
			if (attempt < 4) await delay(250 * 2 ** attempt)
		}
	}
	throw lastError
}

async function postMaintenance(input: {
	origin: string
	secret: string
	pathname: string
	body: Record<string, unknown>
	fetcher: typeof fetch
}) {
	const response = await input.fetcher(
		`${input.origin.replace(/\/$/, '')}${input.pathname}`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${input.secret}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(input.body),
		},
	)
	const result = (await response.json()) as Record<string, unknown>
	if (!response.ok || result['ok'] !== true) {
		throw new Error(`Maintenance request failed: ${JSON.stringify(result)}`)
	}
	return result
}

export async function runMcpAgentSessionBackfill(input: {
	accountId: string
	apiToken: string
	origin: string
	maintenanceSecret: string
	workerScript: string
	execute: boolean
	auditOut?: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
}) {
	const fetcher = input.fetcher ?? fetch
	const namespaces = await withRetry(() =>
		cloudflareApiRequest<Array<Namespace>>({
			accountId: input.accountId,
			apiToken: input.apiToken,
			pathname: '/workers/durable_objects/namespaces',
			apiBaseUrl: input.apiBaseUrl,
			fetcher,
		}),
	)
	const namespace = namespaces.result?.find(
		(candidate) =>
			candidate.class === 'MCP' && candidate.script === input.workerScript,
	)
	if (!namespace?.id) {
		throw new Error(`MCP namespace was not found for ${input.workerScript}.`)
	}
	const doIds: Array<string> = []
	let cursor: string | undefined
	let pages = 0
	do {
		const query = new URLSearchParams({ limit: '100' })
		if (cursor) query.set('cursor', cursor)
		const page = await withRetry(() =>
			cloudflareApiRequest<Array<DurableObject>>({
				accountId: input.accountId,
				apiToken: input.apiToken,
				pathname: `/workers/durable_objects/namespaces/${encodeURIComponent(namespace.id)}/objects?${query}`,
				apiBaseUrl: input.apiBaseUrl,
				fetcher,
			}),
		)
		pages += 1
		for (const object of page.result ?? []) {
			if (object.hasStoredData && object.id) doIds.push(object.id)
		}
		cursor = page.result_info?.cursor || undefined
	} while (cursor)

	const batchSize = 50
	const batchCount = Math.ceil(doIds.length / batchSize)
	console.info(
		`Listed ${doIds.length} MCP objects with stored data across ${pages} page(s); processing ${batchCount} batch(es) of up to ${batchSize}.`,
	)

	const rows: Array<Record<string, unknown>> = []
	const failures: Array<Record<string, unknown>> = []
	for (let offset = 0; offset < doIds.length; offset += batchSize) {
		const batchIndex = Math.floor(offset / batchSize) + 1
		const result = await withRetry(() =>
			postMaintenance({
				origin: input.origin,
				secret: input.maintenanceSecret,
				pathname: '/__maintenance/backfill-mcp-agent-sessions',
				body: {
					dryRun: !input.execute,
					doIds: doIds.slice(offset, offset + batchSize),
				},
				fetcher,
			}),
		)
		rows.push(...((result['rows'] as Array<Record<string, unknown>>) ?? []))
		failures.push(
			...((result['failures'] as Array<Record<string, unknown>>) ?? []),
		)
		if (
			batchIndex === 1 ||
			batchIndex === batchCount ||
			batchIndex % 10 === 0
		) {
			console.info(
				`Batch ${batchIndex}/${batchCount}: rows=${rows.length} failures=${failures.length}`,
			)
		}
	}
	const audit = {
		schemaVersion: 1,
		dryRun: !input.execute,
		workerScript: input.workerScript,
		namespaceId: namespace.id,
		pages,
		listedWithStoredData: doIds.length,
		rows,
		failures,
		completedAt: new Date().toISOString(),
	}
	if (input.auditOut) {
		await writeFile(input.auditOut, `${JSON.stringify(audit, null, 2)}\n`)
	}
	if (input.execute) {
		const noOwner = rows.filter((row) => row['action'] === 'no_owner').length
		const conflicts = failures.filter(
			(failure) =>
				typeof failure['error'] === 'string' &&
				failure['error'].includes('ownership conflict'),
		).length
		if (failures.length > 0) {
			throw new Error(
				'Backfill has failures; completion marker was not written.',
			)
		}
		await postMaintenance({
			origin: input.origin,
			secret: input.maintenanceSecret,
			pathname: '/__maintenance/backfill-mcp-agent-sessions/complete',
			body: {
				auditSummary: {
					listed: doIds.length,
					failed: failures.length,
					conflicts,
					noOwner,
					audit,
				},
			},
			fetcher,
		})
	}
	return audit
}
