import { expect, test } from 'vitest'
import {
	allowedHistoricalDuplicateMigrationFilenames,
	checkMigrationFilenames,
	checkMigrationLedger,
	checkMigrationsDirectory,
	formatMigrationPrefix,
	getMaxMigrationPrefix,
	getNextMigrationPrefix,
	hashMigrationContent,
	parseMigrationFilename,
	readMigrationLedger,
	type MigrationLedgerEntry,
	type TrustedMigrationHistory,
} from './check-migrations.ts'

const historicalPair0009 = [
	'0009-secret-allowed-hosts.sql',
	'0009-ui-artifact-parameters.sql',
] as const

const uniqueMigrations = [
	'0001-init.sql',
	'0002-chat-threads.sql',
	'0075-stable-user-id-not-null.sql',
	'0077-drop-email-raw-mime-inline.sql',
] as const

function expectErrorsMention(
	errors: ReadonlyArray<string>,
	needles: ReadonlyArray<string>,
) {
	for (const needle of needles) {
		expect(errors.some((error) => error.includes(needle))).toBe(true)
	}
}

test('migration filename helpers parse, score prefixes, and accept unique plus grandfathered pairs', async () => {
	expect(parseMigrationFilename('0001-init.sql')).toEqual({
		prefix: '0001',
		description: 'init',
	})
	expect(parseMigrationFilename('0075-stable-user-id-not-null.sql')).toEqual({
		prefix: '0075',
		description: 'stable-user-id-not-null',
	})
	expect(parseMigrationFilename('1-init.sql')).toBeNull()
	expect(parseMigrationFilename('0001_init.sql')).toBeNull()
	expect(parseMigrationFilename('0001-Init.sql')).toBeNull()
	expect(parseMigrationFilename('0001-init-.sql')).toBeNull()
	expect(parseMigrationFilename('0001-.sql')).toBeNull()
	expect(parseMigrationFilename('0001-init.SQL')).toBeNull()
	expect(parseMigrationFilename('readme.md')).toBeNull()
	expect(parseMigrationFilename('0001-init.sql.bak')).toBeNull()

	const filenamesWithGap = [
		'0001-init.sql',
		'0038-backfill-usernames.sql',
		// Gap at 0039 is intentional and must not be treated as an error.
		'0040-drop-source-rescue-events.sql',
		'0075-stable-user-id-not-null.sql',
	]
	expect(getMaxMigrationPrefix(filenamesWithGap)).toBe(75)
	expect(getNextMigrationPrefix(filenamesWithGap)).toBe('0076')
	expect(formatMigrationPrefix(76)).toBe('0076')
	expect(formatMigrationPrefix(1)).toBe('0001')
	expect(getNextMigrationPrefix([])).toBe('0001')
	expect(
		getNextMigrationPrefix([...filenamesWithGap, '9999-BadName.sql']),
	).toBe('0076')

	const withGap = checkMigrationFilenames(filenamesWithGap)
	expect(withGap).toMatchObject({ ok: true, errors: [], nextPrefix: '0076' })

	const validUnique = checkMigrationFilenames([...uniqueMigrations])
	expect(validUnique).toMatchObject({
		ok: true,
		errors: [],
		nextPrefix: '0078',
		maxPrefix: 77,
	})

	const withHistoricalPairs = checkMigrationFilenames([
		...uniqueMigrations,
		...allowedHistoricalDuplicateMigrationFilenames,
	])
	expect(withHistoricalPairs.ok).toBe(true)
	expect(withHistoricalPairs.errors).toEqual([])

	// Exact allowlist pin: applied D1 migrations cannot be renamed.
	expect([...allowedHistoricalDuplicateMigrationFilenames]).toEqual([
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
	])

	const live = await checkMigrationsDirectory()
	expect(live.ok).toBe(true)
	expect(live.errors).toEqual([])
	expect(live.nextPrefix).toBe(formatMigrationPrefix(live.maxPrefix + 1))
	expect(live.nextPrefix).toMatch(/^\d{4}$/)
})

