import { runMcpAgentSessionBackfill } from './backfill-mcp-agent-sessions.ts'

function readFlag(name: string) {
	const index = process.argv.indexOf(name)
	return index >= 0 ? process.argv[index + 1] : undefined
}

const accountId = process.env['CLOUDFLARE_ACCOUNT_ID']
const apiToken = process.env['CLOUDFLARE_API_TOKEN']
const maintenanceSecret = process.env['CAPABILITY_REINDEX_SECRET']
const origin = readFlag('--origin')
const workerScript = readFlag('--worker-script') ?? 'kody'
if (!accountId || !apiToken || !maintenanceSecret || !origin) {
	throw new Error(
		'CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CAPABILITY_REINDEX_SECRET, and --origin are required.',
	)
}

const result = await runMcpAgentSessionBackfill({
	accountId,
	apiToken,
	maintenanceSecret,
	origin,
	workerScript,
	execute: process.argv.includes('--execute'),
	auditOut: readFlag('--audit-out'),
})
console.log(JSON.stringify(result, null, 2))
