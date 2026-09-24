/**
 * Teach an unpatched `@kentcdodds/x` snapshot to page recent search.
 *
 * `search-recent` returns `meta.next_token` but the published function never
 * sends it on `GET /2/tweets/search/recent`. Agents then drop to `./request`.
 * The same snapshot is often already stored as a published importable
 * artifact, so callers that can bundle from source skip that artifact and run
 * the patched files. A snapshot that already forwards `next_token` is left
 * alone and keeps its artifact.
 */

const recentSearchPath = '/tweets/search/recent'
const nextTokenLine = 'next_token: params.nextToken || params.next_token,'

function isInstalledDependencyPath(path: string) {
	const normalized = path.replace(/^\.?\//, '')
	return (
		normalized === 'node_modules' ||
		normalized.startsWith('node_modules/') ||
		normalized.includes('/node_modules/')
	)
}

function patchSearchRecentQuery(source: string) {
	const fn = source.match(/export async function searchRecent\b/)
	if (!fn || fn.index == null) return source
	const regionStart = fn.index
	const pathAt = source.indexOf(recentSearchPath, regionStart)
	if (pathAt < 0) return source
	const region = source.slice(regionStart, pathAt)
	if (region.includes('next_token')) return source
	const line = region.match(
		/^([ \t]*)max_results:\s*params\.maxResults\s*\|\|\s*params\.max_results\s*\|\|\s*10,[ \t]*$/m,
	)
	if (!line || line.index == null) return source
	const indent = line[1] ?? '\t\t'
	const insertAt = regionStart + line.index + line[0].length
	return (
		source.slice(0, insertAt) +
		`\n${indent}${nextTokenLine}` +
		source.slice(insertAt)
	)
}

function patchSearchRecentParams(source: string) {
	const start = source.indexOf('export type XSearchRecentParams')
	if (start < 0) return source
	const endRel = source.slice(start).indexOf('\n}')
	if (endRel < 0) return source
	const block = source.slice(start, start + endRel)
	if (block.includes('next_token') || block.includes('nextToken')) return source
	const line = block.match(/^([ \t]*)max_results\?:\s*number[ \t]*$/m)
	if (!line || line.index == null) return source
	const indent = line[1] ?? '\t'
	const insertAt = start + line.index + line[0].length
	return (
		source.slice(0, insertAt) +
		`\n${indent}nextToken?: string\n${indent}next_token?: string` +
		source.slice(insertAt)
	)
}

function patchSearchRecentDocs(source: string) {
	if (source.includes('next_token') || source.includes('nextToken')) {
		return source
	}
	const summary =
		'Search recent public X posts with app-only bearer auth by default.'
	if (!source.includes(summary)) return source
	return source.replace(
		summary,
		`${summary}\n * Pass \`next_token\` or \`nextToken\` from the previous \`meta.next_token\` to read the next page.`,
	)
}

export function applyXSearchRecentPaginationPatch(
	files: Record<string, string>,
) {
	let queryChanged = false
	const withQuery: Record<string, string> = { ...files }
	for (const [path, source] of Object.entries(files)) {
		if (isInstalledDependencyPath(path)) continue
		const patched = patchSearchRecentQuery(source)
		if (patched === source) continue
		withQuery[path] = patched
		queryChanged = true
	}
	if (!queryChanged) return { files, changed: false }
	const patchedFiles: Record<string, string> = { ...withQuery }
	for (const [path, source] of Object.entries(withQuery)) {
		if (isInstalledDependencyPath(path)) continue
		const patched = patchSearchRecentDocs(patchSearchRecentParams(source))
		if (patched !== source) patchedFiles[path] = patched
	}
	return { files: patchedFiles, changed: true }
}
