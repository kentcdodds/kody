import { normalizePackageExportKey } from '#worker/package-registry/manifest.ts'
import { parseKodyPackageSpecifier } from './package-import-resolution.ts'

export const runtimeModulePath = '.__kody_virtual__/runtime.js'
export const packageRuntimeModulePrefix = '.__kody_virtual__/package-runtime'
export const packageManifestPath = 'package.json'
export const wranglerConfigPaths = [
	'wrangler.toml',
	'wrangler.json',
	'wrangler.jsonc',
]
export const rootSourcePrefix = '.__kody_root__'
export const packageSourcePrefix = '.__kody_packages__'
export const packageImportProxyPrefix = '.__kody_virtual__/imports'
export const dynamicPackageImportProxyPrefix =
	'.__kody_virtual__/dynamic-imports'
export const dynamicPackageImportArtifactSegment = '.__kody_current__'
export const dynamicPackageImportSpecifierExportName =
	'__kodyDynamicPackageSpecifier'
export const dynamicPackageImportResolvedMarker = '__kodyDynamicPackageResolved'

export function joinPath(...parts: Array<string>) {
	return parts
		.join('/')
		.replace(/\/+/g, '/')
		.replace(/\/\.\//g, '/')
}

export function dirname(filePath: string) {
	const normalized = filePath.replace(/\/+/g, '/')
	const separator = normalized.lastIndexOf('/')
	return separator === -1 ? '.' : normalized.slice(0, separator) || '.'
}

export function relativePath(fromDir: string, toPath: string) {
	const fromParts = fromDir.split('/').filter(Boolean)
	const toParts = toPath.split('/').filter(Boolean)
	let sharedIndex = 0
	while (
		sharedIndex < fromParts.length &&
		sharedIndex < toParts.length &&
		fromParts[sharedIndex] === toParts[sharedIndex]
	) {
		sharedIndex += 1
	}
	const upward = fromParts.slice(sharedIndex).map(() => '..')
	const downward = toParts.slice(sharedIndex)
	return [...upward, ...downward].join('/')
}

export function createRelativeImportSpecifier(
	fromPath: string,
	targetPath: string,
) {
	const fromDir = dirname(fromPath)
	const relative = relativePath(fromDir, targetPath)
	const normalized =
		relative === '.' || relative.startsWith('./') || relative.startsWith('../')
			? relative
			: `./${relative}`
	return normalized.replaceAll('\\', '/')
}

export function resolveRelativeModulePath(fromPath: string, specifier: string) {
	if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
		return null
	}
	return normalizeWorkspaceModulePath(joinPath(dirname(fromPath), specifier))
}

export function encodePathKey(value: string) {
	return Array.from(new TextEncoder().encode(value), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
}

export function encodePathKeyAsPath(value: string) {
	const encoded = encodePathKey(value)
	const chunks = encoded.match(/.{1,96}/g)
	return chunks?.join('/') ?? encoded
}

export function decodePathKey(value: string) {
	const bytes = value.match(/[0-9a-f]{2}/gi)
	if (!bytes || bytes.join('') !== value) return null
	try {
		return new TextDecoder().decode(
			new Uint8Array(bytes.map((byte) => Number.parseInt(byte, 16))),
		)
	} catch {
		return null
	}
}

export function createPackageProxyPathSegment(specifier: string) {
	const parsed = parseKodyPackageSpecifier(specifier)
	return encodePathKey(
		`${parsed.packageName}#${normalizePackageExportKey(parsed.exportName)}`,
	)
}

export function createPackageSpecifierFromProxyPath(modulePath: string) {
	const normalizedPath = normalizeWorkspaceModulePath(modulePath)
	const prefix = `${dynamicPackageImportProxyPrefix}/`
	const prefixIndex = normalizedPath.indexOf(prefix)
	if (prefixIndex === -1) return null
	const encodedSegment = normalizedPath
		.slice(prefixIndex + prefix.length)
		.split('/')[0]
		?.replace(/\.js$/, '')
	if (!encodedSegment) return null
	const decoded = decodePathKey(encodedSegment)
	const separator = decoded?.indexOf('#') ?? -1
	if (!decoded || separator === -1) return null
	const packageName = decoded.slice(0, separator)
	const exportName = decoded.slice(separator + 1)
	if (!packageName.startsWith('@')) return null
	const exportSuffix =
		exportName && exportName !== '.'
			? `/${exportName.replace(/^\.?\//, '')}`
			: ''
	return `capabilities:${packageName}${exportSuffix}`
}

export function normalizeWorkspaceModulePath(path: string) {
	const parts: Array<string> = []
	for (const segment of path.replace(/\\/g, '/').split('/')) {
		if (!segment || segment === '.') continue
		if (segment === '..') {
			parts.pop()
			continue
		}
		parts.push(segment)
	}
	return parts.join('/')
}

export function resolveWorkspaceSourceFilePath(input: {
	files: Record<string, string>
	path: string
}) {
	const basePath = normalizeWorkspaceModulePath(input.path)
	const candidates = [
		basePath,
		`${basePath}.ts`,
		`${basePath}.tsx`,
		`${basePath}.js`,
		`${basePath}.jsx`,
		`${basePath}.mts`,
		`${basePath}.cts`,
		`${basePath}.mjs`,
		`${basePath}.cjs`,
		joinPath(basePath, 'index.ts'),
		joinPath(basePath, 'index.tsx'),
		joinPath(basePath, 'index.js'),
		joinPath(basePath, 'index.jsx'),
		joinPath(basePath, 'index.mts'),
		joinPath(basePath, 'index.cts'),
		joinPath(basePath, 'index.mjs'),
		joinPath(basePath, 'index.cjs'),
	]
	const substitutionBase = basePath.replace(/\.(?:js|jsx|mjs|cjs)$/, '')
	if (substitutionBase !== basePath) {
		candidates.push(
			`${substitutionBase}.ts`,
			`${substitutionBase}.tsx`,
			`${substitutionBase}.mts`,
			`${substitutionBase}.cts`,
			`${substitutionBase}.mjs`,
			`${substitutionBase}.cjs`,
		)
	}
	return candidates.find((candidate) => input.files[candidate] != null) ?? null
}
