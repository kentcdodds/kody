import { sourceDefinesPythonMain } from './language.ts'

/**
 * In-memory experimental Python package.
 *
 * A saved TypeScript package is a repo, an esbuild graph, a search hit, and
 * an entitlement. This sketch is the slice we can measure without that
 * machinery: a name plus a handful of Python export modules, each with
 * `main(params)`. Publish here means "the caller sent the manifest".
 */
export const pythonPackageMaxExports = 8

export const pythonPackageMaxSourceChars = 64_000

const pythonPackageNamePattern = /^[a-z][a-z0-9-]{0,63}$/

const pythonPackageExportNamePattern = /^[a-z][a-z0-9_]{0,63}$/

export type PythonPackageManifest = {
	name: string
	language: 'python'
	exports: Record<string, string>
}

export function readPythonPackageExport(
	manifest: PythonPackageManifest,
	exportName: string,
): string {
	assertPythonPackageManifest(manifest)
	if (!pythonPackageExportNamePattern.test(exportName)) {
		throw new Error(
			'Python package export names are lowercase identifiers (letters, digits, underscores) up to 64 characters.',
		)
	}
	const source = manifest.exports[exportName]
	if (typeof source !== 'string' || !source.trim()) {
		throw new Error(
			`Python package ${manifest.name} has no export ${exportName}.`,
		)
	}
	if (!sourceDefinesPythonMain(source)) {
		throw new Error(
			`Python package export ${exportName} defines async def main(params) or def main(params).`,
		)
	}
	return source
}

export function assertPythonPackageManifest(manifest: PythonPackageManifest) {
	if (!pythonPackageNamePattern.test(manifest.name)) {
		throw new Error(
			'Python package names are lowercase kebab-case, starting with a letter, up to 64 characters.',
		)
	}
	if (manifest.language !== 'python') {
		throw new Error('Experimental package manifests set language to python.')
	}
	const names = Object.keys(manifest.exports)
	if (names.length === 0) {
		throw new Error('Python package manifests include at least one export.')
	}
	if (names.length > pythonPackageMaxExports) {
		throw new Error(
			`Python package manifests include at most ${pythonPackageMaxExports} exports.`,
		)
	}
	for (const name of names) {
		if (!pythonPackageExportNamePattern.test(name)) {
			throw new Error(
				'Python package export names are lowercase identifiers (letters, digits, underscores) up to 64 characters.',
			)
		}
		const source = manifest.exports[name]
		if (typeof source !== 'string' || !source.trim()) {
			throw new Error(`Python package export ${name} is a module string.`)
		}
		if (source.length > pythonPackageMaxSourceChars) {
			throw new Error(
				`Python package export ${name} is at most ${pythonPackageMaxSourceChars} characters.`,
			)
		}
	}
}
