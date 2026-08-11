import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { parseJsonc } from './ci/resource-utils.ts'
import { isExecutedDirectly } from './node-runtime.ts'

export const defaultDurableObjectBaselinePath = path.join(
	'tools',
	'ci',
	'durable-object-baseline.json',
)
export const defaultDurableObjectDeletionAllowlistPath = path.join(
	'tools',
	'ci',
	'do-deletion-allowlist.json',
)
export const defaultWorkflowDirectory = path.join('.github', 'workflows')

type ProtectedMigration = {
	tag: string
	new_sqlite_classes: Array<string>
	/** Migration list location; defaults to the top-level "migrations". */
	location?: string
}

type TransferredClass = {
	from: string
	from_script: string
	to: string
}

type ProtectedTransferMigration = {
	tag: string
	transferred_classes: Array<TransferredClass>
	/** Migration list location; defaults to the top-level "migrations". */
	location?: string
}

type ProtectedBindingSet = {
	location: string
	bindings: Array<DurableObjectBinding>
}

type DurableObjectBaselineConfig = {
	path: string
	protected_migrations: Array<ProtectedMigration>
	protected_transfer_migrations?: Array<ProtectedTransferMigration>
	protected_binding_sets: Array<ProtectedBindingSet>
}

export type DurableObjectBaseline = {
	version: 1
	configs: Array<DurableObjectBaselineConfig>
}

type AllowedDeletion = {
	config: string
	tag: string
	classes: Array<string>
}

export type DurableObjectDeletionAllowlist = {
	version: 1
	deletions: Array<AllowedDeletion>
}

type WranglerMigration = {
	tag?: unknown
	new_sqlite_classes?: unknown
	transferred_classes?: unknown
	deleted_classes?: unknown
}

type WranglerConfig = {
	migrations?: unknown
	[key: string]: unknown
}

type DurableObjectBinding = {
	name: string
	class_name: string
	script_name?: string
	environment?: string
}

export type DeployGuardrailCheckResult = {
	ok: boolean
	errors: Array<string>
}

const destructiveWorkflowCommandPattern =
	/\b(?:wrangler\s+delete|d1\s+delete|r2\s+bucket\s+delete|kv\s+namespace\s+delete)\b/i

function sortedStrings(value: unknown): Array<string> | null {
	if (
		!Array.isArray(value) ||
		!value.every((entry) => typeof entry === 'string')
	) {
		return null
	}
	return [...value].sort()
}

function sameStrings(
	left: ReadonlyArray<string>,
	right: ReadonlyArray<string>,
): boolean {
	return (
		left.length === right.length &&
		left.every((entry, index) => entry === right[index])
	)
}

function normalizeTransferredClasses(
	value: unknown,
): Array<TransferredClass> | null {
	if (!Array.isArray(value)) return null
	const transfers: Array<TransferredClass> = []
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') return null
		const candidate = entry as Record<string, unknown>
		if (
			typeof candidate.from !== 'string' ||
			typeof candidate.from_script !== 'string' ||
			typeof candidate.to !== 'string'
		) {
			return null
		}
		transfers.push({
			from: candidate.from,
			from_script: candidate.from_script,
			to: candidate.to,
		})
	}
	return transfers
}

function transferKey(transfer: TransferredClass): string {
	return JSON.stringify([transfer.from, transfer.from_script, transfer.to])
}

function sortedTransferKeys(
	transfers: ReadonlyArray<TransferredClass>,
): Array<string> {
	return transfers.map((transfer) => transferKey(transfer)).sort()
}

function deletionKey(deletion: AllowedDeletion): string {
	return JSON.stringify([
		deletion.config,
		deletion.tag,
		...deletion.classes.toSorted(),
	])
}

function normalizeBinding(value: unknown): DurableObjectBinding | null {
	if (!value || typeof value !== 'object') return null
	const candidate = value as Record<string, unknown>
	if (
		typeof candidate.name !== 'string' ||
		typeof candidate.class_name !== 'string' ||
		(candidate.script_name !== undefined &&
			typeof candidate.script_name !== 'string') ||
		(candidate.environment !== undefined &&
			typeof candidate.environment !== 'string')
	) {
		return null
	}
	return {
		name: candidate.name,
		class_name: candidate.class_name,
		...(candidate.script_name === undefined
			? {}
			: { script_name: candidate.script_name }),
		...(candidate.environment === undefined
			? {}
			: { environment: candidate.environment }),
	}
}

