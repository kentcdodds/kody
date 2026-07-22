import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

export const defaultMigrationsDir = path.join(
	'packages',
	'worker',
	'migrations',
)
export const defaultMigrationLedgerPath = path.join(
	'tools',
	'migration-ledger.json',
)
export const expectedMigrationBaselineSha256 =
	'33a6aadea996e639d158229a1322f00164a157e2ef8aa43c9abcd5bf22c59c3a'

/**
 * Exact grandfathered duplicate-prefix pairs. Applied D1 migrations cannot be
 * renamed, so these 14 filenames are permanently allowed to share prefixes.
 * Anything else on these prefixes (or a third file) is rejected.
 */
export const allowedHistoricalDuplicateMigrationFilenames = [
	'0009-secret-allowed-hosts.sql',
	'0009-ui-artifact-parameters.sql',
	'0010-secret-allowed-capabilities.sql',
	'0010-value-buckets.sql',
	'0018-jobs.sql',
	'0018-mcp-memory-source-uris.sql',
	'0023-entity-sources.sql',
	'0023-secret-allowed-packages.sql',
	'0037-drop-chat-threads.sql',
	'0037-package-runtime-debug.sql',
	'0053-mcp-server-settings.sql',
	'0053-two-factor-passkeys.sql',
	'0073-agent-package-conversation-uses.sql',
	'0073-community-forks-forked-package-index.sql',
] as const

const allowedHistoricalDuplicateMigrationFilenameSet = new Set<string>(
	allowedHistoricalDuplicateMigrationFilenames,
)

const migrationFilenamePattern =
	/^(?<prefix>\d{4})-(?<description>[a-z0-9]+(?:-[a-z0-9]+)*)\.sql$/

export type ParsedMigrationFilename = {
	prefix: string
	description: string
}

export type MigrationFilenameCheckResult = {
	ok: boolean
	errors: Array<string>
	nextPrefix: string
	maxPrefix: number
}

export type MigrationLedgerEntry = {
	filename: string
	sha256: string
}

export type MigrationLedger = {
	version: 1
	baselineCount: number
	baselineMaximumPrefix: number
	baselineSha256: string
	migrations: Array<MigrationLedgerEntry>
}

export function parseMigrationFilename(
	filename: string,
): ParsedMigrationFilename | null {
	const match = migrationFilenamePattern.exec(filename)
	if (!match?.groups) {
		return null
	}
	const prefix = match.groups.prefix
	const description = match.groups.description
	if (!prefix || !description) {
		return null
	}
	return { prefix, description }
}

export function getMaxMigrationPrefix(
	filenames: ReadonlyArray<string>,
): number {
	let maxPrefix = 0
	for (const filename of filenames) {
		const parsed = parseMigrationFilename(filename)
		if (!parsed) {
			continue
		}
		maxPrefix = Math.max(maxPrefix, Number(parsed.prefix))
	}
	return maxPrefix
}

export function formatMigrationPrefix(prefix: number): string {
	return String(prefix).padStart(4, '0')
}

export function getNextMigrationPrefix(
	filenames: ReadonlyArray<string>,
): string {
	return formatMigrationPrefix(getMaxMigrationPrefix(filenames) + 1)
}

function suggestNextPrefix(nextPrefix: string): string {
	return `Use the next free prefix ${nextPrefix} (for example, ${nextPrefix}-your-change.sql).`
}

