import { readFile } from 'node:fs/promises'

function readFlag(name: string) {
	const index = process.argv.indexOf(name)
	return index >= 0 ? process.argv[index + 1] : undefined
}

const allowedOrigins = new Set(['https://heykody.dev'])

const maintenanceSecret = process.env['CAPABILITY_REINDEX_SECRET']
const origin = readFlag('--origin')
const idsPath =
	readFlag('--ids') ?? 'tools/ci/ownerless-mcp-session-do-ids.json'
if (!maintenanceSecret || !origin) {
	throw new Error('CAPABILITY_REINDEX_SECRET and --origin are required.')
}
if (!allowedOrigins.has(origin.replace(/\/$/, ''))) {
	throw new Error(`Origin must be one of: ${[...allowedOrigins].join(', ')}.`)
}

const payload = JSON.parse(await readFile(idsPath, 'utf8')) as {
	doIds?: Array<unknown>
}
const doIds = (payload.doIds ?? []).filter(
	(value): value is string => typeof value === 'string' && value.length > 0,
)
if (doIds.length === 0) {
	throw new Error(`No doIds found in ${idsPath}.`)
}

const batchSize = 50
const purged: Array<string> = []
const skipped: Array<Record<string, unknown>> = []
const failures: Array<Record<string, unknown>> = []
for (let offset = 0; offset < doIds.length; offset += batchSize) {
	const batch = doIds.slice(offset, offset + batchSize)
	const response = await fetch(
		`${origin.replace(/\/$/, '')}/__maintenance/purge-ownerless-mcp-sessions`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${maintenanceSecret}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ doIds: batch }),
		},
	)
	const result = (await response.json()) as Record<string, unknown>
	if (!response.ok || result['ok'] !== true) {
		throw new Error(`Purge request failed: ${JSON.stringify(result)}`)
	}
	purged.push(...((result['purged'] as Array<string>) ?? []))
	skipped.push(...((result['skipped'] as Array<Record<string, unknown>>) ?? []))
	failures.push(
		...((result['failures'] as Array<Record<string, unknown>>) ?? []),
	)
	console.info(
		`Batch ${Math.floor(offset / batchSize) + 1}: purged=${purged.length} skipped=${skipped.length} failures=${failures.length}`,
	)
}

const summary = {
	origin,
	idsPath,
	listed: doIds.length,
	purgedCount: purged.length,
	skippedCount: skipped.length,
	failureCount: failures.length,
	purged,
	skipped,
	failures,
	completedAt: new Date().toISOString(),
}
console.log(JSON.stringify(summary, null, 2))
if (failures.length > 0) {
	throw new Error('Ownerless MCP session purge finished with failures.')
}
