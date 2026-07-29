import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

/**
 * Generates `packages/worker/public/client-manifest.json` from the esbuild
 * metafile written by `build:client:web`. SSR reads the manifest to emit
 * `<link rel="modulepreload">` tags for the hashed chunks the entry (and the
 * current route's lazy area) will import, so code splitting does not add a
 * request waterfall before hydration.
 */

export const defaultMetafilePath = path.join('.tmp', 'client-meta.json')
export const defaultManifestPath = path.join(
	'packages',
	'worker',
	'public',
	'client-manifest.json',
)

type MetafileImport = { path: string; kind: string }
type MetafileOutput = { imports?: Array<MetafileImport> }
export type ClientMetafile = { outputs: Record<string, MetafileOutput> }

export type ClientPreloadManifest = {
	/** Static import closure of the entry (hrefs, entry itself excluded). */
	entry: Array<string>
	/**
	 * Lazy area chunk name (e.g. `account-area`) → that area's chunk href plus
	 * its static import closure, minus anything already in `entry`.
	 */
	areas: Record<string, Array<string>>
}

// Keep in sync with the area names registered in
// packages/worker/client/lazy-route.tsx (`clientRouteAreaNameForPath`);
// enforced by packages/worker/client/lazy-route.node.test.ts.
export const lazyAreaNames = [
	'account-area',
	'admin-area',
	'blog-area',
	'community-area',
	'onboarding-area',
]

function staticImportClosure(
	metafile: ClientMetafile,
	startOutputPath: string,
): Array<string> {
	const visited = new Set<string>()
	const queue = [startOutputPath]
	while (queue.length > 0) {
		const current = queue.shift()
		if (current === undefined) break
		for (const imported of metafile.outputs[current]?.imports ?? []) {
			if (imported.kind !== 'import-statement') continue
			if (visited.has(imported.path)) continue
			visited.add(imported.path)
			queue.push(imported.path)
		}
	}
	return [...visited]
}

function toPublicHref(outputPath: string, publicDirPrefix: string) {
	const normalized = outputPath.split(path.sep).join('/')
	const index = normalized.indexOf(publicDirPrefix)
	if (index === -1) return null
	return normalized.slice(index + publicDirPrefix.length)
}

export function buildClientPreloadManifest(
	metafile: ClientMetafile,
	publicDirPrefix = 'packages/worker/public',
): ClientPreloadManifest {
	const outputPaths = Object.keys(metafile.outputs)
	const entryOutput = outputPaths.find((outputPath) =>
		outputPath.endsWith('/client-entry.js'),
	)
	if (!entryOutput) {
		throw new Error('client-entry.js not found in esbuild metafile outputs')
	}

	const toHref = (outputPath: string) => {
		const href = toPublicHref(outputPath, publicDirPrefix)
		if (!href) {
			throw new Error(
				`Output ${outputPath} is outside the public dir ${publicDirPrefix}`,
			)
		}
		return href
	}

	const entryClosure = staticImportClosure(metafile, entryOutput)
	const entryHrefs = entryClosure.map(toHref)
	const entrySet = new Set(entryClosure)

	const areas: Record<string, Array<string>> = {}
	for (const areaName of lazyAreaNames) {
		const areaOutput = outputPaths.find((outputPath) => {
			const base = path.posix.basename(outputPath.split(path.sep).join('/'))
			return base.startsWith(`${areaName}-`) && base.endsWith('.js')
		})
		if (!areaOutput) {
			// A missing area chunk means the barrel got renamed or eagerly
			// bundled — fail loudly instead of silently dropping hints.
			throw new Error(
				`Lazy area chunk for "${areaName}" not found in esbuild metafile outputs`,
			)
		}
		const areaHrefs = [
			areaOutput,
			...staticImportClosure(metafile, areaOutput).filter(
				(outputPath) => !entrySet.has(outputPath),
			),
		].map(toHref)
		areas[areaName] = areaHrefs
	}

	return { entry: entryHrefs, areas }
}

async function main() {
	const metafile = JSON.parse(
		await readFile(defaultMetafilePath, 'utf8'),
	) as ClientMetafile
	const manifest = buildClientPreloadManifest(metafile)
	await mkdir(path.dirname(defaultManifestPath), { recursive: true })
	await writeFile(
		defaultManifestPath,
		`${JSON.stringify(manifest, null, '\t')}\n`,
	)
	console.log(
		`client-manifest: ${manifest.entry.length} entry chunk(s), ${Object.keys(manifest.areas).length} lazy area(s)`,
	)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