export function checkMigrationFilenames(
	filenames: ReadonlyArray<string>,
): MigrationFilenameCheckResult {
	const sortedFilenames = [...filenames].sort()
	const maxPrefix = getMaxMigrationPrefix(sortedFilenames)
	const nextPrefix = formatMigrationPrefix(maxPrefix + 1)
	const errors: Array<string> = []
	const filesByPrefix = new Map<string, Array<string>>()

	for (const filename of sortedFilenames) {
		const parsed = parseMigrationFilename(filename)
		if (!parsed) {
			errors.push(
				`Invalid migration filename "${filename}". Expected NNNN-kebab-case-description.sql with a 4-digit prefix and lowercase kebab-case segments. ${suggestNextPrefix(nextPrefix)}`,
			)
			continue
		}

		const filesForPrefix = filesByPrefix.get(parsed.prefix) ?? []
		filesForPrefix.push(filename)
		filesByPrefix.set(parsed.prefix, filesForPrefix)
	}

	const prefixes = [...filesByPrefix.keys()].sort()
	for (const prefix of prefixes) {
		const filesForPrefix = filesByPrefix.get(prefix)
		if (!filesForPrefix || filesForPrefix.length <= 1) {
			continue
		}

		const disallowedFiles = filesForPrefix.filter(
			(filename) =>
				!allowedHistoricalDuplicateMigrationFilenameSet.has(filename),
		)
		const isAllowedHistoricalPair =
			disallowedFiles.length === 0 && filesForPrefix.length === 2

		if (isAllowedHistoricalPair) {
			continue
		}

		const allowedPairForPrefix = allowedHistoricalDuplicateMigrationFilenames
			.filter((filename) => filename.startsWith(`${prefix}-`))
			.join(', ')

		if (allowedPairForPrefix.length > 0) {
			const offendingFiles =
				disallowedFiles.length > 0 ? disallowedFiles : filesForPrefix
			errors.push(
				`Duplicate migration prefix ${prefix} is only allowed for the grandfathered pair (${allowedPairForPrefix}). Offending file(s): ${offendingFiles.join(', ')}. Files with this prefix: ${filesForPrefix.join(', ')}. ${suggestNextPrefix(nextPrefix)}`,
			)
			continue
		}

		errors.push(
			`Duplicate migration prefix ${prefix}: ${filesForPrefix.join(', ')}. ${suggestNextPrefix(nextPrefix)}`,
		)
	}

	return {
		ok: errors.length === 0,
		errors,
		nextPrefix,
		maxPrefix,
	}
}

function sha256(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex')
}

function getBaselineSha256(
	entries: ReadonlyArray<MigrationLedgerEntry>,
): string {
	return sha256(JSON.stringify(entries))
}

function isMigrationLedger(value: unknown): value is MigrationLedger {
	if (!value || typeof value !== 'object') {
		return false
	}
	const candidate = value as Partial<MigrationLedger>
	return (
		candidate.version === 1 &&
		Number.isInteger(candidate.baselineCount) &&
		Number.isInteger(candidate.baselineMaximumPrefix) &&
		typeof candidate.baselineSha256 === 'string' &&
		Array.isArray(candidate.migrations) &&
		candidate.migrations.every(
			(entry) =>
				entry !== null &&
				typeof entry === 'object' &&
				typeof entry.filename === 'string' &&
				typeof entry.sha256 === 'string' &&
				/^[a-f0-9]{64}$/.test(entry.sha256),
		)
	)
}