test('migration ledger rejects historical mutation and lower-prefix additions while accepting monotonic additions', async () => {
	const ledger = await readMigrationLedger()
	const baselineFiles = ledger.migrations.map((entry) => ({ ...entry }))
	const trustedHistory: TrustedMigrationHistory = {
		ref: 'trusted-base',
		files: baselineFiles,
		ledgerEntries: baselineFiles,
	}

	expect(
		checkMigrationLedger(baselineFiles, ledger, trustedHistory),
	).toMatchObject({
		ok: true,
		errors: [],
		nextPrefix: '0084',
		maxPrefix: 83,
	})

	const modifiedFiles = baselineFiles.map((entry) =>
		entry.filename === '0001-init.sql'
			? { ...entry, sha256: '0'.repeat(64) }
			: entry,
	)
	const modified = checkMigrationLedger(modifiedFiles, ledger, trustedHistory)
	expect(modified.ok).toBe(false)
	expectErrorsMention(modified.errors, ['0001-init.sql', 'modified'])

	const withoutHistoricalPairMember = baselineFiles.filter(
		(entry) => entry.filename !== historicalPair0009[0],
	)
	const deleted = checkMigrationLedger(
		withoutHistoricalPairMember,
		ledger,
		trustedHistory,
	)
	expect(deleted.ok).toBe(false)
	expectErrorsMention(deleted.errors, [
		historicalPair0009[0],
		'missing',
		'cannot be deleted or renamed',
	])

	const renamedFiles = baselineFiles.map((entry) =>
		entry.filename === historicalPair0009[1]
			? { ...entry, filename: '0009-renamed.sql' }
			: entry,
	)
	const renamed = checkMigrationLedger(renamedFiles, ledger, trustedHistory)
	expect(renamed.ok).toBe(false)
	expectErrorsMention(renamed.errors, [
		historicalPair0009[1],
		'missing',
		'0009-renamed.sql',
		'not in tools/migration-ledger.json',
	])

	const lowerAddition: MigrationLedgerEntry = {
		filename: '0039-too-low.sql',
		sha256: '1'.repeat(64),
	}
	const ledgerWithLowerAddition = structuredClone(ledger)
	ledgerWithLowerAddition.migrations.push(lowerAddition)
	const lower = checkMigrationLedger(
		[...baselineFiles, lowerAddition],
		ledgerWithLowerAddition,
		trustedHistory,
	)
	expect(lower.ok).toBe(false)
	expectErrorsMention(lower.errors, [
		'0039-too-low.sql',
		'at or below frozen baseline maximum 0083',
	])

	const monotonicAddition: MigrationLedgerEntry = {
		filename: '0084-normal-addition.sql',
		sha256: '2'.repeat(64),
	}
	const ledgerWithMonotonicAddition = structuredClone(ledger)
	ledgerWithMonotonicAddition.migrations.push(monotonicAddition)
	expect(
		checkMigrationLedger(
			[...baselineFiles, monotonicAddition],
			ledgerWithMonotonicAddition,
			trustedHistory,
		),
	).toMatchObject({
		ok: true,
		errors: [],
		nextPrefix: '0085',
		maxPrefix: 84,
	})
})

