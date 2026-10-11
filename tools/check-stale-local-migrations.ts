/**
 * Local-only guard that runs before each `wrangler d1 migrations apply --local`
 * in tools/apply-local-app-migrations.ts.
 *
 * Wrangler records applied migrations by filename. Renaming a migration that a
 * persisted local state dir already applied (for example taking the next free
 * prefix after a parallel PR landed the same one) leaves the old name in
 * `d1_migrations`, and the next apply re-runs the same SQL under the new name
 * and fails with an error such as `duplicate column name`. This check fails
 * first, naming every recorded migration that is no longer on disk and the
 * reset step. Local state may hold unreleased SQL that git cannot recover, so
 * it never rewrites bookkeeping; PR previews heal through
 * tools/ci/rewrite-renamed-preview-migrations.ts instead.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { workerEnvFileRelativePath } from './local-d1-persist.ts'
import { isExecutedDirectly } from './node-runtime.ts'

export function findStaleAppliedMigrations(input: {
	appliedNames: ReadonlyArray<string>
	onDiskNames: ReadonlyArray<string>
}) {
	const onDisk = new Set(input.onDiskNames)
	return input.appliedNames.filter((name) => !onDisk.has(name)).sort()
}

function shellQuote(value: string) {
	return `'${value.replaceAll("'", `'\\''`)}'`
}

export function formatStaleLocalMigrationsError(input: {
	binding: string
	migrationsDir: string
	persistTo: string
	stale: ReadonlyArray<string>
}) {
	return [
		`Local ${input.binding} state in ${input.persistTo} records migrations that no longer exist in ${input.migrationsDir}:`,
		...input.stale.map((name) => `  ${name}`),
		'A renamed or deleted migration keeps its old name in d1_migrations, so applying would run the same SQL again under the new name.',
		'Reset the local state (this deletes all local data in that directory), then rerun the same command:',
		`  rm -rf -- ${shellQuote(input.persistTo)}`,
	].join('\n')
}

type CliOptions = {
	binding: string
	migrationsDir: string
	persistTo: string
	config: string | null
}

const valueFlags: Record<string, keyof CliOptions> = {
	'--binding': 'binding',
	'--migrations-dir': 'migrationsDir',
	'--persist-to': 'persistTo',
	'--config': 'config',
}

export function parseArgs(argv: ReadonlyArray<string>): CliOptions {
	const options: CliOptions = {
		binding: '',
		migrationsDir: '',
		persistTo: '',
		config: null,
	}
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]!
		if (argument.startsWith('--persist-to=')) {
			options.persistTo = argument.slice('--persist-to='.length)
			continue
		}
		const key = valueFlags[argument]
		if (!key) {
			throw new Error(
				`Unsupported argument: ${argument}. Supported: --binding <name>, --migrations-dir <path>, --persist-to <path>, --config <path>.`,
			)
		}
		const value = argv[index + 1]
		if (!value) throw new Error(`${argument} requires a value`)
		options[key] = value
		index += 1
	}
	for (const [flag, value] of [
		['--binding', options.binding],
		['--migrations-dir', options.migrationsDir],
		['--persist-to', options.persistTo],
	] as const) {
		if (!value) throw new Error(`${flag} is required`)
	}
	return options
}

function queryNames(options: CliOptions, sql: string): Array<string> {
	const nodeArguments: Array<string> = []
	if (existsSync(workerEnvFileRelativePath)) {
		nodeArguments.push(`--env-file=${workerEnvFileRelativePath}`)
	}
	nodeArguments.push(
		'./wrangler-env.ts',
		'd1',
		'execute',
		options.binding,
		'--local',
		'--persist-to',
		options.persistTo,
		...(options.config ? ['--config', options.config] : []),
		'--json',
		'--command',
		sql,
	)
	const result = spawnSync(process.execPath, nodeArguments, {
		cwd: process.cwd(),
		encoding: 'utf8',
		// Wrangler emits --json results through its logger; an ambient
		// WRANGLER_LOG above "log" silences them.
		env: { ...process.env, WRANGLER_LOG: 'log' },
		maxBuffer: 16 * 1024 * 1024,
	})
	if (result.status !== 0) {
		throw new Error(
			`wrangler d1 execute ${options.binding} failed (exit ${String(result.status)}) for: ${sql}\n${result.stdout}\n${result.stderr}`,
		)
	}
	const parsed: unknown = JSON.parse(result.stdout)
	const rows = Array.isArray(parsed)
		? (parsed[0] as { results?: Array<{ name?: unknown }> } | undefined)
				?.results
		: undefined
	if (!rows) {
		throw new Error(
			`Unexpected wrangler d1 execute --json output for ${options.binding}: ${result.stdout}`,
		)
	}
	return rows.map((row) => String(row.name))
}

function queryAppliedMigrationNames(options: CliOptions) {
	const tables = queryNames(
		options,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations';",
	)
	if (tables.length === 0) return []
	return queryNames(options, 'SELECT name FROM d1_migrations ORDER BY name;')
}

function listMigrationNames(migrationsDir: string) {
	return readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'))
}

export function main(argv: ReadonlyArray<string>) {
	const options = parseArgs(argv)
	const stale = findStaleAppliedMigrations({
		appliedNames: queryAppliedMigrationNames(options),
		onDiskNames: listMigrationNames(path.resolve(options.migrationsDir)),
	})
	if (stale.length === 0) return 0
	console.error(
		formatStaleLocalMigrationsError({
			binding: options.binding,
			migrationsDir: options.migrationsDir,
			persistTo: options.persistTo,
			stale,
		}),
	)
	return 1
}

if (isExecutedDirectly(import.meta.url)) {
	process.exitCode = main(process.argv.slice(2))
}
