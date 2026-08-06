import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { isExecutedDirectly } from './node-runtime.ts'

const execFileAsync = promisify(execFile)

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
	'aee006f0719e4d967b7485fb3199f8e2eb0660258b7720661b7fc48ce67fc199'

/**
 * Exact grandfathered duplicate-prefix pairs. The 2026-08-04 migration
 * squash (0001-squashed-init.sql) retired every historical duplicate, so
 * this list is empty; new duplicates are always rejected.
 */
export const allowedHistoricalDuplicateMigrationFilenames = [] as const

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

export type TrustedMigrationHistory = {
	ref: string
	files: Array<MigrationLedgerEntry>
	ledgerEntries: Array<MigrationLedgerEntry>
	/**
	 * The trusted ref's own frozen baseline digest, or null when the ref has
	 * no ledger. When this differs from the current
	 * `expectedMigrationBaselineSha256`, the trusted ref sits on the other
	 * side of a migration squash and its per-file history is incomparable;
	 * cross-history checks are skipped for exactly that one transition while
	 * the frozen baseline and ledger integrity checks keep protecting the
	 * current epoch.
	 */
	ledgerBaselineSha256: string | null
}

type GitOutput = (
	args: ReadonlyArray<string>,
	options?: { trim?: boolean },
) => Promise<string | null>

