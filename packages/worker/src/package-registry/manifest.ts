import { z } from 'zod'
import {
	authoredPackageJsonSchema,
	type AuthoredPackageJson,
	type PackageExportTarget,
} from './types.ts'

const packageManifestPath = 'package.json'

function getExpectedKodyName(name: string) {
	const trimmed = name.trim()
	if (!trimmed.startsWith('@')) {
		return trimmed
	}

	const separator = trimmed.indexOf('/')
	return separator === -1 ? trimmed : trimmed.slice(separator + 1)
}

export function parseAuthoredPackageJson(input: {
	content: string
	manifestPath?: string
}): AuthoredPackageJson {
	let parsed: unknown
	try {
		parsed = JSON.parse(input.content)
	} catch (cause) {
		throw new Error(
			`Failed to parse ${input.manifestPath ?? packageManifestPath}: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		)
	}
	const result = authoredPackageJsonSchema.safeParse(parsed)
	if (!result.success) {
		const formatted = z.prettifyError(result.error)
		throw new Error(
			`Invalid ${input.manifestPath ?? packageManifestPath}:\n${formatted}`,
		)
	}

	const manifest = result.data
	const expectedKodyId = getExpectedKodyName(manifest.name)
	if (expectedKodyId !== manifest.kody.id) {
		throw new Error(
			`Invalid ${input.manifestPath ?? packageManifestPath}:\npackage.json name "${manifest.name}" must use a leaf package name that matches kody.id "${manifest.kody.id}".`,
		)
	}

	return manifest
}

export function normalizePackageWorkspacePath(path: string) {
	return path.trim().replace(/^\.?\//, '')
}

function normalizePackageExportKey(exportName: string) {
	const trimmed = exportName.trim()
	if (!trimmed) {
		throw new Error('Package export name must not be empty.')
	}
	if (trimmed === '.' || trimmed === './') {
		return '.'
	}
	return trimmed.startsWith('./') ? trimmed : `./${trimmed}`
}

function readTargetPath(
	target: PackageExportTarget,
	purpose: 'runtime' | 'types',
): string | null {
	if (typeof target === 'string') {
		return purpose === 'runtime' ? target : null
	}
	if (purpose === 'types') {
		return target.types ?? null
	}
	return target.import ?? target.default ?? null
}

export function resolvePackageExportPath(input: {
	manifest: AuthoredPackageJson
	exportName: string
	purpose?: 'runtime' | 'types'
}) {
	const purpose = input.purpose ?? 'runtime'
	const normalizedExportKey = normalizePackageExportKey(input.exportName)
	const target = input.manifest.exports[normalizedExportKey]
	if (!target) {
		throw new Error(
			`Package "${input.manifest.kody.id}" does not define export "${normalizedExportKey}".`,
		)
	}
	const resolved = readTargetPath(target, purpose)
	if (!resolved) {
		throw new Error(
			`Package "${input.manifest.kody.id}" export "${normalizedExportKey}" does not define a ${purpose} target.`,
		)
	}
	return normalizePackageWorkspacePath(resolved)
}

export function getPackageAppEntryPath(manifest: AuthoredPackageJson) {
	const appEntry = manifest.kody.app?.entry?.trim()
	if (!appEntry) return null
	return normalizePackageWorkspacePath(appEntry)
}

export function getPackageTags(manifest: AuthoredPackageJson) {
	return [...(manifest.kody.tags ?? [])]
}

export type PackageSearchProjection = {
	name: string
	kodyId: string
	description: string
	tags: Array<string>
	searchText: string | null
	hasApp: boolean
	appEntry: string | null
	exports: Array<string>
	jobs: Array<{
		name: string
		entry: string
		schedule: string
		enabled: boolean
	}>
}

export function buildPackageSearchProjection(
	manifest: AuthoredPackageJson,
): PackageSearchProjection {
	const appEntry = getPackageAppEntryPath(manifest)
	return {
		name: manifest.name,
		kodyId: manifest.kody.id,
		description: manifest.kody.description,
		tags: getPackageTags(manifest),
		searchText: manifest.kody.searchText?.trim() || null,
		hasApp: appEntry !== null,
		appEntry,
		exports: Object.keys(manifest.exports).sort(),
		jobs: Object.entries(manifest.kody.jobs ?? {})
			.map(([name, job]) => ({
				name,
				entry: normalizePackageWorkspacePath(job.entry),
				schedule:
					job.schedule.type === 'cron'
						? `cron:${job.schedule.expression}`
						: job.schedule.type === 'interval'
							? `interval:${job.schedule.every}`
							: `once:${job.schedule.runAt}`,
				enabled: job.enabled ?? true,
			}))
			.sort((left, right) => left.name.localeCompare(right.name)),
	}
}

export function buildPackageSearchDocument(projection: PackageSearchProjection) {
	const jobLines = projection.jobs.map((job) =>
		[job.name, job.entry, job.schedule, job.enabled ? 'enabled' : 'disabled']
			.filter((value) => value.length > 0)
			.join(' '),
	)
	return [
		`package ${projection.kodyId}`,
		projection.name,
		projection.description,
		projection.tags.join(' '),
		projection.searchText ?? '',
		projection.exports.join('\n'),
		jobLines.join('\n'),
		projection.appEntry
			? `app ${projection.appEntry}`
			: projection.hasApp
				? 'app'
				: '',
	]
		.filter((value) => value.trim().length > 0)
		.join('\n')
}
