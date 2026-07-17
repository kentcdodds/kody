/**
 * Shared parser + path classifier for docs/contributing/architecture/primitives.yaml.
 *
 * Constrained YAML subset (version/groups/primitives/invariants with scalar fields
 * and string lists). Not a general YAML parser.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

export const defaultMapPath = resolve(
	import.meta.dirname,
	'../../../../docs/contributing/architecture/primitives.yaml',
)

/**
 * @typedef {{
 *   id: string
 *   name: string
 *   group?: string
 *   summary?: string
 *   code: Array<string>
 *   docs: Array<string>
 * }} Primitive
 */

/**
 * @typedef {{
 *   version: number
 *   groups: Array<{ id: string, name: string }>
 *   primitives: Array<Primitive>
 *   invariants: Array<Primitive>
 * }} PrimitivesMap
 */

/**
 * @param {string} text
 * @returns {PrimitivesMap}
 */
export function parsePrimitivesMap(text) {
	const lines = text.split(/\r?\n/)
	/** @type {PrimitivesMap} */
	const map = {
		version: 1,
		groups: [],
		primitives: [],
		invariants: [],
	}

	/** @type {'root' | 'groups' | 'primitives' | 'invariants'} */
	let section = 'root'
	/** @type {Primitive | { id: string, name: string } | null} */
	let current = null
	/** @type {'code' | 'docs' | null} */
	let listField = null

	function finishCurrent() {
		if (!current || !('id' in current)) return
		if (section === 'groups' && 'name' in current) {
			map.groups.push({ id: current.id, name: current.name })
		} else if (section === 'primitives') {
			const primitive = /** @type {Primitive} */ (current)
			primitive.code ??= []
			primitive.docs ??= []
			map.primitives.push(primitive)
		} else if (section === 'invariants') {
			const invariant = /** @type {Primitive} */ (current)
			invariant.code ??= []
			invariant.docs ??= []
			map.invariants.push(invariant)
		}
		current = null
		listField = null
	}

	for (const rawLine of lines) {
		const commentIndex = rawLine.indexOf('#')
		const line =
			commentIndex === -1
				? rawLine
				: // Keep `#` inside quoted scalars; our map never quotes.
					/^\s*#/.test(rawLine)
					? ''
					: rawLine
		if (!line.trim()) continue

		const sectionMatch = line.match(/^(groups|primitives|invariants):\s*$/)
		if (sectionMatch) {
			finishCurrent()
			section = /** @type {'groups' | 'primitives' | 'invariants'} */ (
				sectionMatch[1]
			)
			continue
		}

		const versionMatch = line.match(/^version:\s+(\d+)\s*$/)
		if (versionMatch) {
			map.version = Number(versionMatch[1])
			continue
		}

		const itemMatch = line.match(/^ {2}- id:\s+(.+?)\s*$/)
		if (itemMatch) {
			finishCurrent()
			current = {
				id: unquote(itemMatch[1]),
				name: '',
				code: [],
				docs: [],
			}
			listField = null
			continue
		}

		if (!current) continue

		const listStart = line.match(/^ {4}(code|docs):\s*$/)
		if (listStart) {
			listField = /** @type {'code' | 'docs'} */ (listStart[1])
			continue
		}

		const listItem = line.match(/^ {6}- (.+?)\s*$/)
		if (listItem && listField && 'code' in current) {
			const value = unquote(listItem[1])
			if (listField === 'code') current.code.push(value)
			else current.docs.push(value)
			continue
		}

		const emptySummary = line.match(/^ {4}summary:\s*$/)
		if (emptySummary) {
			listField = null
			current.summary = ''
			continue
		}

		const summaryContinuation = line.match(/^ {6}(.+?)\s*$/)
		if (
			summaryContinuation &&
			listField === null &&
			'code' in current &&
			current.summary === ''
		) {
			current.summary = unquote(summaryContinuation[1])
			continue
		}

		const fieldMatch = line.match(/^ {4}(group|name|summary):\s+(.+?)\s*$/)
		if (fieldMatch) {
			listField = null
			const key = fieldMatch[1]
			const value = unquote(fieldMatch[2])
			if (key === 'group') current.group = value
			else if (key === 'name') current.name = value
			else current.summary = value
			continue
		}
	}

	finishCurrent()
	return map
}

/**
 * @param {string} value
 */
function unquote(value) {
	if (
		(value.startsWith("'") && value.endsWith("'")) ||
		(value.startsWith('"') && value.endsWith('"'))
	) {
		return value.slice(1, -1)
	}
	return value
}

/**
 * @param {string} filePath
 * @param {string} root
 */
