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

test('parseMigrationFilename accepts NNNN-kebab-case-description.sql and rejects malformed names', () => {
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
})

test('checkMigrationFilenames accepts valid unique names and exact historical pairs', () => {
	const validUnique = checkMigrationFilenames([...uniqueMigrations])
	expect(validUnique.ok).toBe(true)
	expect(validUnique.errors).toEqual([])
	expect(validUnique.nextPrefix).toBe('0078')
	expect(validUnique.maxPrefix).toBe(77)

	const withHistoricalPairs = checkMigrationFilenames([
		...uniqueMigrations,
		...allowedHistoricalDuplicateMigrationFilenames,
	])
	expect(withHistoricalPairs.ok).toBe(true)
	expect(withHistoricalPairs.errors).toEqual([])
})

test('historical allowlist is pinned to the exact 14 filenames and live migrations pass', async () => {
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

test('checkMigrationFilenames reports malformed names with the offending file and next free prefix', () => {
	const result = checkMigrationFilenames([
		'0001-init.sql',
		'0002-BadName.sql',
		'notes.txt',
		'0075-stable-user-id-not-null.sql',
	])

	expect(result.ok).toBe(false)
	expect(result.nextPrefix).toBe('0076')
	expect(result.errors).toHaveLength(2)
	expect(result.errors[0]).toContain('0002-BadName.sql')
	expect(result.errors[0]).toContain('0076')
	expect(result.errors[0]).toContain('0076-your-change.sql')
	expect(result.errors[1]).toContain('notes.txt')
	expect(result.errors[1]).toContain('0076')
})

test('checkMigrationFilenames rejects ordinary duplicate prefixes with actionable guidance', () => {
	const result = checkMigrationFilenames([
		'0001-init.sql',
		'0024-repo-sessions-and-source-columns.sql',
		'0024-extra-change.sql',
		'0075-stable-user-id-not-null.sql',
	])

	expect(result.ok).toBe(false)
	expect(result.nextPrefix).toBe('0076')
	expect(result.errors).toHaveLength(1)
	expect(result.errors[0]).toContain('Duplicate migration prefix 0024')
	expect(result.errors[0]).toContain('0024-extra-change.sql')
	expect(result.errors[0]).toContain(
		'0024-repo-sessions-and-source-columns.sql',
	)
	expect(result.errors[0]).toContain('next free prefix 0076')
	expect(result.errors[0]).not.toContain('grandfathered')
})

test('checkMigrationFilenames allows exact historical pairs but rejects a third reuse or non-allowlisted file', () => {
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
	expect(thirdReuse.errors[0]).toContain('Duplicate migration prefix 0009')
	expect(thirdReuse.errors[0]).toContain('grandfathered pair')
	expect(thirdReuse.errors[0]).toContain('0009-secret-allowed-hosts.sql')
	expect(thirdReuse.errors[0]).toContain('0009-ui-artifact-parameters.sql')
	expect(thirdReuse.errors[0]).toContain(
		'Offending file(s): 0009-another-change.sql',
	)
	expect(thirdReuse.errors[0]).toContain('next free prefix 0076')

	const nonAllowlistedPairMember = checkMigrationFilenames([
		'0001-init.sql',
		'0009-secret-allowed-hosts.sql',
		'0009-renamed-not-allowlisted.sql',
		'0075-stable-user-id-not-null.sql',
	])
	expect(nonAllowlistedPairMember.ok).toBe(false)
	expect(nonAllowlistedPairMember.errors).toHaveLength(1)
	expect(nonAllowlistedPairMember.errors[0]).toContain(
		'Offending file(s): 0009-renamed-not-allowlisted.sql',
	)
	expect(nonAllowlistedPairMember.errors[0]).toContain('grandfathered pair')
	expect(nonAllowlistedPairMember.errors[0]).toContain('next free prefix 0076')
})

test('prefix helpers report max and next free numbers without gap checking', () => {
	const filenames = [
		'0001-init.sql',
		'0038-backfill-usernames.sql',
		// Gap at 0039 is intentional and must not be treated as an error.
		'0040-drop-source-rescue-events.sql',
		'0075-stable-user-id-not-null.sql',
	]
	expect(getMaxMigrationPrefix(filenames)).toBe(75)
	expect(getNextMigrationPrefix(filenames)).toBe('0076')
	expect(formatMigrationPrefix(76)).toBe('0076')
	expect(formatMigrationPrefix(1)).toBe('0001')

	const withGap = checkMigrationFilenames(filenames)
	expect(withGap.ok).toBe(true)
	expect(withGap.errors).toEqual([])
	expect(withGap.nextPrefix).toBe('0076')

	expect(getNextMigrationPrefix([])).toBe('0001')
})
