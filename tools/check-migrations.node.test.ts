import { expect, test } from 'vitest'
import {
	allowedHistoricalDuplicateMigrationFilenames,
	checkMigrationFilenames,
	checkMigrationsDirectory,
	formatMigrationPrefix,
	getMaxMigrationPrefix,
	getNextMigrationPrefix,
	parseMigrationFilename,
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
