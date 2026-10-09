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
	installPath: string
	lockedVersion: string
	installedVersion: string | null
}

export function isWorkspaceLockfilePath(packagePath: string) {
	return packagePath === '' || !packagePath.split('/').includes('node_modules')
}

export function workspaceLockfilePaths(lock: PackageLock) {
	return Object.keys(lock.packages ?? {}).filter(isWorkspaceLockfilePath)
}

export function resolveLockfileInstallPath(
	packages: Record<string, LockPackage>,
	workspacePath: string,
	name: string,
) {
	const segments = workspacePath === '' ? [] : workspacePath.split('/')
	for (let depth = segments.length; depth >= 0; depth--) {
		const prefix = depth === 0 ? '' : segments.slice(0, depth).join('/')
		const installPath = prefix
			? `${prefix}/node_modules/${name}`
			: `node_modules/${name}`
		if (packages[installPath]?.version) return installPath
	}
	return null
}

export function findInstalledLockfileMismatches(input: {
	lock: PackageLock
	readInstalledVersion: (installPath: string) => string | null
}): Array<InstalledLockfileMismatch> {
	const packages = input.lock.packages ?? {}
	const mismatches: Array<InstalledLockfileMismatch> = []
	const checkedInstallPaths = new Set<string>()
	for (const workspacePath of workspaceLockfilePaths(input.lock)) {
		const meta = packages[workspacePath] ?? {}
		for (const name of [
			...Object.keys(meta.dependencies ?? {}),
			...Object.keys(meta.devDependencies ?? {}),
		]) {
			const installPath = resolveLockfileInstallPath(
				packages,
				workspacePath,
				name,
			)
			if (!installPath || checkedInstallPaths.has(installPath)) continue
			checkedInstallPaths.add(installPath)
			const lockedVersion = packages[installPath]?.version
			if (!lockedVersion) continue
			const installedVersion = input.readInstalledVersion(installPath)
			if (installedVersion === lockedVersion) continue
			mismatches.push({
				name,
				installPath,
				lockedVersion,
				installedVersion,
			})
		}
	}
	return mismatches.toSorted((left, right) =>
		left.installPath.localeCompare(right.installPath),
	)
}

function formatInstalledLockfileError(
	mismatches: ReadonlyArray<InstalledLockfileMismatch>,
) {
	const details = mismatches
		.map((mismatch) => {
			const installed = mismatch.installedVersion ?? 'missing'
			return `${mismatch.name}@${mismatch.lockedVersion} at ${mismatch.installPath} (installed ${installed})`
		})
		.join(', ')
	return `Installed dependencies do not match package-lock.json: ${details}. Run \`npm ci\`.`
}

export function inspectInstalledLockfile(input: {
	lock: PackageLock
	readInstalledVersion: (installPath: string) => string | null
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
		installPath: string,
	) => Promise<string | null> = readInstalledPackageVersion,
) {
	const lock = JSON.parse(
		await readFile(packageLockPath, 'utf8'),
	) as PackageLock
	const packages = lock.packages ?? {}
	const versions = new Map<string, string | null>()
	for (const workspacePath of workspaceLockfilePaths(lock)) {
		const meta = packages[workspacePath] ?? {}
		for (const name of [
			...Object.keys(meta.dependencies ?? {}),
			...Object.keys(meta.devDependencies ?? {}),
		]) {
			const installPath = resolveLockfileInstallPath(
				packages,
				workspacePath,
				name,
			)
			if (!installPath || versions.has(installPath)) continue
			versions.set(installPath, await readInstalledVersion(installPath))
		}
	}
	return inspectInstalledLockfile({
		lock,
		readInstalledVersion: (installPath) => versions.get(installPath) ?? null,
	})
}

async function readInstalledPackageVersion(installPath: string) {
	try {
		const raw = await readFile(path.join(installPath, 'package.json'), 'utf8')
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
