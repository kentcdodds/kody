import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
	type Command,
	type CreatedD1Target,
	type DrillAdapters,
	type DrillAllowlistEntry,
	type QueryRow,
	type VerificationQuery,
	runD1RestoreDrill,
} from './d1-restore-drill.ts'

const drillTokenEnvironmentVariable = 'CLOUDFLARE_D1_DRILL_EDIT_TOKEN'

type CliArguments = {
	manifestPath: string
	manifestSha256: string
	backupPath: string
	baselinePath: string
	postForwardBaselinePath?: string
	allowlistPath: string
	targetAccountId: string
	targetName: string
	execute: boolean
	applyForwardMigrations: boolean
}

function parseArguments(argv: ReadonlyArray<string>): CliArguments {
	const values = new Map<string, string>()
	const switches = new Set<string>()
	const valuedArguments = new Set([
		'--allowlist',
		'--backup',
		'--baseline',
		'--manifest',
		'--manifest-sha256',
		'--post-forward-baseline',
		'--target-account-id',
		'--target-name',
	])
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]
		if (argument === '--execute' || argument === '--apply-forward-migrations') {
			if (switches.has(argument)) {
				throw new Error(`Duplicate argument: ${argument}`)
			}
			switches.add(argument)
			continue
		}
		if (!argument?.startsWith('--') || !valuedArguments.has(argument)) {
			throw new Error(`Unknown argument: ${String(argument)}`)
		}
		if (values.has(argument)) throw new Error(`Duplicate argument: ${argument}`)
		const value = argv[index + 1]
		if (!value || value.startsWith('--')) {
			throw new Error(`Missing value for ${argument}`)
		}
		values.set(argument, value)
		index += 1
	}
	function required(name: string): string {
		const value = values.get(name)
		if (!value) throw new Error(`Missing required argument ${name}`)
		return value
	}
	return {
		manifestPath: required('--manifest'),
		manifestSha256: required('--manifest-sha256'),
		backupPath: required('--backup'),
		baselinePath: required('--baseline'),
		postForwardBaselinePath: values.get('--post-forward-baseline'),
		allowlistPath: required('--allowlist'),
		targetAccountId: required('--target-account-id'),
		targetName: required('--target-name'),
		execute: switches.has('--execute'),
		applyForwardMigrations: switches.has('--apply-forward-migrations'),
	}
}

async function readJson(file: string): Promise<unknown> {
	return JSON.parse(await readFile(file, 'utf8')) as unknown
}

async function runProcess(
	command: Command,
	environment?: Record<string, string>,
): Promise<string> {
	const program =
		command.program === 'wrangler'
			? path.join(process.cwd(), 'node_modules', '.bin', 'wrangler')
			: command.program
	return await new Promise<string>((resolve, reject) => {
		const child = spawn(program, command.args, {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, ...environment },
		})
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString()
		})
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString()
		})
		child.on('error', reject)
		child.on('close', (status) => {
			if (status === 0) resolve(stdout)
			else reject(new Error(stderr || `wrangler exited with ${String(status)}`))
		})
	})
}

function parseQueryRows(output: string): Array<QueryRow> {
	const payload = JSON.parse(output) as unknown
	if (!Array.isArray(payload) || payload.length !== 1) {
		throw new Error('Unexpected Wrangler D1 JSON response')
	}
	const first = payload[0]
	if (!first || typeof first !== 'object' || Array.isArray(first)) {
		throw new Error('Unexpected Wrangler D1 result envelope')
	}
	const results = (first as Record<string, unknown>).results
	if (!Array.isArray(results)) {
		throw new Error('Wrangler response has no results')
	}
	return results as Array<QueryRow>
}

export async function createD1DrillTarget(input: {
	accountId: string
	name: string
	token: string
	fetcher?: typeof fetch
	apiBaseUrl?: string
}): Promise<CreatedD1Target> {
	const response = await (input.fetcher ?? fetch)(
		`${input.apiBaseUrl ?? 'https://api.cloudflare.com/client/v4'}/accounts/${encodeURIComponent(input.accountId)}/d1/database`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${input.token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ name: input.name }),
		},
	)
	const payload = (await response.json()) as unknown
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new Error(`Cloudflare D1 create failed (${String(response.status)})`)
	}
	const envelope = payload as Record<string, unknown>
	const result = envelope.result
	if (
		!response.ok ||
		envelope.success !== true ||
		!result ||
		typeof result !== 'object' ||
		Array.isArray(result)
	) {
		throw new Error(`Cloudflare D1 create failed (${String(response.status)})`)
	}
	const record = result as Record<string, unknown>
	if (
		typeof record.uuid !== 'string' ||
		typeof record.name !== 'string' ||
		typeof record.created_at !== 'string'
	) {
		throw new Error('Cloudflare D1 create returned malformed target evidence')
	}
	return {
		uuid: record.uuid,
		name: record.name,
		createdAt: record.created_at,
	}
}

function createAdapters(token: string, targetAccountId: string): DrillAdapters {
	const drillEnvironment = {
		CLOUDFLARE_API_TOKEN: token,
		CLOUDFLARE_ACCOUNT_ID: targetAccountId,
	}
	return {
		async createTarget({ accountId, name }) {
			return await createD1DrillTarget({ accountId, name, token })
		},
		now() {
			return new Date()
		},
		async run(command) {
			await runProcess(command, drillEnvironment)
		},
		async query(targetUuid: string, query: VerificationQuery) {
			const output = await runProcess(
				{
					kind: 'verification',
					phase: query.phase,
					program: 'wrangler',
					args: [
						'd1',
						'execute',
						targetUuid,
						'--remote',
						'--json',
						'--command',
						query.sql,
					],
				},
				drillEnvironment,
			)
			return parseQueryRows(output)
		},
	}
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const args = parseArguments(argv)
	const [manifestBytes, backupBytes, baseline, allowlist] = await Promise.all([
		readFile(args.manifestPath),
		readFile(args.backupPath),
		readJson(args.baselinePath),
		readJson(args.allowlistPath) as Promise<Array<DrillAllowlistEntry>>,
	])
	const postForwardBaseline = args.postForwardBaselinePath
		? await readJson(args.postForwardBaselinePath)
		: undefined
	const token = args.execute
		? process.env[drillTokenEnvironmentVariable]
		: 'unused-in-dry-run'
	if (!token) {
		throw new Error(
			`${drillTokenEnvironmentVariable} is required for --execute and must be a drill-only D1 Edit token for the target account`,
		)
	}
	const result = await runD1RestoreDrill(
		{
			manifestBytes,
			expectedManifestSha256: args.manifestSha256,
			backupBytes,
			backupFile: args.backupPath,
			baseline,
			postForwardBaseline,
			targetAccountId: args.targetAccountId,
			targetName: args.targetName,
			allowlist,
			applyForwardMigrations: args.applyForwardMigrations,
			dryRun: !args.execute,
		},
		createAdapters(token, args.targetAccountId),
	)
	if (result.dryRun) console.log(JSON.stringify(result, null, 2))
	else console.log('Live-created target passed all restore-drill checks.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	})
}
