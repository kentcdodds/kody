import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { isExecutedDirectly, resolveLocalBinary } from '../node-runtime.ts'
import {
	type BackupFileEvidence,
	type Command,
	type CreatedD1Target,
	type DrillAdapters,
	type QueryRow,
	type TemporaryWranglerConfig,
	type VerificationQuery,
	maximumD1BackupSizeBytes,
	parseAndVerifyManifest,
	runD1RestoreDrill,
} from './d1-restore-drill.ts'

const drillTokenEnvironmentVariable = 'CLOUDFLARE_D1_DRILL_EDIT_TOKEN'
const applicationMigrationsDirectory = fileURLToPath(
	new URL('../../packages/worker/migrations/', import.meta.url),
)
export const restoreTrustRegistryPath = fileURLToPath(
	new URL('./trusted-d1-restore-identities.json', import.meta.url),
)
export const manifestPublicKeyRegistryPath = fileURLToPath(
	new URL('./trusted-backup-manifest-public-keys.json', import.meta.url),
)
export const restoreBaselineRegistryPath = fileURLToPath(
	new URL('./trusted-restore-baselines.json', import.meta.url),
)

type CliArguments = {
	manifestPath: string
	manifestSha256: string
	backupPath: string
	baselineId: string
	postForwardBaselineId?: string
	targetAccountId: string
	targetName: string
	execute: boolean
	applyForwardMigrations: boolean
}

export function parseArguments(argv: ReadonlyArray<string>): CliArguments {
	const values = new Map<string, string>()
	const switches = new Set<string>()
	const valuedArguments = new Set([
		'--backup',
		'--baseline-id',
		'--manifest',
		'--manifest-sha256',
		'--post-forward-baseline-id',
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
		baselineId: required('--baseline-id'),
		postForwardBaselineId: values.get('--post-forward-baseline-id'),
		targetAccountId: required('--target-account-id'),
		targetName: required('--target-name'),
		execute: switches.has('--execute'),
		applyForwardMigrations: switches.has('--apply-forward-migrations'),
	}
}

async function readJson(file: string): Promise<unknown> {
	return JSON.parse(await readFile(file, 'utf8')) as unknown
}

type BackupFileEvidenceAdapters = {
	statFile(file: string): Promise<{ size: number }>
	readChunks(file: string): AsyncIterable<Uint8Array>
}

const defaultBackupFileEvidenceAdapters: BackupFileEvidenceAdapters = {
	async statFile(file) {
		return await stat(file)
	},
	readChunks(file) {
		return createReadStream(file)
	},
}

export async function collectBackupFileEvidence(
	file: string,
	expectedSizeBytes: number,
	adapters: BackupFileEvidenceAdapters = defaultBackupFileEvidenceAdapters,
): Promise<BackupFileEvidence> {
	const { size } = await adapters.statFile(file)
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new Error('local SQL file size is invalid')
	}
	if (size >= maximumD1BackupSizeBytes) {
		throw new Error('local SQL file exceeds the 5 GiB restore-drill limit')
	}
	if (size !== expectedSizeBytes) {
		throw new Error('local SQL file size does not match the manifest')
	}

	const hash = createHash('sha256')
	let streamedSizeBytes = 0
	for await (const chunk of adapters.readChunks(file)) {
		streamedSizeBytes += chunk.byteLength
		if (
			streamedSizeBytes > size ||
			streamedSizeBytes >= maximumD1BackupSizeBytes
		) {
			throw new Error('local SQL file changed while hashing')
		}
		hash.update(chunk)
	}
	if (streamedSizeBytes !== size) {
		throw new Error('local SQL file changed while hashing')
	}
	return { sizeBytes: size, sha256: hash.digest('hex') }
}

export type StagedBackupFile = {
	path: string
	evidence: BackupFileEvidence
	cleanup(): Promise<void>
}

export type StageBackupFileAdapters = {
	statFile(file: string): Promise<{ size: number }>
	createTemporaryDirectory(): Promise<string>
	copyFile(source: string, destination: string): Promise<number>
	makeDirectoryPrivate(directory: string): Promise<void>
	makeFileReadOnly(file: string): Promise<void>
	collectEvidence(
		file: string,
		expectedSizeBytes: number,
	): Promise<BackupFileEvidence>
	removeDirectory(directory: string): Promise<void>
}

