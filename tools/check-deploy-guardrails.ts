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
}

type ProtectedBindingSet = {
	location: string
	classes: Array<string>
}

type DurableObjectBaselineConfig = {
	path: string
	protected_migrations: Array<ProtectedMigration>
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
	deleted_classes?: unknown
}

type WranglerConfig = {
	migrations?: unknown
	[key: string]: unknown
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

function deletionKey(deletion: AllowedDeletion): string {
	return JSON.stringify([
		deletion.config,
		deletion.tag,
		...deletion.classes.toSorted(),
	])
}

function collectDurableObjectBindingClasses(
	value: unknown,
	location = '',
	result = new Map<string, Set<string>>(),
): Map<string, Set<string>> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return result
	}

	for (const [key, child] of Object.entries(value)) {
		const childLocation = location ? `${location}.${key}` : key
		if (key === 'durable_objects' && child && typeof child === 'object') {
			const bindings = (child as { bindings?: unknown }).bindings
			if (Array.isArray(bindings)) {
				const classes = new Set<string>()
				for (const binding of bindings) {
					if (
						binding &&
						typeof binding === 'object' &&
						typeof (binding as { class_name?: unknown }).class_name === 'string'
					) {
						classes.add((binding as { class_name: string }).class_name)
					}
				}
				result.set(childLocation, classes)
			}
		}
		collectDurableObjectBindingClasses(child, childLocation, result)
	}
	return result
}

export function checkDurableObjectConfig(
	configPath: string,
	config: WranglerConfig,
	baseline: DurableObjectBaselineConfig,
	allowlist: DurableObjectDeletionAllowlist,
): Array<string> {
	const errors: Array<string> = []
	const migrations = Array.isArray(config.migrations)
		? (config.migrations as Array<WranglerMigration>)
		: []
	const migrationsByTag = new Map<string, WranglerMigration>()

	for (const migration of migrations) {
		if (typeof migration.tag === 'string') {
			if (migrationsByTag.has(migration.tag)) {
				errors.push(
					`${configPath}: duplicate Durable Object migration tag "${migration.tag}".`,
				)
			}
			migrationsByTag.set(migration.tag, migration)
		}
	}

	for (const protectedMigration of baseline.protected_migrations) {
		const current = migrationsByTag.get(protectedMigration.tag)
		const currentClasses = sortedStrings(current?.new_sqlite_classes)
		const expectedClasses = protectedMigration.new_sqlite_classes.toSorted()
		if (!currentClasses || !sameStrings(currentClasses, expectedClasses)) {
			errors.push(
				`${configPath}: protected new_sqlite_classes migration "${protectedMigration.tag}" was removed, renamed, or changed (expected ${expectedClasses.join(', ')}).`,
			)
		}
	}
	const protectedMigrationTags = new Set(
		baseline.protected_migrations.map(({ tag }) => tag),
	)
	for (const migration of migrations) {
		if (
			migration.new_sqlite_classes !== undefined &&
			typeof migration.tag === 'string' &&
			!protectedMigrationTags.has(migration.tag)
		) {
			errors.push(
				`${configPath}: new_sqlite_classes migration "${migration.tag}" is not recorded in ${defaultDurableObjectBaselinePath}. Update the reviewed baseline so this migration remains protected after it lands.`,
			)
		}
	}

	const allowedDeletionKeys = new Set(
		allowlist.deletions.map((deletion) => deletionKey(deletion)),
	)
	for (const migration of migrations) {
		if (migration.deleted_classes === undefined) continue
		const classes = sortedStrings(migration.deleted_classes)
		if (typeof migration.tag !== 'string' || !classes || classes.length === 0) {
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

	const bindingSets = collectDurableObjectBindingClasses(config)
	for (const protectedSet of baseline.protected_binding_sets) {
		const currentClasses = bindingSets.get(protectedSet.location)
		const expectedClasses = protectedSet.classes.toSorted()
		const actualClasses = [...(currentClasses ?? [])].sort()
		const removedClasses = expectedClasses.filter(
			(className) => !currentClasses?.has(className),
		)
		for (const className of removedClasses) {
			errors.push(
				`${configPath}: protected Durable Object class "${className}" was removed from bindings at ${protectedSet.location}. Update the reviewed baseline only for an intentional removal.`,
			)
		}
		if (
			removedClasses.length === 0 &&
			!sameStrings(actualClasses, expectedClasses)
		) {
			errors.push(
				`${configPath}: Durable Object bindings at ${protectedSet.location} do not match ${defaultDurableObjectBaselinePath}. Record added classes in the reviewed baseline so they remain protected after landing.`,
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