function bindingKey(binding: DurableObjectBinding): string {
	return JSON.stringify([
		binding.name,
		binding.class_name,
		binding.script_name ?? null,
		binding.environment ?? null,
	])
}

function collectDurableObjectBindings(
	value: unknown,
	location = '',
	result = new Map<string, Array<DurableObjectBinding>>(),
): Map<string, Array<DurableObjectBinding>> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return result
	}

	for (const [key, child] of Object.entries(value)) {
		const childLocation = location ? `${location}.${key}` : key
		if (key === 'durable_objects' && child && typeof child === 'object') {
			const bindings = (child as { bindings?: unknown }).bindings
			if (Array.isArray(bindings)) {
				result.set(
					childLocation,
					bindings
						.map((binding) => normalizeBinding(binding))
						.filter(
							(binding): binding is DurableObjectBinding => binding !== null,
						)
						.toSorted((left, right) =>
							bindingKey(left).localeCompare(bindingKey(right)),
						),
				)
			}
		}
		collectDurableObjectBindings(child, childLocation, result)
	}
	return result
}

const defaultMigrationLocation = 'migrations'

type MigrationSection = {
	location: string
	migrations: Array<WranglerMigration>
}

/**
 * Collects every Durable Object migration list in the config: the top-level
 * `migrations` plus each environment-specific `env.<name>.migrations`
 * override (wrangler environments may declare their own list, e.g. the
 * runtime worker's preview `new_sqlite_classes`).
 */
function collectMigrationSections(
	config: WranglerConfig,
): Array<MigrationSection> {
	const sections: Array<MigrationSection> = []
	if (Array.isArray(config.migrations)) {
		sections.push({
			location: defaultMigrationLocation,
			migrations: config.migrations as Array<WranglerMigration>,
		})
	}
	const env = config.env
	if (env && typeof env === 'object' && !Array.isArray(env)) {
		for (const [envName, envConfig] of Object.entries(env)) {
			if (!envConfig || typeof envConfig !== 'object') continue
			const envMigrations = (envConfig as { migrations?: unknown }).migrations
			if (Array.isArray(envMigrations)) {
				sections.push({
					location: `env.${envName}.migrations`,
					migrations: envMigrations as Array<WranglerMigration>,
				})
			}
		}
	}
	return sections
}

