/**
 * Preview-only guard: before `wrangler d1 migrations apply`, rewrite
 * `d1_migrations` rows whose filename no longer exists on the branch but whose
 * SQL content sha256 matches a renamed file. That is the migration-prefix race
 * from a long-lived PR preview (#2776): main lands NNNN, the branch renumbers
 * its file to NNNN+1, and a naive apply re-runs the same ALTER under the new
 * name (duplicate column).
 *
 * Matching is content-sha only (Wrangler stores names, not hashes). Historical
 * SQL for a missing applied name is recovered from git (`rev-list
 * --full-history` then `commit^:path` when the last touch deleted/renamed the
 * file; `--full-history` is required on GitHub PR merge refs). Multi-hop
 * renumbers (NNNN→NNNN+1→NNNN+2) still recover the original applied blob and
 * match by sha256, or fall back to walking each current file's rename chain.
 * Preview deploy checks out with `fetch-depth: 0`. When history cannot recover
 * the old blob (for example rebase-and-renumber rewrote it away), skip the
 * rewrite and leave apply to fail loudly — use the documented reset-preview-D1
 * fallback in docs/contributing/setup/preview-deploys.md. Never invent a match
 * from the kebab slug alone: that can mark revised SQL as already applied.
 *
 * Never runs against production: requires CLOUDFLARE_ENV=preview, --remote,
 * and a config whose binding resolves to a preview D1 database_name
 * (`kody-pr-*` / `kody-branch-*`).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { hashMigrationContent } from '../check-migrations.ts'
import { isExecutedDirectly } from '../node-runtime.ts'
import { executeWranglerD1 } from '../wrangler-d1-execute.ts'
import { previewResourceNamePattern } from './preview-resources.ts'
import { parseJsonc } from './resource-utils.ts'

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
				reason:
					'could not recover historical SQL content from git; use reset-d1 when content cannot be sha-matched',
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

const gitShowMaxBuffer = 16 * 1024 * 1024
/** Cap how many path-touching commits we probe when recovering a blob. */
export const historicalRevListProbeLimit = 32

export function historicalMigrationRevListGitArgs(
	relativePath: string,
): Array<string> {
	return [
		'rev-list',
		'-n',
		String(historicalRevListProbeLimit),
		'--full-history',
		'HEAD',
		'--',
		relativePath,
	]
}

function migrationRelativePath(
	cwd: string,
	migrationsDir: string,
	filename: string,
): string {
	return path
		.relative(cwd, path.resolve(cwd, migrationsDir, filename))
		.split(path.sep)
		.join('/')
}

function gitShow(cwd: string, spec: string): string | null {
	const shown = spawnSync('git', ['show', spec], {
		cwd,
		encoding: 'utf8',
		maxBuffer: gitShowMaxBuffer,
	})
	if (shown.status !== 0) {
		return null
	}
	return shown.stdout
}

/**
 * Prefer parent trees: the commit that last touched a renamed/deleted path
 * usually no longer has the old path. Try every parent (merge commits) before
 * the commit tree itself.
 */
function showPathNearCommit(
	cwd: string,
	commit: string,
	relativePath: string,
): string | null {
	const parents = spawnSync(
		'git',
		['rev-list', '--parents', '-n', '1', commit],
		{
			cwd,
			encoding: 'utf8',
		},
	)
	const tokens =
		parents.status === 0
			? parents.stdout.trim().split(/\s+/).filter(Boolean)
			: []
	// rev-list --parents prints: <commit> <parent1> <parent2> ...
	const parentShas = tokens.slice(1)
	for (const parent of parentShas) {
		const fromParent = gitShow(cwd, `${parent}:${relativePath}`)
		if (fromParent !== null) {
			return fromParent
		}
	}
	// Fallbacks for odd histories / shallow clones where --parents is empty.
	for (const spec of [
		`${commit}^:${relativePath}`,
		`${commit}^1:${relativePath}`,
		`${commit}^2:${relativePath}`,
		`${commit}:${relativePath}`,
	]) {
		const shown = gitShow(cwd, spec)
		if (shown !== null) {
			return shown
		}
	}
	return null
}

export function resolveHistoricalMigrationContent(input: {
	migrationsDir: string
	filename: string
	cwd?: string
}): string | null {
	assertSafeMigrationFilename(input.filename)
	const cwd = input.cwd ?? process.cwd()
	const relativePath = migrationRelativePath(
		cwd,
		input.migrationsDir,
		input.filename,
	)
	// `--full-history`: pull_request workflows check out GitHub's temporary
	// merge commit (base ← head). Default history simplification drops
	// side-branch deletes of files that never existed on the first parent
	// (main), so a renumbered preview migration blob would be unrecoverable.
	const revList = spawnSync(
		'git',
		historicalMigrationRevListGitArgs(relativePath),
		{
			cwd,
			encoding: 'utf8',
		},
	)
	if (revList.status !== 0) {
		return null
	}
	const commits = revList.stdout
		.trim()
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
	for (const commit of commits) {
		const content = showPathNearCommit(cwd, commit, relativePath)
		if (content !== null) {
			return content
		}
	}
	return null
}

/**
 * When the applied name's own history cannot be shown (edge cases on merge
 * refs / multi-hop renumbers), walk each current file's rename chain with
 * `git log --follow` and recover the blob at the applied path if that name
 * appears as a rename source. Caller must still sha256-match against current
 * digests — this only recovers content.
 */
