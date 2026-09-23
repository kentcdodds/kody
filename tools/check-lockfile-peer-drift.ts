import { readFile } from 'node:fs/promises'
import semver from 'semver'
import { isExecutedDirectly } from './node-runtime.ts'

const defaultPackageLockPath = 'package-lock.json'

type PackageLock = {
	packages?: Record<string, LockPackage>
}

type LockPackage = {
	version?: string
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
	peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

type LockfilePeerDrift = {
	name: string
	lockedVersion: string
	directRanges: Array<string>
	peerRange: string
	from: string
}

/**
 * `npm install` rewrites package-lock.json when a hoisted direct dependency
 * sits inside every declared range but outside a peer range those ranges can
 * still reach. Optional peers count: wrangler marks `@cloudflare/workers-types`
 * optional and npm still bumps it. A peer range that does not intersect the
 * declared ranges (vite 8 vs a vite 7 peer) cannot be fixed by moving the
 * direct dependency, so npm leaves the lockfile alone.
 */
export function findLockfilePeerDrift(
	lock: PackageLock,
): Array<LockfilePeerDrift> {
	const packages = lock.packages ?? {}
	const directRangesByName = new Map<string, Set<string>>()
	for (const [packagePath, meta] of Object.entries(packages)) {
		if (packagePath !== '' && packagePath.includes('node_modules')) continue
		for (const [name, range] of Object.entries(declaredRanges(meta))) {
			const ranges = directRangesByName.get(name) ?? new Set<string>()
			ranges.add(range)
			directRangesByName.set(name, ranges)
		}
	}

	const drifts: Array<LockfilePeerDrift> = []
	for (const [name, rangeSet] of directRangesByName) {
		const lockedVersion = packages[`node_modules/${name}`]?.version
		if (!lockedVersion) continue
		const directRanges = [...rangeSet].toSorted()
		for (const [packagePath, meta] of Object.entries(packages)) {
			const peerRange = meta.peerDependencies?.[name]
			if (!peerRange) continue
			if (
				semver.satisfies(lockedVersion, peerRange, {
					includePrerelease: true,
				})
			) {
				continue
			}
			if (!directRangesAllowPeer(directRanges, peerRange)) continue
			drifts.push({
				name,
				lockedVersion,
				directRanges,
				peerRange,
				from: packagePath === '' ? '<root>' : packagePath,
			})
		}
	}

	return drifts.toSorted((left, right) =>
		driftKey(left).localeCompare(driftKey(right)),
	)
}

function formatLockfilePeerDrift(drift: LockfilePeerDrift): string {
	return `${drift.name}@${drift.lockedVersion} is inside ${drift.directRanges.join(', ')} but outside peer ${drift.peerRange} from ${drift.from}. npm install rewrites package-lock.json to satisfy that peer. Run npm install and commit the lockfile.`
}

export async function checkLockfilePeerDrift(
	packageLockPath: string = defaultPackageLockPath,
): Promise<Array<string>> {
	const lock = JSON.parse(
		await readFile(packageLockPath, 'utf8'),
	) as PackageLock
	return findLockfilePeerDrift(lock).map(formatLockfilePeerDrift)
}

function declaredRanges(pkg: LockPackage | undefined): Record<string, string> {
	return {
		...pkg?.dependencies,
		...pkg?.devDependencies,
		...pkg?.optionalDependencies,
	}
}

function directRangesAllowPeer(
	directRanges: Array<string>,
	peerRange: string,
): boolean {
	return directRanges.every((range) => {
		try {
			return semver.intersects(range, peerRange, { includePrerelease: true })
		} catch {
			return false
		}
	})
}

function driftKey(drift: LockfilePeerDrift): string {
	return `${drift.name}\0${drift.from}\0${drift.peerRange}`
}

if (isExecutedDirectly(import.meta.url)) {
	const errors = await checkLockfilePeerDrift()
	if (errors.length > 0) {
		for (const error of errors) {
			console.error(error)
		}
		process.exitCode = 1
	}
}
