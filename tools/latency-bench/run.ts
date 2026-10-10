import { writeFile } from 'node:fs/promises'
import { Client as LegacyMcpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as LegacyMcpTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { isExecutedDirectly } from '../node-runtime.ts'
import {
	connectStatelessMcpClient,
	resolveAppMcpAuth,
	usernameFromEmail,
} from '../mcp-oauth-client.ts'
import {
	addedOverhead,
	formatMarkdown,
	summarizePath,
	type OverheadSummary,
	type PathSummary,
	type PhaseSample,
} from './stats.ts'

/**
 * Measures the latency Kody adds on top of the underlying call for the hosted
 * MCP paths (noop execute, `kody.mcp[...]`, `{{secret:}}` fetch through the
 * gateway, saved package export, search) and the direct baselines (plain fetch,
 * direct MCP tool call). Each path records one cold sample followed by `n`
 * warm samples. Execute paths also record the server-reported tool duration and
 * `serverTiming` phases returned in `structuredContent.timing`.
 */

export type LatencyBenchOptions = {
	origin: string
	email: string
	password: string
	token?: string
	n: number
	paths: Set<string> | null
	mcpServer?: string
	mcpTool: string
	mcpArgs: Record<string, unknown>
	mcpDirectUrl?: string
	fetchUrl?: string
	secretName?: string
	packageImport?: string
	searchQuery: string
	json: boolean
	out?: string
}

export type LatencyBenchReport = {
	origin: string
	measuredAt: string
	n: number
	paths: Record<string, PathSummary>
	overhead: Array<OverheadSummary>
}

export const latencyBenchClientName = 'kody-latency-bench'

function isProductionOrigin(origin: string) {
	const hostname = new URL(origin).hostname
	return hostname === 'kody.codes' || hostname === 'www.kody.codes'
}

export function parseArgs(argv: Array<string>): LatencyBenchOptions {
	const options: LatencyBenchOptions = {
		origin: 'http://localhost:3742',
		email: 'kody@example.com',
		password: 'ilikecode',
		n: 30,
		paths: null,
		mcpTool: 'ping',
		mcpArgs: {},
		searchQuery: 'ping tool',
		json: false,
	}
	const takeValue = (flag: string, index: number) => {
		const value = argv[index]
		if (value === undefined || value.startsWith('--')) {
			throw new Error(`${flag} requires a value`)
		}
		return value
	}
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] as string
		switch (arg) {
			case '--json':
				options.json = true
				break
			case '--origin':
				options.origin = new URL(takeValue(arg, ++index)).origin
				break
			case '--email':
				options.email = takeValue(arg, ++index)
				break
			case '--password':
				options.password = takeValue(arg, ++index)
				break
			case '--token':
				options.token = takeValue(arg, ++index)
				break
			case '--n':
				options.n = Number(takeValue(arg, ++index))
				if (!Number.isInteger(options.n) || options.n < 1) {
					throw new Error('--n must be a positive integer')
				}
				break
			case '--paths':
				options.paths = new Set(
					takeValue(arg, ++index)
						.split(',')
						.map((path) => path.trim())
						.filter(Boolean),
				)
				break
			case '--mcp-server':
				options.mcpServer = takeValue(arg, ++index)
				break
			case '--mcp-tool':
				options.mcpTool = takeValue(arg, ++index)
				break
			case '--mcp-args':
				options.mcpArgs = JSON.parse(takeValue(arg, ++index)) as Record<
					string,
					unknown
				>
				break
			case '--mcp-direct-url':
				options.mcpDirectUrl = takeValue(arg, ++index)
				break
			case '--fetch-url':
				options.fetchUrl = takeValue(arg, ++index)
				break
			case '--secret-name':
				options.secretName = takeValue(arg, ++index)
				break
			case '--package-import':
				options.packageImport = takeValue(arg, ++index)
				break
			case '--search-query':
				options.searchQuery = takeValue(arg, ++index)
				break
			case '--out':
				options.out = takeValue(arg, ++index)
				break
			default:
				throw new Error(`Unknown argument: ${arg}`)
		}
	}
	if (isProductionOrigin(options.origin) && !options.token) {
		throw new Error(
			'Refusing to log in to https://kody.codes with a password. Pass --token for a dedicated test account instead.',
		)
	}
	return options
}

type ExecuteResult = {
	isError?: boolean
	content?: unknown
	structuredContent?: {
		timing?: {
			durationMs?: number
			serverTiming?: Array<{ name: string; durationMs: number }>
		}
	}
}