const defaultStageBackupFileAdapters: StageBackupFileAdapters = {
	async statFile(file) {
		return await stat(file)
	},
	async createTemporaryDirectory() {
		return await mkdtemp(path.join(os.tmpdir(), 'kody-d1-sql-'))
	},
	async copyFile(source, destination) {
		let bytes = 0
		const limit = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				bytes += chunk.byteLength
				if (bytes >= maximumD1BackupSizeBytes) {
					callback(
						new Error('local SQL file exceeds the 5 GiB restore-drill limit'),
					)
					return
				}
				callback(null, chunk)
			},
		})
		await pipeline(
			createReadStream(source),
			limit,
			createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
		)
		return bytes
	},
	async makeDirectoryPrivate(directory) {
		await chmod(directory, 0o700)
	},
	async makeFileReadOnly(file) {
		await chmod(file, 0o400)
	},
	async collectEvidence(file, expectedSizeBytes) {
		return await collectBackupFileEvidence(file, expectedSizeBytes)
	},
	async removeDirectory(directory) {
		await rm(directory, { recursive: true, force: true })
	},
}

export async function stageBackupFile(
	source: string,
	expectedEvidence: BackupFileEvidence,
	adapters: StageBackupFileAdapters = defaultStageBackupFileAdapters,
): Promise<StagedBackupFile> {
	const expectedSizeBytes = expectedEvidence.sizeBytes
	const { size } = await adapters.statFile(source)
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new Error('local SQL file size is invalid')
	}
	if (size >= maximumD1BackupSizeBytes) {
		throw new Error('local SQL file exceeds the 5 GiB restore-drill limit')
	}
	if (size !== expectedSizeBytes) {
		throw new Error('local SQL file size does not match the manifest')
	}

	const directory = await adapters.createTemporaryDirectory()
	const stagedPath = path.join(directory, 'backup.sql')
	let retained = false
	try {
		await adapters.makeDirectoryPrivate(directory)
		const copiedBytes = await adapters.copyFile(source, stagedPath)
		if (copiedBytes !== expectedSizeBytes) {
			throw new Error('local SQL file changed while staging')
		}
		await adapters.makeFileReadOnly(stagedPath)
		const evidence = await adapters.collectEvidence(
			stagedPath,
			expectedSizeBytes,
		)
		if (evidence.sha256 !== expectedEvidence.sha256) {
			throw new Error('staged SQL file evidence does not match the manifest')
		}
		retained = true
		return {
			path: stagedPath,
			evidence,
			async cleanup() {
				await adapters.removeDirectory(directory)
			},
		}
	} finally {
		if (!retained) await adapters.removeDirectory(directory)
	}
}

export async function withStagedBackupFile<T>(
	source: string,
	expectedEvidence: BackupFileEvidence,
	callback: (staged: StagedBackupFile) => Promise<T>,
	stage: typeof stageBackupFile = stageBackupFile,
): Promise<T> {
	const staged = await stage(source, expectedEvidence)
	try {
		return await callback(staged)
	} finally {
		await staged.cleanup()
	}
}

export async function runProcess(
	command: Command,
	environment?: NodeJS.ProcessEnv,
	inheritEnvironment = true,
): Promise<string> {
	const program =
		command.program === 'wrangler'
			? resolveLocalBinary('wrangler')
			: command.program
	return await new Promise<string>((resolve, reject) => {
		const childEnvironment = {
			...(inheritEnvironment ? process.env : {}),
			...environment,
		}
		for (const [name, value] of Object.entries(childEnvironment)) {
			if (value === undefined) delete childEnvironment[name]
		}
		const child = spawn(program, command.args, {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: childEnvironment,
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
			if (status === 0) {
				if (command.args.includes('--json') && stdout.length === 0) {
					reject(new Error(`Wrangler returned no JSON. stderr: ${stderr}`))
				} else resolve(stdout)
			} else
				reject(new Error(stderr || `wrangler exited with ${String(status)}`))
		})
	})
}

export function parseQueryRows(output: string): Array<QueryRow> {
	const payload = JSON.parse(output) as unknown
	if (!Array.isArray(payload) || payload.length !== 1) {
		throw new Error('Unexpected Wrangler D1 JSON response')
	}
	const first = payload[0]
	if (!first || typeof first !== 'object' || Array.isArray(first)) {
		throw new Error('Unexpected Wrangler D1 result envelope')
	}
	const envelope = first as Record<string, unknown>
	if (envelope.success !== true) {
		throw new Error('Wrangler D1 query was not successful')
	}
	const results = envelope.results
	if (!Array.isArray(results)) {
		throw new Error('Wrangler response has no results')
	}
	for (const row of results) {
		if (!row || typeof row !== 'object' || Array.isArray(row)) {
			throw new Error('Wrangler response contains a malformed result row')
		}
		for (const value of Object.values(row)) {
			if (
				value !== null &&
				typeof value !== 'string' &&
				typeof value !== 'number'
			) {
				throw new Error('Wrangler response contains an invalid result value')
			}
		}
	}
	return results as Array<QueryRow>
}

