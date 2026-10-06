/**
 * Preview-only guard: before `wrangler d1 migrations apply`, rewrite
 * `d1_migrations` rows whose filename no longer exists on the branch but whose
 * SQL content sha256 matches a renamed file. That is the migration-prefix race
 * from a long-lived PR preview (#2776): main lands NNNN, the branch renumbers
 * its file to NNNN+1, and a naive apply re-runs the same ALTER under the new
 * name (duplicate column).
 *
 * Matching is content-sha only (Wrangler stores names, not hashes). Historical
 * content for a missing applied name is recovered from git history on HEAD.
 * When rewrite is unsafe (no recoverable content, no sha match, or ambiguous
 * matches), this script no-ops for that row and leaves apply to fail loudly —
 * use the documented reset-preview-D1 fallback in
 * docs/contributing/setup/preview-deploys.md.
 *
 * Never runs against production: requires CLOUDFLARE_ENV=preview and --remote.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { hashMigrationContent } from '../check-migrations.ts'
import { isExecutedDirectly } from '../node-runtime.ts'

export const migrationFilenamePattern = /^\d{4}-[a-z0-9-]+\.sql$/

export type MigrationFileDigest = {
	filename: string
	sha256: string
}

export type RenamedMigrationRewrite =
	| {
			kind: 'rename'
			from: string
			to: string
			sha256: string
	  }
	| {
			kind: 'drop-stale'
			from: string
			to: string
			sha256: string
	  }

export type RenamedMigrationSkip = {
	name: string
	reason: string
}

export type RenamedMigrationPlan = {
	rewrites: Array<RenamedMigrationRewrite>
	skipped: Array<RenamedMigrationSkip>
}

export function assertSafeMigrationFilename(name: string): string {
	if (!migrationFilenamePattern.test(name)) {
		throw new Error(
			`Refusing migration filename ${JSON.stringify(name)}: expected NNNN-kebab.sql`,
		)
	}
	return name
}

export function planRenamedMigrationRewrites(input: {
	appliedNames: ReadonlyArray<string>
	currentFiles: ReadonlyArray<MigrationFileDigest>
	resolveHistoricalContent: (filename: string) => string | null
}): RenamedMigrationPlan {
	const currentByName = new Map(
		input.currentFiles.map((file) => [file.filename, file] as const),
	)
	const appliedSet = new Set(input.appliedNames)
	const rewrites: Array<RenamedMigrationRewrite> = []
	const skipped: Array<RenamedMigrationSkip> = []
	const claimedTargets = new Set<string>()

	for (const appliedName of input.appliedNames) {
		if (currentByName.has(appliedName)) {
			continue
		}
		try {
			assertSafeMigrationFilename(appliedName)
		} catch (error) {
			skipped.push({
				name: appliedName,
				reason:
					error instanceof Error ? error.message : 'unsafe migration filename',
			})
			continue
		}

		const historical = input.resolveHistoricalContent(appliedName)
		if (historical === null) {
			skipped.push({
				name: appliedName,
				reason: 'could not recover historical SQL content from git',
			})
			continue
		}

		const sha256 = hashMigrationContent(historical)
		const matches = input.currentFiles.filter((file) => file.sha256 === sha256)
		if (matches.length === 0) {
			skipped.push({
				name: appliedName,
				reason: `no current migration matches sha256 ${sha256}`,
			})
			continue
		}
		if (matches.length > 1) {
			skipped.push({
				name: appliedName,
				reason: `ambiguous sha256 ${sha256} matches ${matches
					.map((file) => file.filename)
					.join(', ')}`,
			})
			continue
		}

		const target = matches[0]
		if (!target) {
			skipped.push({
				name: appliedName,
				reason: `no current migration matches sha256 ${sha256}`,
			})
			continue
		}
		try {
			assertSafeMigrationFilename(target.filename)
		} catch (error) {
			skipped.push({
				name: appliedName,
				reason:
					error instanceof Error
						? error.message
						: 'unsafe target migration filename',
			})
			continue
		}
		if (claimedTargets.has(target.filename)) {
			skipped.push({
				name: appliedName,
				reason: `target ${target.filename} already claimed by another rewrite`,
			})
			continue
		}

		claimedTargets.add(target.filename)
		if (appliedSet.has(target.filename)) {
			rewrites.push({
				kind: 'drop-stale',
				from: appliedName,
				to: target.filename,
				sha256,
			})
			continue
		}
		rewrites.push({
			kind: 'rename',
			from: appliedName,
			to: target.filename,
			sha256,
		})
	}

	return { rewrites, skipped }
}

export function listMigrationDigests(
	migrationsDir: string,
): Array<MigrationFileDigest> {
	if (!existsSync(migrationsDir)) {
		throw new Error(`Migrations directory does not exist: ${migrationsDir}`)
	}
	return readdirSync(migrationsDir)
		.filter((filename) => filename.endsWith('.sql'))
		.map((filename) => {
			assertSafeMigrationFilename(filename)
			const content = readFileSync(path.join(migrationsDir, filename))
			return { filename, sha256: hashMigrationContent(content) }
		})
		.sort((left, right) => left.filename.localeCompare(right.filename))
}

export function resolveHistoricalMigrationContent(input: {
	migrationsDir: string
	filename: string
	cwd?: string
}): string | null {
	assertSafeMigrationFilename(input.filename)
	const cwd = input.cwd ?? process.cwd()
	const relativePath = path
		.relative(cwd, path.resolve(cwd, input.migrationsDir, input.filename))
		.split(path.sep)
		.join('/')
	const revList = spawnSync(
		'git',
		['rev-list', '-n', '1', 'HEAD', '--', relativePath],
		{ cwd, encoding: 'utf8' },
	)
	if (revList.status !== 0) {
		return null
	}
	const commit = revList.stdout.trim()
	if (!commit) {
		return null
	}
	const shown = spawnSync('git', ['show', `${commit}:${relativePath}`], {
		cwd,
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024,
	})
	if (shown.status !== 0) {
		return null
	}
	return shown.stdout
}

type CliOptions = {
	binding: string
	config: string
	migrationsDir: string
	dryRun: boolean
}

export function parseArgs(argv: ReadonlyArray<string>): CliOptions {
	const options: CliOptions = {
		binding: '',
		config: '',
		migrationsDir: '',
		dryRun: false,
	}
	let sawRemote = false
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]
		if (!argument) continue
		switch (argument) {
			case '--remote': {
				sawRemote = true
				break
			}
			case '--dry-run': {
				options.dryRun = true
				break
			}
			case '--binding': {
				const value = argv[index + 1]
				if (!value) throw new Error('--binding requires a name')
				options.binding = value
				index += 1
				break
			}
			case '--config': {
				const value = argv[index + 1]
				if (!value) throw new Error('--config requires a path')
				options.config = value
				index += 1
				break
			}
			case '--migrations-dir': {
				const value = argv[index + 1]
				if (!value) throw new Error('--migrations-dir requires a path')
				options.migrationsDir = value
				index += 1
				break
			}
			default: {
				throw new Error(
					`Unsupported argument: ${argument}. Supported: --remote, --binding <name>, --config <path>, --migrations-dir <path>, --dry-run.`,
				)
			}
		}
	}
	if (!sawRemote) {
		throw new Error('Pass --remote (preview Cloudflare D1 only).')
	}
	if (!options.binding) {
		throw new Error('--binding is required')
	}
	if (!options.config) {
		throw new Error('--config is required')
	}
	if (!options.migrationsDir) {
		throw new Error('--migrations-dir is required')
	}
	return options
}

function assertPreviewCloudflareEnv(): void {
	if (process.env.CLOUDFLARE_ENV !== 'preview') {
		throw new Error(
			'Refusing to rewrite d1_migrations unless CLOUDFLARE_ENV=preview (never production).',
		)
	}
}

function runWranglerD1(
	options: CliOptions,
	d1Arguments: ReadonlyArray<string>,
): { status: number | null; stdout: string; stderr: string } {
	const nodeArguments: Array<string> = []
	const envFilePath = path.join('packages', 'worker', '.env')
	if (existsSync(envFilePath)) {
		nodeArguments.push(`--env-file=${envFilePath}`)
	}
	nodeArguments.push(
		'./wrangler-env.ts',
		'd1',
		...d1Arguments,
		'--remote',
		'--config',
		options.config,
	)
	const result = spawnSync(process.execPath, nodeArguments, {
		cwd: process.cwd(),
		encoding: 'utf8',
		env: { ...process.env, WRANGLER_LOG: 'log' },
		maxBuffer: 16 * 1024 * 1024,
	})
	return {
		status: result.status,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	}
}

function queryRows(
	options: CliOptions,
	sql: string,
): Array<{ name?: unknown }> {
	const result = runWranglerD1(options, [
		'execute',
		options.binding,
		'--json',
		'--command',
		sql,
	])
	if (result.status !== 0) {
		throw new Error(
			`wrangler d1 execute failed (exit ${String(result.status)}) for: ${sql}\n${result.stdout}\n${result.stderr}`,
		)
	}
	const parsed: unknown = JSON.parse(result.stdout)
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error('Unexpected wrangler d1 execute --json output shape.')
	}
	const first = parsed[0] as { results?: Array<{ name?: unknown }> }
	return first.results ?? []
}

function queryAppliedMigrationNames(options: CliOptions): Array<string> | null {
	const tables = queryRows(
		options,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations';",
	)
	if (tables.length === 0) {
		return null
	}
	const rows = queryRows(
		options,
		'SELECT name FROM d1_migrations ORDER BY name;',
	)
	return rows.map((row) => String(row.name))
}

function sqlStringLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}

function applyRewrite(
	options: CliOptions,
	rewrite: RenamedMigrationRewrite,
): void {
	const from = assertSafeMigrationFilename(rewrite.from)
	const to = assertSafeMigrationFilename(rewrite.to)
	const sql =
		rewrite.kind === 'rename'
			? `UPDATE d1_migrations SET name = ${sqlStringLiteral(to)} WHERE name = ${sqlStringLiteral(from)};`
			: `DELETE FROM d1_migrations WHERE name = ${sqlStringLiteral(from)};`
	const result = runWranglerD1(options, [
		'execute',
		options.binding,
		'--json',
		'--command',
		sql,
	])
	if (result.status !== 0) {
		process.stderr.write(result.stderr)
		throw new Error(
			`Failed to ${rewrite.kind} d1_migrations ${from} → ${to} (exit ${String(result.status)}).`,
		)
	}
}

export function main(argv: ReadonlyArray<string>): void {
	const options = parseArgs(argv)
	assertPreviewCloudflareEnv()

	const appliedNames = queryAppliedMigrationNames(options)
	if (appliedNames === null || appliedNames.length === 0) {
		console.log(
			`Preview migration rename rewrite (${options.binding}): fresh database; nothing to rewrite.`,
		)
		return
	}

	const currentFiles = listMigrationDigests(options.migrationsDir)
	const plan = planRenamedMigrationRewrites({
		appliedNames,
		currentFiles,
		resolveHistoricalContent: (filename) =>
			resolveHistoricalMigrationContent({
				migrationsDir: options.migrationsDir,
				filename,
			}),
	})

	if (plan.rewrites.length === 0 && plan.skipped.length === 0) {
		console.log(
			`Preview migration rename rewrite (${options.binding}): applied names match on-disk files; nothing to rewrite.`,
		)
		return
	}

	for (const skip of plan.skipped) {
		console.warn(
			`Preview migration rename rewrite (${options.binding}): skipped ${skip.name}: ${skip.reason}. If apply fails with a duplicate column/object, use the reset-preview-D1 fallback in docs/contributing/setup/preview-deploys.md.`,
		)
	}

	if (plan.rewrites.length === 0) {
		return
	}

	for (const rewrite of plan.rewrites) {
		const action =
			rewrite.kind === 'rename'
				? `rename ${rewrite.from} → ${rewrite.to}`
				: `drop stale ${rewrite.from} (sha matches already-applied ${rewrite.to})`
		if (options.dryRun) {
			console.log(
				`Preview migration rename rewrite (${options.binding}): dry-run would ${action} (sha256 ${rewrite.sha256})`,
			)
			continue
		}
		applyRewrite(options, rewrite)
		console.log(
			`Preview migration rename rewrite (${options.binding}): ${action} (sha256 ${rewrite.sha256})`,
		)
	}

	if (options.dryRun) {
		return
	}

	const verifyNames = queryAppliedMigrationNames(options) ?? []
	const verifySet = new Set(verifyNames)
	for (const rewrite of plan.rewrites) {
		if (verifySet.has(rewrite.from)) {
			throw new Error(
				`Rewrite verification failed: ${rewrite.from} is still present in d1_migrations.`,
			)
		}
		if (rewrite.kind === 'rename' && !verifySet.has(rewrite.to)) {
			throw new Error(
				`Rewrite verification failed: ${rewrite.to} is missing from d1_migrations after rename.`,
			)
		}
	}
}

if (isExecutedDirectly(import.meta.url)) {
	main(process.argv.slice(2))
}