export function resolveHistoricalMigrationContentViaRenameChain(input: {
	migrationsDir: string
	appliedFilename: string
	currentFilename: string
	cwd?: string
}): string | null {
	assertSafeMigrationFilename(input.appliedFilename)
	assertSafeMigrationFilename(input.currentFilename)
	const cwd = input.cwd ?? process.cwd()
	const appliedPath = migrationRelativePath(
		cwd,
		input.migrationsDir,
		input.appliedFilename,
	)
	const currentPath = migrationRelativePath(
		cwd,
		input.migrationsDir,
		input.currentFilename,
	)
	const followed = spawnSync(
		'git',
		[
			'log',
			'--follow',
			'--name-status',
			'--pretty=format:%H',
			'HEAD',
			'--',
			currentPath,
		],
		{ cwd, encoding: 'utf8', maxBuffer: gitShowMaxBuffer },
	)
	if (followed.status !== 0 || !followed.stdout.trim()) {
		return null
	}
	let currentCommit: string | null = null
	for (const rawLine of followed.stdout.split('\n')) {
		const line = rawLine.trim()
		if (!line) continue
		if (/^[0-9a-f]{7,40}$/i.test(line)) {
			currentCommit = line
			continue
		}
		if (!currentCommit) continue
		// name-status rename: R100\told\tnew (tabs); accept any R* similarity.
		const renameMatch = /^R\d*\t(.+)\t(.+)$/.exec(line)
		if (!renameMatch) continue
		const fromPath = renameMatch[1]
		if (fromPath !== appliedPath) continue
		const content = showPathNearCommit(cwd, currentCommit, appliedPath)
		if (content !== null) {
			return content
		}
	}
	return null
}

export function resolveHistoricalMigrationContentWithFallback(input: {
	migrationsDir: string
	filename: string
	currentFilenames: ReadonlyArray<string>
	cwd?: string
}): string | null {
	const direct = resolveHistoricalMigrationContent({
		migrationsDir: input.migrationsDir,
		filename: input.filename,
		cwd: input.cwd,
	})
	if (direct !== null) {
		return direct
	}
	for (const currentFilename of input.currentFilenames) {
		if (currentFilename === input.filename) continue
		const viaChain = resolveHistoricalMigrationContentViaRenameChain({
			migrationsDir: input.migrationsDir,
			appliedFilename: input.filename,
			currentFilename,
			cwd: input.cwd,
		})
		if (viaChain !== null) {
			return viaChain
		}
	}
	return null
}

export function isAllowedPreviewD1DatabaseName(name: string) {
	return previewResourceNamePattern.test(name)
}

export function readD1DatabaseNameFromConfig(input: {
	configPath: string
	binding: string
	envName?: string
}): string {
	const envName = input.envName ?? process.env.CLOUDFLARE_ENV ?? 'preview'
	const raw = readFileSync(input.configPath, 'utf8')
	const config = parseJsonc<Record<string, unknown>>(raw)
	const env = config.env
	const targetEnv =
		env && typeof env === 'object'
			? (env as Record<string, unknown>)[envName]
			: undefined
	const envRecord =
		targetEnv && typeof targetEnv === 'object'
			? (targetEnv as Record<string, unknown>)
			: config
	const databases = envRecord.d1_databases
	if (!Array.isArray(databases)) {
		throw new Error(
			`wrangler config "${input.configPath}" has no d1_databases for env ${envName}.`,
		)
	}
	for (const entry of databases) {
		if (!entry || typeof entry !== 'object') continue
		const record = entry as Record<string, unknown>
		if (record.binding !== input.binding) continue
		if (typeof record.database_name !== 'string' || !record.database_name) {
			throw new Error(
				`Binding ${input.binding} in ${input.configPath} is missing database_name.`,
			)
		}
		return record.database_name
	}
	throw new Error(
		`Binding ${input.binding} not found in ${input.configPath} env.${envName}.d1_databases.`,
	)
}

export function assertPreviewOnlyD1Target(options: {
	config: string
	binding: string
}): string {
	const databaseName = readD1DatabaseNameFromConfig({
		configPath: options.config,
		binding: options.binding,
	})
	if (!isAllowedPreviewD1DatabaseName(databaseName)) {
		throw new Error(
			`Refusing to rewrite d1_migrations for database "${databaseName}" (binding ${options.binding}): not a preview D1 name (${String(previewResourceNamePattern)}).`,
		)
	}
	return databaseName
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

function d1Target(options: CliOptions) {
	return {
		mode: '--remote' as const,
		config: options.config,
	}
}

function queryRows(options: CliOptions, sql: string) {
	return executeWranglerD1({
		...d1Target(options),
		binding: options.binding,
		sql,
	})
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
	try {
		executeWranglerD1({
			...d1Target(options),
			binding: options.binding,
			sql,
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(
			`Failed to ${rewrite.kind} d1_migrations ${from} → ${to}: ${message}`,
		)
	}
}

export function main(argv: ReadonlyArray<string>): void {
	const options = parseArgs(argv)
	assertPreviewCloudflareEnv()
	const databaseName = assertPreviewOnlyD1Target(options)
	console.log(
		`Preview migration rename rewrite (${options.binding}): targeting database ${databaseName}.`,
	)

	const appliedNames = queryAppliedMigrationNames(options)
	if (appliedNames === null || appliedNames.length === 0) {
		console.log(
			`Preview migration rename rewrite (${options.binding}): fresh database; nothing to rewrite.`,
		)
		return
	}

	const currentFiles = listMigrationDigests(options.migrationsDir)
	const currentFilenames = currentFiles.map((file) => file.filename)
	const plan = planRenamedMigrationRewrites({
		appliedNames,
		currentFiles,
		resolveHistoricalContent: (filename) =>
			resolveHistoricalMigrationContentWithFallback({
				migrationsDir: options.migrationsDir,
				filename,
				currentFilenames,
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