export function checkDurableObjectConfig(
	configPath: string,
	config: WranglerConfig,
	baseline: DurableObjectBaselineConfig,
	allowlist: DurableObjectDeletionAllowlist,
): Array<string> {
	const errors: Array<string> = []
	const sections = collectMigrationSections(config)
	const migrationsByLocationAndTag = new Map<string, WranglerMigration>()

	// Duplicate-tag validation is scoped per migration list: an environment
	// override may legitimately reuse a tag (e.g. "v1") that the top level
	// also uses.
	for (const section of sections) {
		const seenTags = new Set<string>()
		for (const migration of section.migrations) {
			if (typeof migration.tag === 'string') {
				if (seenTags.has(migration.tag)) {
					errors.push(
						`${configPath}: duplicate Durable Object migration tag "${migration.tag}" in ${section.location}.`,
					)
				}
				seenTags.add(migration.tag)
				migrationsByLocationAndTag.set(
					`${section.location}\u0000${migration.tag}`,
					migration,
				)
			}
		}
	}

	for (const protectedMigration of baseline.protected_migrations) {
		const location = protectedMigration.location ?? defaultMigrationLocation
		const current = migrationsByLocationAndTag.get(
			`${location}\u0000${protectedMigration.tag}`,
		)
		const currentClasses = sortedStrings(current?.new_sqlite_classes)
		const expectedClasses = protectedMigration.new_sqlite_classes.toSorted()
		if (!currentClasses || !sameStrings(currentClasses, expectedClasses)) {
			errors.push(
				`${configPath}: protected new_sqlite_classes migration "${protectedMigration.tag}" at ${location} was removed, renamed, or changed (expected ${expectedClasses.join(', ')}).`,
			)
		}
	}
	const protectedMigrationKeys = new Set(
		baseline.protected_migrations.map(
			({ tag, location }) =>
				`${location ?? defaultMigrationLocation}\u0000${tag}`,
		),
	)
	for (const section of sections) {
		for (const migration of section.migrations) {
			if (
				migration.new_sqlite_classes !== undefined &&
				typeof migration.tag === 'string' &&
				!protectedMigrationKeys.has(`${section.location}\u0000${migration.tag}`)
			) {
				errors.push(
					`${configPath}: new_sqlite_classes migration "${migration.tag}" at ${section.location} is not recorded in ${defaultDurableObjectBaselinePath}. Update the reviewed baseline so this migration remains protected after it lands.`,
				)
			}
		}
	}

	// Transfer migrations move Durable Object storage between scripts;
	// changing or removing one after it ships would orphan or duplicate
	// storage, so every transferred_classes migration must exactly match a
	// reviewed baseline entry.
	const protectedTransferMigrations =
		baseline.protected_transfer_migrations ?? []
	for (const protectedTransfer of protectedTransferMigrations) {
		const location = protectedTransfer.location ?? defaultMigrationLocation
		const current = migrationsByLocationAndTag.get(
			`${location}\u0000${protectedTransfer.tag}`,
		)
		const currentTransfers = normalizeTransferredClasses(
			current?.transferred_classes,
		)
		if (
			!currentTransfers ||
			!sameStrings(
				sortedTransferKeys(currentTransfers),
				sortedTransferKeys(protectedTransfer.transferred_classes),
			)
		) {
			errors.push(
				`${configPath}: protected transferred_classes migration "${protectedTransfer.tag}" at ${location} was removed, renamed, or changed (expected ${protectedTransfer.transferred_classes.map((transfer) => `${transfer.from_script}/${transfer.from} -> ${transfer.to}`).join(', ')}).`,
			)
		}
	}
	const protectedTransferKeys = new Set(
		protectedTransferMigrations.map(
			({ tag, location }) =>
				`${location ?? defaultMigrationLocation}\u0000${tag}`,
		),
	)
	for (const section of sections) {
		for (const migration of section.migrations) {
			if (
				migration.transferred_classes !== undefined &&
				typeof migration.tag === 'string' &&
				!protectedTransferKeys.has(`${section.location}\u0000${migration.tag}`)
			) {
				errors.push(
					`${configPath}: transferred_classes migration "${migration.tag}" at ${section.location} is not recorded in ${defaultDurableObjectBaselinePath}. Update the reviewed baseline so this migration remains protected after it lands.`,
				)
			}
		}
	}

	const allowedDeletionKeys = new Set(
		allowlist.deletions.map((deletion) => deletionKey(deletion)),
	)
	for (const section of sections) {
		for (const migration of section.migrations) {
			if (migration.deleted_classes === undefined) continue
			const classes = sortedStrings(migration.deleted_classes)
			if (
				typeof migration.tag !== 'string' ||
				!classes ||
				classes.length === 0
			) {
				errors.push(
					`${configPath}: every deleted_classes migration must have a string tag and a non-empty string class list.`,
				)
				continue
			}
			const candidate = {
				config: configPath,
				tag: migration.tag,
				classes,
			}
			if (!allowedDeletionKeys.has(deletionKey(candidate))) {
				errors.push(
					`${configPath}: destructive deletion ${migration.tag} [${classes.join(', ')}] is not an exact entry in ${defaultDurableObjectDeletionAllowlistPath}. Durable Object class deletion requires an explicit reviewed allowlist change.`,
				)
			}
		}
	}

	const bindingSets = collectDurableObjectBindings(config)
	for (const protectedSet of baseline.protected_binding_sets) {
		const currentBindings = bindingSets.get(protectedSet.location) ?? []
		const expectedBindings = protectedSet.bindings.toSorted((left, right) =>
			bindingKey(left).localeCompare(bindingKey(right)),
		)
		const currentClasses = new Set(
			currentBindings.map(({ class_name }) => class_name),
		)
		const expectedClasses = new Set(
			expectedBindings.map(({ class_name }) => class_name),
		)
		const removedClasses = [...expectedClasses].filter(
			(className) => !currentClasses.has(className),
		)
		for (const className of removedClasses) {
			errors.push(
				`${configPath}: protected Durable Object class "${className}" was removed from bindings at ${protectedSet.location}. Update the reviewed baseline only for an intentional removal.`,
			)
		}
		if (
			removedClasses.length === 0 &&
			!sameStrings(
				currentBindings.map((binding) => bindingKey(binding)),
				expectedBindings.map((binding) => bindingKey(binding)),
			)
		) {
			errors.push(
				`${configPath}: Durable Object binding identities at ${protectedSet.location} do not match ${defaultDurableObjectBaselinePath}. Binding name, class_name, script_name, and environment are protected; update the reviewed baseline only for an intentional change.`,
			)
		}
	}

	return errors
}