export async function runLatencyBench(
	options: LatencyBenchOptions,
): Promise<LatencyBenchReport> {
	const token =
		options.token ??
		(
			await resolveAppMcpAuth(
				options.origin,
				{
					email: options.email,
					username: usernameFromEmail(options.email),
					password: options.password,
				},
				{ clientName: latencyBenchClientName },
			)
		).oauth.accessToken

	let lastWallMs = 0
	const timedFetch: typeof fetch = async (input, init) => {
		const startedAt = performance.now()
		const response = await fetch(input, init)
		lastWallMs = performance.now() - startedAt
		return response
	}
	const { client, transport } = await connectStatelessMcpClient(
		options.origin,
		{ Authorization: `Bearer ${token}` },
		{ name: latencyBenchClientName, fetch: timedFetch },
	)

	const paths: Record<string, PathSummary> = {}
	const overhead: Array<OverheadSummary> = []

	async function measure(name: string, sample: () => Promise<PhaseSample>) {
		if (options.paths && !options.paths.has(name)) return
		let cold: PhaseSample | null = null
		const warm: Array<PhaseSample> = []
		let errors = 0
		for (let index = 0; index <= options.n; index++) {
			try {
				const result = await sample()
				if (index === 0) cold = result
				else warm.push(result)
			} catch (error) {
				errors++
				if (errors <= 2) {
					console.error(
						`${name}: ${error instanceof Error ? error.message.slice(0, 400) : String(error)}`,
					)
				}
			}
		}
		paths[name] = summarizePath({ cold, warm, errors })
		if (!options.json)
			console.error(`${name}: ${JSON.stringify(paths[name].warm)}`)
	}

	async function execute(code: string): Promise<PhaseSample> {
		const result = (await client.callTool({
			name: 'execute',
			arguments: { code },
		})) as ExecuteResult
		if (result.isError) {
			throw new Error(JSON.stringify(result.content).slice(0, 400))
		}
		const timing = result.structuredContent?.timing
		const phases: Record<string, number> = {}
		for (const entry of timing?.serverTiming ?? []) {
			phases[entry.name] = entry.durationMs
		}
		return { wallMs: lastWallMs, toolMs: timing?.durationMs, phases }
	}

	async function timed(run: () => Promise<unknown>): Promise<PhaseSample> {
		const startedAt = performance.now()
		await run()
		return { wallMs: performance.now() - startedAt }
	}

	await measure('health', () =>
		timed(async () => (await fetch(new URL('/health', options.origin))).text()),
	)
	await measure('mcp-tools-list', async () => {
		await client.listTools()
		return { wallMs: lastWallMs }
	})
	await measure('execute-noop', () => execute('export default async () => 1'))

	if (options.fetchUrl) {
		const fetchUrl = JSON.stringify(options.fetchUrl)
		await measure('direct-fetch', () =>
			timed(async () => (await fetch(options.fetchUrl as string)).text()),
		)
		await measure('execute-fetch-plain', () =>
			execute(`export default async () => (await fetch(${fetchUrl})).text()`),
		)
		if (options.secretName) {
			await measure('execute-fetch-secret', () =>
				execute(
					`export default async () => (await fetch(${fetchUrl}, { headers: { Authorization: 'Bearer {{secret:${options.secretName}}}' } })).text()`,
				),
			)
		}
	}

	if (options.mcpServer) {
		const call = `kody.mcp[${JSON.stringify(options.mcpServer)}][${JSON.stringify(options.mcpTool)}](${JSON.stringify(options.mcpArgs)})`
		await measure('execute-mcp-tool', () =>
			execute(
				`import { kody } from 'kody:runtime'\nexport default async () => ${call}`,
			),
		)
	}
	if (options.mcpDirectUrl) {
		const direct = new LegacyMcpClient({
			name: latencyBenchClientName,
			version: '1.0.0',
		})
		await direct.connect(new LegacyMcpTransport(new URL(options.mcpDirectUrl)))
		await measure('direct-mcp-tool', () =>
			timed(() =>
				direct.callTool({ name: options.mcpTool, arguments: options.mcpArgs }),
			),
		)
		await direct.close()
	}

	if (options.packageImport) {
		await measure('execute-package-export', () =>
			execute(
				`import run from ${JSON.stringify(options.packageImport)}\nexport default async () => run({})`,
			),
		)
	}

	await measure('search', async () => {
		const result = (await client.callTool({
			name: 'search',
			arguments: { query: options.searchQuery },
		})) as ExecuteResult
		if (result.isError) {
			throw new Error(JSON.stringify(result.content).slice(0, 400))
		}
		return { wallMs: lastWallMs }
	})

	await client.close().catch(() => undefined)
	await transport.close().catch(() => undefined)

	const pairs: Array<[string, string]> = [
		['execute-fetch-plain', 'direct-fetch'],
		['execute-fetch-secret', 'direct-fetch'],
		['execute-mcp-tool', 'direct-mcp-tool'],
	]
	for (const [kodyPath, directPath] of pairs) {
		const kody = paths[kodyPath]
		const direct = paths[directPath]
		if (kody && direct)
			overhead.push(addedOverhead(kodyPath, kody, directPath, direct))
	}

	return {
		origin: options.origin,
		measuredAt: new Date().toISOString(),
		n: options.n,
		paths,
		overhead,
	}
}

export async function main(argv = process.argv.slice(2)) {
	const options = parseArgs(argv)
	const report = await runLatencyBench(options)
	if (options.out) {
		await writeFile(options.out, JSON.stringify(report, null, 2))
	}
	console.log(
		options.json ? JSON.stringify(report, null, 2) : formatMarkdown(report),
	)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