test('trusted history rejects a migration and ledger digest co-edit', async () => {
	const ledger = await readMigrationLedger()
	const bootstrapFiles = ledger.migrations.map((entry) => ({ ...entry }))
	const historicalEntry = {
		filename: '0084-historical.sql',
		sha256: hashMigrationContent('SELECT 1;\n'),
	}
	const trustedHistory: TrustedMigrationHistory = {
		ref: 'trusted-base-with-0084',
		files: [...bootstrapFiles, historicalEntry],
		ledgerEntries: [...bootstrapFiles, historicalEntry],
	}
	const editedEntry = {
		...historicalEntry,
		sha256: hashMigrationContent('SELECT 2;\n'),
	}
	const editedLedger = structuredClone(ledger)
	editedLedger.migrations.push(editedEntry)

	const result = checkMigrationLedger(
		[...bootstrapFiles, editedEntry],
		editedLedger,
		trustedHistory,
	)
	expect(result.ok).toBe(false)
	expectErrorsMention(result.errors, [
		'0084-historical.sql',
		'Historical ledger entries cannot be edited',
		'differs from trusted history',
		'Migration and ledger digests cannot be changed together',
	])

	const withoutTrustedBase = checkMigrationLedger(
		[...bootstrapFiles, editedEntry],
		editedLedger,
	)
	expect(withoutTrustedBase.ok).toBe(false)
	expectErrorsMention(withoutTrustedBase.errors, [
		'no trusted Git base is available',
		'Fetch origin/main history',
	])
})

test('migration content hashing canonicalizes CRLF to LF', () => {
	expect(hashMigrationContent('CREATE TABLE example (id TEXT);\r\n')).toBe(
		hashMigrationContent('CREATE TABLE example (id TEXT);\n'),
	)
	expect(hashMigrationContent('line one\r\nline two\r\n')).toBe(
		hashMigrationContent('line one\nline two\n'),
	)
})

test('checkMigrationFilenames rejects malformed names, ordinary duplicates, and non-allowlisted prefix reuse', () => {
	const malformed = checkMigrationFilenames([
		'0001-init.sql',
		'0002-BadName.sql',
		'notes.txt',
		'0075-stable-user-id-not-null.sql',
	])
	expect(malformed.ok).toBe(false)
	expect(malformed.nextPrefix).toBe('0076')
	expect(malformed.errors).toHaveLength(2)
	expectErrorsMention(malformed.errors, ['0002-BadName.sql', 'notes.txt'])

	const ordinaryDuplicate = checkMigrationFilenames([
		'0001-init.sql',
		'0024-repo-sessions-and-source-columns.sql',
		'0024-extra-change.sql',
		'0075-stable-user-id-not-null.sql',
	])
	expect(ordinaryDuplicate.ok).toBe(false)
	expect(ordinaryDuplicate.nextPrefix).toBe('0076')
	expect(ordinaryDuplicate.errors).toHaveLength(1)
	expectErrorsMention(ordinaryDuplicate.errors, [
		'0024',
		'0024-extra-change.sql',
		'0024-repo-sessions-and-source-columns.sql',
	])
	expect(ordinaryDuplicate.errors[0]).not.toMatch(/grandfathered/i)

	const exactPair = checkMigrationFilenames([
		'0001-init.sql',
		...historicalPair0009,
		'0075-stable-user-id-not-null.sql',
	])
	expect(exactPair.ok).toBe(true)
	expect(exactPair.errors).toEqual([])

	const thirdReuse = checkMigrationFilenames([
		'0001-init.sql',
		...historicalPair0009,
		'0009-another-change.sql',
		'0075-stable-user-id-not-null.sql',
	])
	expect(thirdReuse.ok).toBe(false)
	expect(thirdReuse.nextPrefix).toBe('0076')
	expect(thirdReuse.errors).toHaveLength(1)
	expectErrorsMention(thirdReuse.errors, [
		'0009',
		'0009-another-change.sql',
		'0009-secret-allowed-hosts.sql',
		'0009-ui-artifact-parameters.sql',
	])

	const nonAllowlistedPairMember = checkMigrationFilenames([
		'0001-init.sql',
		'0009-secret-allowed-hosts.sql',
		'0009-renamed-not-allowlisted.sql',
		'0075-stable-user-id-not-null.sql',
	])
	expect(nonAllowlistedPairMember.ok).toBe(false)
	expect(nonAllowlistedPairMember.errors).toHaveLength(1)
	expectErrorsMention(nonAllowlistedPairMember.errors, [
		'0009-renamed-not-allowlisted.sql',
	])
})
