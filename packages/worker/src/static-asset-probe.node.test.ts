import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { expect, test } from 'vitest'
import { routePattern } from '#universal/route-pattern.ts'
import { routes } from '#universal/routes.ts'
import { requestSkipsAssetProbe } from './static-asset-probe.ts'

const publicDirectory = join(import.meta.dirname, '../public')

function listPublicFiles(directory: string): Array<string> {
	const files: Array<string> = []
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name)
		if (entry.isDirectory()) {
			files.push(...listPublicFiles(path))
			continue
		}
		files.push(path)
	}
	return files
}

test('route-owned prefixes skip the ASSETS probe', () => {
	const pathnames = [
		'/account',
		'/account/billing',
		'/@acme',
		'/@acme/-/jobs',
		'/@acme/-/packages',
		'/mcp',
		'/api/me',
		'/oauth/authorize',
		'/oauth/callback',
		'/connectors/legacy',
		'/login',
		'/docs/llms.txt',
	]
	expect(
		pathnames.filter((pathname) => !requestSkipsAssetProbe(pathname)),
	).toEqual([])
})

test('public files and client bundles still probe ASSETS', () => {
	const publicPaths = listPublicFiles(publicDirectory).map(
		(filePath) =>
			`/${relative(publicDirectory, filePath).split(sep).join('/')}`,
	)
	expect(publicPaths.length).toBeGreaterThan(10)
	const probedPaths = [
		...publicPaths,
		'/',
		'/styles.css',
		'/client-entry.js',
		'/assets/index-abc123.js',
		'/favicon.ico',
		'/og/kody-logo.png',
		'/fonts/bricolage-grotesque-latin.woff2',
		'/images/kody-mark.png',
	]
	expect(
		probedPaths.filter((pathname) => requestSkipsAssetProbe(pathname)),
	).toEqual([])
})

test('literal route roots skip the probe unless they are public asset directories', () => {
	const publicDirectories = new Set(
		readdirSync(publicDirectory, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name),
	)
	const mismatches: Array<string> = []
	for (const route of Object.values(routes)) {
		const pattern = routePattern(route)
		const body = pattern.startsWith('/') ? pattern.slice(1) : pattern
		if (body.startsWith('@') || body.startsWith(':') || body.length === 0) {
			continue
		}
		const segment = body.split('/')[0] ?? ''
		if (segment.length === 0 || /[:*(]/.test(segment)) continue
		const sample = `/${segment}/asset-probe`
		const skips = requestSkipsAssetProbe(sample)
		const shouldSkip = !publicDirectories.has(segment)
		if (skips !== shouldSkip) mismatches.push(pattern)
	}
	expect(mismatches).toEqual([])
	expect(requestSkipsAssetProbe('/@kent/-/activity')).toBe(true)
})