export function pathMatchesRoot(filePath, root) {
	const normalizedFile = filePath.replaceAll('\\', '/')
	const isDirRoot = root.endsWith('/')
	const normalizedRoot = root.replaceAll('\\', '/').replace(/\/$/, '')
	if (!normalizedRoot) return false
	if (isDirRoot) {
		return (
			normalizedFile === normalizedRoot ||
			normalizedFile.startsWith(`${normalizedRoot}/`)
		)
	}
	return (
		normalizedFile === normalizedRoot ||
		normalizedFile.startsWith(normalizedRoot)
	)
}

/**
 * Longest-prefix match: each path maps to the primitive(s) whose matching
 * `code` root is longest. Equal-length ties return every tied primitive.
 *
 * @param {Array<string>} paths
 * @param {PrimitivesMap} map
 */
export function classifyPaths(paths, map) {
	/** @type {Map<string, { primitive: Primitive, root: string, files: Array<string> }>} */
	const byId = new Map()
	/** @type {Array<string>} */
	const unmatched = []

	for (const rawPath of paths) {
		const filePath = rawPath.replaceAll('\\', '/').replace(/^\.\//, '')
		if (!filePath || filePath.endsWith('/')) continue

		/** @type {Array<{ primitive: Primitive, root: string }>} */
		const matches = []
		for (const primitive of map.primitives) {
			for (const root of primitive.code) {
				if (pathMatchesRoot(filePath, root)) {
					matches.push({ primitive, root })
				}
			}
		}

		if (matches.length === 0) {
			unmatched.push(filePath)
			continue
		}

		const maxLen = Math.max(...matches.map((match) => match.root.length))
		const winners = matches.filter((match) => match.root.length === maxLen)
		const seen = new Set()
		for (const winner of winners) {
			if (seen.has(winner.primitive.id)) continue
			seen.add(winner.primitive.id)
			const existing = byId.get(winner.primitive.id)
			if (existing) {
				existing.files.push(filePath)
			} else {
				byId.set(winner.primitive.id, {
					primitive: winner.primitive,
					root: winner.root,
					files: [filePath],
				})
			}
		}
	}

	const matched = [...byId.values()].sort((a, b) =>
		a.primitive.id.localeCompare(b.primitive.id),
	)
	return { matched, unmatched }
}

/**
 * @param {string} [mapPath]
 */
export function loadPrimitivesMap(mapPath = defaultMapPath) {
	return parsePrimitivesMap(readFileSync(mapPath, 'utf8'))
}

/**
 * Validate that every `code` and `docs` path resolves on disk.
 * Directory roots may end with `/`. Prefix roots (no trailing `/`) must match
 * at least one existing file or directory under the repo root.
 *
 * @param {PrimitivesMap} map
 * @param {string} [repoRoot]
 */
export function checkPrimitivesMapPaths(
	map,
	repoRoot = resolve(import.meta.dirname, '../../../..'),
) {
	/** @type {Array<{ kind: string, id: string, path: string, reason: string }>} */
	const errors = []

	/**
	 * @param {Primitive} entry
	 * @param {'primitive' | 'invariant'} kind
	 */
	function checkEntry(entry, kind) {
		for (const docPath of entry.docs) {
			const absolute = resolve(repoRoot, docPath)
			if (!existsSync(absolute) || !statSync(absolute).isFile()) {
				errors.push({
					kind,
					id: entry.id,
					path: docPath,
					reason: 'docs path missing or not a file',
				})
			}
		}

		for (const codePath of entry.code) {
			const absolute = resolve(repoRoot, codePath.replace(/\/$/, ''))
			if (existsSync(absolute)) continue

			// Prefix roots (e.g. handlers/community, app/oauth-) must hit something.
			if (!codePath.endsWith('/')) {
				const parent = resolve(
					repoRoot,
					codePath.split('/').slice(0, -1).join('/'),
				)
				const prefix = codePath.split('/').at(-1) ?? ''
				if (existsSync(parent) && statSync(parent).isDirectory()) {
					const hit = readdirSafe(parent).some((name) =>
						name.startsWith(prefix),
					)
					if (hit) continue
				}
			}

			errors.push({
				kind,
				id: entry.id,
				path: codePath,
				reason: 'code root missing on disk',
			})
		}
	}

	for (const primitive of map.primitives) checkEntry(primitive, 'primitive')
	for (const invariant of map.invariants) checkEntry(invariant, 'invariant')
	return errors
}

/**
 * @param {string} dir
 */
function readdirSafe(dir) {
	try {
		return readdirSync(dir)
	} catch {
		return []
	}
}
