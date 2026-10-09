import { isExecutedDirectly } from '../node-runtime.ts'
import { fail } from './resource-utils.ts'

export const capabilityReindexPhases = [
	'capabilities',
	'memories',
	'jobs',
	'packages',
] as const

export type CapabilityReindexPhaseName =
	(typeof capabilityReindexPhases)[number]

export type CapabilityReindexOptions = {
	baseUrl: string
	secret: string
	/** Omit for a full sweep (every phase). */
	phases?: ReadonlyArray<CapabilityReindexPhaseName>
	force?: boolean
	maxSweeps?: number
	fetcher?: typeof fetch
	log?: (line: string) => void
}

/**
 * Drive `POST /__maintenance/reindex-capabilities` until it reports
 * `complete: true`, passing each sweep's cursor to the next. Throws on a
 * non-2xx sweep, an incomplete sweep without a cursor, or `maxSweeps`.
 */
export async function runCapabilityReindex(options: CapabilityReindexOptions) {
	const fetcher = options.fetcher ?? fetch
	const log = options.log ?? ((line: string) => console.log(line))
	const maxSweeps = options.maxSweeps ?? 8
	const url = `${options.baseUrl.replace(/\/+$/, '')}/__maintenance/reindex-capabilities`
	let cursor: unknown
	for (let sweep = 1; sweep <= maxSweeps; sweep += 1) {
		const body = {
			...(options.phases ? { phases: options.phases } : {}),
			...(options.force ? { force: true } : {}),
			...(cursor === undefined ? {} : { cursor }),
		}
		log(`POST ${url} (sweep ${sweep}) ${JSON.stringify(body)}`)
		const response = await fetcher(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${options.secret}`,
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(120_000),
		})
		const text = await response.text()
		log(text)
		if (!response.ok) {
			throw new Error(`Capability reindex failed with HTTP ${response.status}.`)
		}
		const payload = JSON.parse(text) as {
			complete?: boolean
			cursor?: unknown
		}
		if (payload.complete === true) {
			log(`Capability reindex complete after ${sweep} sweep(s).`)
			return { sweeps: sweep }
		}
		if (payload.cursor === undefined || payload.cursor === null) {
			throw new Error(
				'Capability reindex is incomplete but returned no cursor.',
			)
		}
		cursor = payload.cursor
	}
	throw new Error(
		`Capability reindex did not finish after ${maxSweeps} sweeps.`,
	)
}

export function parseReindexArgs(argv: ReadonlyArray<string>) {
	let baseUrl = ''
	let phases: Array<CapabilityReindexPhaseName> | undefined
	let force = false
	let maxSweeps: number | undefined
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		const value = argv[index + 1] ?? ''
		switch (arg) {
			case '--url':
				baseUrl = value
				index += 1
				break
			case '--phases': {
				const requested = value.split(',').filter(Boolean)
				for (const phase of requested) {
					if (
						!(capabilityReindexPhases as ReadonlyArray<string>).includes(phase)
					) {
						fail(
							`Unknown --phases entry "${phase}". Use ${capabilityReindexPhases.join(', ')}.`,
						)
					}
				}
				phases = requested as Array<CapabilityReindexPhaseName>
				index += 1
				break
			}
			case '--force':
				force = true
				break
			case '--max-sweeps':
				maxSweeps = Number(value)
				if (!Number.isInteger(maxSweeps) || maxSweeps < 1) {
					fail('--max-sweeps must be a positive integer.')
				}
				index += 1
				break
			default:
				fail(
					`Unknown flag: ${arg}. Usage: node tools/ci/reindex-capabilities.ts --url <origin> [--phases capabilities,memories,jobs,packages] [--force] [--max-sweeps <n>] (reads CAPABILITY_REINDEX_SECRET)`,
				)
		}
	}
	if (!baseUrl) fail('Missing required flag: --url <origin>')
	return { baseUrl, phases, force, maxSweeps }
}

if (isExecutedDirectly(import.meta.url)) {
	const secret = process.env.CAPABILITY_REINDEX_SECRET?.trim()
	if (!secret) fail('Missing CAPABILITY_REINDEX_SECRET.')
	try {
		await runCapabilityReindex({
			...parseReindexArgs(process.argv.slice(2)),
			secret,
		})
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error))
	}
}
