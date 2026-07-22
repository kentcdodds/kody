import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
	type Command,
	type D1TargetEvidence,
	type DrillAdapters,
	type DrillAllowlistEntry,
	type QueryRow,
	type VerificationQuery,
	runD1RestoreDrill,
} from './d1-restore-drill.ts'

type CliArguments = {
	manifestPath: string
	manifestSha256: string
	backupPath: string
	baselinePath: string
	postForwardBaselinePath?: string
	inventoryPath: string
	allowlistPath: string
	targetUuid: string
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
		'--inventory',
		'--manifest',
		'--manifest-sha256',
		'--post-forward-baseline',
		'--target-name',
		'--target-uuid',
	])
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]
		if (argument === '--execute' || argument === '--apply-forward-migrations') {
			switches.add(argument)
			continue
		}
		if (!argument?.startsWith('--')) {
			throw new Error(`Unknown argument: ${String(argument)}`)
		}
		if (!valuedArguments.has(argument)) {
			throw new Error(`Unknown argument: ${argument}`)
		}
		if (values.has(argument)) {
			throw new Error(`Duplicate argument: ${argument}`)
		}
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
		inventoryPath: required('--inventory'),
		allowlistPath: required('--allowlist'),
		targetUuid: required('--target-uuid'),
		targetName: required('--target-name'),
		execute: switches.has('--execute'),
		applyForwardMigrations: switches.has('--apply-forward-migrations'),
	}
}

async function readJson(file: string): Promise<unknown> {
	return JSON.parse(await readFile(file, 'utf8')) as unknown
}

async function runProcess(command: Command): Promise<string> {
	const program =
		command.program === 'wrangler'
			? path.join(process.cwd(), 'node_modules', '.bin', 'wrangler')
			: command.program
	return await new Promise<string>((resolve, reject) => {
		const child = spawn(program, command.args, {
			stdio: ['ignore', 'pipe', 'pipe'],
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

function createAdapters(): DrillAdapters {
	return {
		async run(command) {
			await runProcess(command)
		},
		async query(targetUuid: string, query: VerificationQuery) {
			const output = await runProcess({
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
			})
			return parseQueryRows(output)
		},
	}
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const args = parseArguments(argv)
	const [manifestBytes, backupBytes, baseline, inventory, allowlist] =
		await Promise.all([
			readFile(args.manifestPath),
			readFile(args.backupPath),
			readJson(args.baselinePath),
			readJson(args.inventoryPath) as Promise<Array<D1TargetEvidence>>,
			readJson(args.allowlistPath) as Promise<Array<DrillAllowlistEntry>>,
		])
	const postForwardBaseline = args.postForwardBaselinePath
		? await readJson(args.postForwardBaselinePath)
		: undefined
	const target = inventory.find(
		(item) => item.uuid === args.targetUuid && item.name === args.targetName,
	)
	if (!target) {
		throw new Error('explicit target UUID/name pair is absent from inventory')
	}
	const result = await runD1RestoreDrill(
		{
			manifestBytes,
			expectedManifestSha256: args.manifestSha256,
			backupBytes,
			backupFile: args.backupPath,
			baseline,
			postForwardBaseline,
			target,
			allowlist,
			applyForwardMigrations: args.applyForwardMigrations,
			dryRun: !args.execute,
		},
		createAdapters(),
	)
	if (result.dryRun) console.log(JSON.stringify(result, null, 2))
	else
		console.log('Restore drill and all requested verification checks passed.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	})
}