function isWorkflowDispatchOnly(source: string): boolean {
	const lines = source.split('\n')
	const onIndex = lines.findIndex((line) => /^on:\s*$/.test(line))
	if (onIndex === -1) return false
	const eventNames: Array<string> = []
	for (const line of lines.slice(onIndex + 1)) {
		if (/^\S/.test(line) && line.trim() !== '') break
		const match = /^ {2}([a-zA-Z_]+):/.exec(line)
		if (match?.[1]) eventNames.push(match[1])
	}
	return eventNames.length === 1 && eventNames[0] === 'workflow_dispatch'
}

function jobAllowsOnlyWorkflowDispatch(jobSource: string): boolean {
	const lines = jobSource.split('\n')
	const ifIndex = lines.findIndex((line) => /^ {4}if:\s*/.test(line))
	if (ifIndex === -1) return false
	const conditionLines = [lines[ifIndex] ?? '']
	for (const line of lines.slice(ifIndex + 1)) {
		if (/^ {4}\S/.test(line)) break
		conditionLines.push(line)
	}
	const condition = conditionLines.join(' ')
	return (
		!/\|\||\bor\b/i.test(condition) &&
		(/github\.event_name\s*==\s*['"]workflow_dispatch['"]/.test(condition) ||
			/['"]workflow_dispatch['"]\s*==\s*github\.event_name/.test(condition))
	)
}

export function checkWorkflowSource(
	workflowPath: string,
	source: string,
): Array<string> {
	if (isWorkflowDispatchOnly(source)) return []

	const lines = source.split('\n')
	const errors: Array<string> = []
	const jobStarts = lines
		.map((line, index) => ({
			index,
			match: /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line),
		}))
		.filter(
			(entry): entry is { index: number; match: RegExpExecArray } =>
				entry.match !== null,
		)

	for (const [lineIndex, line] of lines.entries()) {
		const command = line.replace(/^\s*#.*$/, '')
		if (!destructiveWorkflowCommandPattern.test(command)) continue
		const jobStart = jobStarts.findLast((entry) => entry.index <= lineIndex)
		const nextJobStart = jobStarts.find(
			(entry) => entry.index > (jobStart?.index ?? lineIndex),
		)
		const jobSource = jobStart
			? lines
					.slice(jobStart.index, nextJobStart?.index ?? lines.length)
					.join('\n')
			: ''
		if (!jobAllowsOnlyWorkflowDispatch(jobSource)) {
			errors.push(
				`${workflowPath}:${String(lineIndex + 1)} invokes a destructive Cloudflare CLI operation outside a job explicitly restricted to workflow_dispatch. Destructive resource deletion must be operator-triggered, never automatic.`,
			)
		}
	}
	return errors
}

export async function checkDeployGuardrails(
	baselinePath = defaultDurableObjectBaselinePath,
	allowlistPath = defaultDurableObjectDeletionAllowlistPath,
	workflowDirectory = defaultWorkflowDirectory,
): Promise<DeployGuardrailCheckResult> {
	const baseline = JSON.parse(
		await readFile(baselinePath, 'utf8'),
	) as DurableObjectBaseline
	const allowlist = JSON.parse(
		await readFile(allowlistPath, 'utf8'),
	) as DurableObjectDeletionAllowlist
	const errors: Array<string> = []

	for (const baselineConfig of baseline.configs) {
		const source = await readFile(baselineConfig.path, 'utf8')
		const config = parseJsonc<WranglerConfig>(source)
		errors.push(
			...checkDurableObjectConfig(
				baselineConfig.path,
				config,
				baselineConfig,
				allowlist,
			),
		)
	}

	const workflowFilenames = (await readdir(workflowDirectory))
		.filter((filename) => /\.ya?ml$/.test(filename))
		.sort()
	for (const filename of workflowFilenames) {
		const workflowPath = path.join(workflowDirectory, filename)
		errors.push(
			...checkWorkflowSource(
				workflowPath,
				await readFile(workflowPath, 'utf8'),
			),
		)
	}

	return { ok: errors.length === 0, errors }
}

export async function main(): Promise<void> {
	const result = await checkDeployGuardrails()
	if (!result.ok) {
		console.error(
			`Deploy guardrail check failed (${String(result.errors.length)} issue(s)):`,
		)
		for (const error of result.errors) console.error(`  - ${error}`)
		process.exitCode = 1
		return
	}
	console.log(
		'Deploy guardrails ok: Durable Object history/bindings and workflow deletion policy are protected.',
	)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