export type D1RestoreWranglerConfig = {
	d1_databases: [
		{
			binding: 'D1_RESTORE_TARGET'
			database_name: string
			database_id: string
			migrations_dir: string
		},
	]
}

export function buildD1RestoreWranglerConfig(input: {
	configPath: string
	migrationsDirectory: string
	targetName: string
	targetUuid: string
}): D1RestoreWranglerConfig {
	const relativeMigrationsDirectory = path
		.relative(path.dirname(input.configPath), input.migrationsDirectory)
		.replaceAll(path.sep, '/')
	return {
		d1_databases: [
			{
				binding: 'D1_RESTORE_TARGET',
				database_name: input.targetName,
				database_id: input.targetUuid,
				migrations_dir: relativeMigrationsDirectory.startsWith('.')
					? relativeMigrationsDirectory
					: `./${relativeMigrationsDirectory}`,
			},
		],
	}
}

export async function writeTemporaryD1RestoreConfig(input: {
	migrationsDirectory: string
	targetName: string
	targetUuid: string
}): Promise<TemporaryWranglerConfig> {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'kody-d1-restore-'))
	const configPath = path.join(directory, 'wrangler.json')
	const config = buildD1RestoreWranglerConfig({
		...input,
		configPath,
	})
	try {
		await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
			flag: 'wx',
		})
	} catch (error) {
		await rm(directory, { recursive: true, force: true })
		throw error
	}
	return {
		path: configPath,
		async cleanup() {
			await rm(directory, { recursive: true, force: true })
		},
	}
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

export function createAdapters(
	token: string,
	targetAccountId: string,
	writeTemporaryConfig: DrillAdapters['writeTemporaryConfig'] = async (input) =>
		await writeTemporaryD1RestoreConfig({
			...input,
			migrationsDirectory: applicationMigrationsDirectory,
		}),
): DrillAdapters {
	const drillEnvironment = {
		CLOUDFLARE_API_TOKEN: token,
		CLOUDFLARE_ACCOUNT_ID: targetAccountId,
	}
	return {
		async createTarget({ accountId, name }) {
			return await createD1DrillTarget({ accountId, name, token })
		},
		writeTemporaryConfig,
		now() {
			return new Date()
		},
		async run(command) {
			await runProcess(command, drillEnvironment)
		},
		async query(command: Command, _query: VerificationQuery) {
			const output = await runProcess(command, drillEnvironment)
			return parseQueryRows(output)
		},
	}
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const args = parseArguments(argv)
	const [
		manifestBytes,
		manifestPublicKeyRegistry,
		baselineRegistry,
		trustRegistry,
	] = await Promise.all([
		readFile(args.manifestPath),
		readJson(manifestPublicKeyRegistryPath),
		readJson(restoreBaselineRegistryPath),
		readJson(restoreTrustRegistryPath),
	])
	const manifest = parseAndVerifyManifest(
		manifestBytes,
		args.manifestSha256,
		manifestPublicKeyRegistry,
	)
	await withStagedBackupFile(
		args.backupPath,
		{
			sizeBytes: manifest.payload.sql.bytes,
			sha256: manifest.payload.sql.sha256,
		},
		async (stagedBackup) => {
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
					manifestPublicKeyRegistry,
					backupFileEvidence: stagedBackup.evidence,
					backupFile: stagedBackup.path,
					baselineId: args.baselineId,
					postForwardBaselineId: args.postForwardBaselineId,
					baselineRegistry,
					targetAccountId: args.targetAccountId,
					targetName: args.targetName,
					trustRegistry,
					applyForwardMigrations: args.applyForwardMigrations,
					dryRun: !args.execute,
				},
				createAdapters(token, args.targetAccountId),
			)
			if (result.dryRun) console.log(JSON.stringify(result, null, 2))
			else console.log('Live-created target passed all restore-drill checks.')
		},
	)
}

if (isExecutedDirectly(import.meta.url)) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	})
}