export type TrustedMigrationBaseOptions = {
	env?: NodeJS.ProcessEnv
	git?: GitOutput
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

export function hashMigrationContent(value: string | Uint8Array): string {
	const text =
		typeof value === 'string' ? value : new TextDecoder().decode(value)
	const canonicalLfText = text.replace(/\r\n?/g, '\n')
	return createHash('sha256').update(canonicalLfText).digest('hex')
}

function getBaselineSha256(
	entries: ReadonlyArray<MigrationLedgerEntry>,
): string {
	return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

export function isMigrationLedger(value: unknown): value is MigrationLedger {
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
	trustedHistory: TrustedMigrationHistory | null = null,
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

	const isCrossEpochTrustedHistory =
		trustedHistory !== null &&
		trustedHistory.ledgerBaselineSha256 !== null &&
		trustedHistory.ledgerBaselineSha256 !== expectedMigrationBaselineSha256
	const comparableTrustedHistory = isCrossEpochTrustedHistory
		? null
		: trustedHistory
	const fallbackEntries = ledger.migrations.slice(0, ledger.baselineCount)
	const trustedFiles = comparableTrustedHistory?.files ?? fallbackEntries
	const trustedLedgerEntries =
		comparableTrustedHistory?.ledgerEntries ?? fallbackEntries
	const trustedMaximumPrefix = getMaxMigrationPrefix(
		trustedFiles.map(({ filename }) => filename),
	)

	if (
		!trustedHistory &&
		(ledger.migrations.length > ledger.baselineCount ||
			files.length > ledger.baselineCount)
	) {
		errors.push(
			'Cannot verify post-baseline migration history because no trusted Git base is available. Fetch origin/main history (CI uses fetch-depth: 0) and rerun validation.',
		)
	}

	for (const [index, trustedEntry] of trustedLedgerEntries.entries()) {
		const currentEntry = ledger.migrations[index]
		if (
			!currentEntry ||
			currentEntry.filename !== trustedEntry.filename ||
			currentEntry.sha256 !== trustedEntry.sha256
		) {
			errors.push(
				`Migration ledger history from ${comparableTrustedHistory?.ref ?? 'the frozen bootstrap baseline'} changed at "${trustedEntry.filename}". Historical ledger entries cannot be edited, reordered, or deleted.`,
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

	const trustedFilesByName = new Map(
		trustedFiles.map((entry) => [entry.filename, entry]),
	)
	for (const trustedFile of trustedFiles) {
		const currentFile = filesByName.get(trustedFile.filename)
		if (!currentFile) {
			errors.push(
				`Migration "${trustedFile.filename}" exists in trusted history ${comparableTrustedHistory?.ref ?? 'the frozen bootstrap baseline'} but is missing from the checkout.`,
			)
		} else if (currentFile.sha256 !== trustedFile.sha256) {
			errors.push(
				`Migration "${trustedFile.filename}" differs from trusted history ${comparableTrustedHistory?.ref ?? 'the frozen bootstrap baseline'}. Migration and ledger digests cannot be changed together.`,
			)
		}
	}
	for (const file of files) {
		if (trustedFilesByName.has(file.filename)) {
			continue
		}
		const parsed = parseMigrationFilename(file.filename)
		if (parsed && Number(parsed.prefix) <= trustedMaximumPrefix) {
			errors.push(
				`Migration "${file.filename}" is new relative to ${comparableTrustedHistory?.ref ?? 'the frozen bootstrap baseline'} but does not use a prefix above ${formatMigrationPrefix(trustedMaximumPrefix)}.`,
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

async function gitOutput(
	args: ReadonlyArray<string>,
	options: { trim?: boolean } = {},
): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('git', [...args], {
			encoding: 'utf8',
		})
		return options.trim === false ? stdout : stdout.trim()
	} catch {
		return null
	}
}

export async function resolveTrustedMigrationBase(
	options: TrustedMigrationBaseOptions = {},
): Promise<string | null> {
	const env = options.env ?? process.env
	const git = options.git ?? gitOutput
	const head = await git(['rev-parse', 'HEAD^{commit}'])
	if (!head) {
		return null
	}

	const explicitCandidates = [
		env.MIGRATION_VALIDATION_BASE,
		env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : undefined,
	].filter((candidate): candidate is string => Boolean(candidate))
	for (const candidate of explicitCandidates) {
		const commit = await git(['rev-parse', `${candidate}^{commit}`])
		if (commit && commit !== head) {
			return commit
		}
	}

	for (const candidate of ['origin/main', 'main']) {
		const mergeBase = await git(['merge-base', 'HEAD', candidate])
		if (mergeBase && mergeBase !== head) {
			return mergeBase
		}
	}

	const firstParent = await git(['rev-parse', 'HEAD^1'])
	return firstParent && firstParent !== head ? firstParent : null
}

export async function readTrustedMigrationHistory(
	ref: string,
): Promise<TrustedMigrationHistory> {
	const migrationRoot = defaultMigrationsDir.replaceAll(path.sep, '/')
	const filenamesOutput = await gitOutput([
		'ls-tree',
		'-r',
		'--name-only',
		ref,
		'--',
		migrationRoot,
	])
	if (filenamesOutput === null) {
		throw new Error(`Could not read migrations from trusted Git ref ${ref}.`)
	}
	const filenames = filenamesOutput
		.split('\n')
		.filter((filename) => filename.endsWith('.sql'))
		.map((filename) => path.posix.basename(filename))
		.sort()
	const files = await Promise.all(
		filenames.map(async (filename) => {
			const content = await gitOutput(
				['show', `${ref}:${migrationRoot}/${filename}`],
				{ trim: false },
			)
			if (content === null) {
				throw new Error(
					`Could not read migration "${filename}" from trusted Git ref ${ref}.`,
				)
			}
			return { filename, sha256: hashMigrationContent(content) }
		}),
	)

	const ledgerJson = await gitOutput(
		['show', `${ref}:${defaultMigrationLedgerPath.replaceAll(path.sep, '/')}`],
		{ trim: false },
	)
	let ledgerEntries = files
	let ledgerBaselineSha256: string | null = null
	if (ledgerJson !== null) {
		const parsed: unknown = JSON.parse(ledgerJson)
		if (!isMigrationLedger(parsed)) {
			throw new Error(
				`Invalid migration ledger structure at trusted Git ref ${ref}.`,
			)
		}
		ledgerEntries = parsed.migrations
		ledgerBaselineSha256 = parsed.baselineSha256
	}
	return { ref, files, ledgerEntries, ledgerBaselineSha256 }
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
			sha256: hashMigrationContent(
				await readFile(path.join(migrationsDir, filename)),
			),
		})),
	)
	const ledger = await readMigrationLedger(ledgerPath)
	const trustedBase = await resolveTrustedMigrationBase()
	const trustedHistory = trustedBase
		? await readTrustedMigrationHistory(trustedBase)
		: null
	return checkMigrationLedger(files, ledger, trustedHistory)
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
