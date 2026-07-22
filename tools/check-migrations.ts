import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

export const defaultMigrationsDir = path.join(
	'packages',
	'worker',
	'migrations',
)

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
		const match = /^(?<prefix>\d{4})/.exec(filename)
		const prefix = match?.groups?.prefix
		if (!prefix) {
			continue
		}
		maxPrefix = Math.max(maxPrefix, Number(prefix))
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

export async function checkMigrationsDirectory(
	migrationsDir: string = defaultMigrationsDir,
): Promise<MigrationFilenameCheckResult> {
	const filenames = await readdir(migrationsDir)
	return checkMigrationFilenames(filenames)
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

	const filenames = await readdir(migrationsDir)
	console.log(
		`Migration filenames ok: ${String(filenames.length)} file(s) in ${migrationsDir} (next free prefix ${result.nextPrefix}).`,
	)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