export function checkMigrationLedger(
	files: ReadonlyArray<MigrationLedgerEntry>,
	ledger: MigrationLedger,
): MigrationFilenameCheckResult {
	const filenames = files.map(({ filename }) => filename)
	const filenameResult = checkMigrationFilenames(filenames)
	const errors = [...filenameResult.errors]
	const ledgerFilenames = ledger.migrations.map(({ filename }) => filename)
	const ledgerFilenameResult = checkMigrationFilenames(ledgerFilenames)

	if (ledger.baselineSha256 !== expectedMigrationBaselineSha256) {
		errors.push(
			`Migration ledger baseline digest changed. Baseline migrations are immutable; expected ${expectedMigrationBaselineSha256}.`,
		)
	}

	if (ledger.migrations.length < ledger.baselineCount) {
		errors.push(
			`Migration ledger contains ${String(ledger.migrations.length)} entries but its frozen baseline requires ${String(ledger.baselineCount)}.`,
		)
	} else {
		const baselineEntries = ledger.migrations.slice(0, ledger.baselineCount)
		const actualBaselineSha256 = getBaselineSha256(baselineEntries)
		if (actualBaselineSha256 !== ledger.baselineSha256) {
			errors.push(
				`Migration ledger baseline entries changed (expected digest ${ledger.baselineSha256}, received ${actualBaselineSha256}). Baseline entries cannot be edited, reordered, renamed, or deleted.`,
			)
		}
		const actualBaselineMaximum = getMaxMigrationPrefix(
			baselineEntries.map(({ filename }) => filename),
		)
		if (actualBaselineMaximum !== ledger.baselineMaximumPrefix) {
			errors.push(
				`Migration ledger baseline maximum is ${String(actualBaselineMaximum)}, not the recorded ${String(ledger.baselineMaximumPrefix)}.`,
			)
		}
	}

	if (!ledgerFilenameResult.ok) {
		errors.push(
			...ledgerFilenameResult.errors.map((error) => `Ledger: ${error}`),
		)
	}

	const sortedLedgerFilenames = [...ledgerFilenames].sort()
	if (
		sortedLedgerFilenames.some(
			(filename, index) => filename !== ledgerFilenames[index],
		)
	) {
		errors.push(
			'Migration ledger entries must remain in lexicographic filename order; append new migrations without reordering history.',
		)
	}

	for (const entry of ledger.migrations.slice(ledger.baselineCount)) {
		const parsed = parseMigrationFilename(entry.filename)
		if (parsed && Number(parsed.prefix) <= ledger.baselineMaximumPrefix) {
			errors.push(
				`Migration "${entry.filename}" was added at or below frozen baseline maximum ${formatMigrationPrefix(ledger.baselineMaximumPrefix)}. Additions must use a higher prefix.`,
			)
		}
	}

	const filesByName = new Map(files.map((entry) => [entry.filename, entry]))
	const ledgerByName = new Map(
		ledger.migrations.map((entry) => [entry.filename, entry]),
	)
	for (const entry of ledger.migrations) {
		const file = filesByName.get(entry.filename)
		if (!file) {
			errors.push(
				`Ledgered migration "${entry.filename}" is missing. Applied migrations cannot be deleted or renamed.`,
			)
		} else if (file.sha256 !== entry.sha256) {
			errors.push(
				`Ledgered migration "${entry.filename}" was modified (expected sha256 ${entry.sha256}, received ${file.sha256}). Applied migrations are immutable.`,
			)
		}
	}
	for (const file of files) {
		if (!ledgerByName.has(file.filename)) {
			errors.push(
				`Migration "${file.filename}" is not in ${defaultMigrationLedgerPath}. Append its filename and sha256 after choosing a prefix above the ledger maximum.`,
			)
		}
	}

	return {
		...filenameResult,
		ok: errors.length === 0,
		errors,
	}
}

export async function readMigrationLedger(
	ledgerPath: string = defaultMigrationLedgerPath,
): Promise<MigrationLedger> {
	const parsed: unknown = JSON.parse(await readFile(ledgerPath, 'utf8'))
	if (!isMigrationLedger(parsed)) {
		throw new Error(`Invalid migration ledger structure in ${ledgerPath}.`)
	}
	return parsed
}

export async function checkMigrationsDirectory(
	migrationsDir: string = defaultMigrationsDir,
	ledgerPath: string = defaultMigrationLedgerPath,
): Promise<MigrationFilenameCheckResult> {
	const directoryEntries = await readdir(migrationsDir, {
		withFileTypes: true,
	})
	const filenames = directoryEntries
		.filter((entry) => entry.isFile())
		.map(({ name }) => name)
	const files = await Promise.all(
		filenames.map(async (filename) => ({
			filename,
			sha256: sha256(await readFile(path.join(migrationsDir, filename))),
		})),
	)
	const ledger = await readMigrationLedger(ledgerPath)
	return checkMigrationLedger(files, ledger)
}

export async function main(
	migrationsDir: string = defaultMigrationsDir,
): Promise<void> {
	const result = await checkMigrationsDirectory(migrationsDir)
	if (!result.ok) {
		console.error(
			`Migration filename check failed for ${migrationsDir} (${String(result.errors.length)} issue(s)):`,
		)
		for (const error of result.errors) {
			console.error(`  - ${error}`)
		}
		process.exitCode = 1
		return
	}

	const fileCount = (await readdir(migrationsDir)).length
	console.log(
		`Migration ledger ok: ${String(fileCount)} file(s) in ${migrationsDir} (next free prefix ${result.nextPrefix}).`,
	)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
