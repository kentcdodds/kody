import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

const defaultPackageLockPath = 'package-lock.json'

type LockPackage = {
	version?: string
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
}

type PackageLock = {
	packages?: Record<string, LockPackage>
}

export type InstalledLockfileMismatch = {
	name: string
	lockedVersion: string
	installedVersion: string | null
}

export function directLockfileDependencyNames(lock: PackageLock) {
	const names = new Set<string>()
	for (const [packagePath, meta] of Object.entries(lock.packages ?? {})) {
		if (packagePath !== '' && packagePath.includes('node_modules')) continue
		for (const name of [
			...Object.keys(meta.dependencies ?? {}),
			...Object.keys(meta.devDependencies ?? {}),
		]) {
			names.add(name)
		}
	}
	return names
}

export function findInstalledLockfileMismatches(input: {
	lock: PackageLock
	readInstalledVersion: (name: string) => string | null
}): Array<InstalledLockfileMismatch> {
	const packages = input.lock.packages ?? {}
	const mismatches: Array<InstalledLockfileMismatch> = []
	for (const name of directLockfileDependencyNames(input.lock)) {
		const lockedVersion = packages[`node_modules/${name}`]?.version
		if (!lockedVersion) continue
		const installedVersion = input.readInstalledVersion(name)
		if (installedVersion === lockedVersion) continue
		mismatches.push({ name, lockedVersion, installedVersion })
	}
	return mismatches.toSorted((left, right) =>
		left.name.localeCompare(right.name),
	)
}

export function formatInstalledLockfileError(
	mismatches: ReadonlyArray<InstalledLockfileMismatch>,
) {
	const details = mismatches
		.map((mismatch) => {
			const installed = mismatch.installedVersion ?? 'missing'
			return `${mismatch.name}@${mismatch.lockedVersion} (installed ${installed})`
		})
		.join(', ')
	return `Installed dependencies do not match package-lock.json: ${details}. Run \`npm ci\`.`
}

export function inspectInstalledLockfile(input: {
	lock: PackageLock
	readInstalledVersion: (name: string) => string | null
}) {
	const mismatches = findInstalledLockfileMismatches(input)
	if (mismatches.length === 0) {
		return {
			ok: true,
			detail: 'installed dependencies match package-lock.json',
		}
	}
	return { ok: false, detail: formatInstalledLockfileError(mismatches) }
}

export async function checkInstalledLockfile(
	packageLockPath = defaultPackageLockPath,
	readInstalledVersion: (
		name: string,
	) => Promise<string | null> = readInstalledPackageVersion,
) {
	const lock = JSON.parse(
		await readFile(packageLockPath, 'utf8'),
	) as PackageLock
	const versions = new Map<string, string | null>()
	for (const name of directLockfileDependencyNames(lock)) {
		versions.set(name, await readInstalledVersion(name))
	}
	return inspectInstalledLockfile({
		lock,
		readInstalledVersion: (name) => versions.get(name) ?? null,
	})
}

async function readInstalledPackageVersion(name: string) {
	try {
		const raw = await readFile(
			path.join('node_modules', ...name.split('/'), 'package.json'),
			'utf8',
		)
		const pkg = JSON.parse(raw) as { version?: string }
		return typeof pkg.version === 'string' ? pkg.version : null
	} catch {
		return null
	}
}

if (isExecutedDirectly(import.meta.url)) {
	const result = await checkInstalledLockfile()
	if (!result.ok) {
		console.error(result.detail)
		process.exitCode = 1
	}
}
