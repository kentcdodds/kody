const packageTsconfigPath = 'tsconfig.json'

type EsbuildJsx = 'automatic' | 'transform' | 'preserve'

function mapTsconfigJsx(jsx: string): EsbuildJsx | undefined {
	switch (jsx) {
		case 'react-jsx':
		case 'react-jsxdev':
			return 'automatic'
		case 'react':
			return 'transform'
		case 'preserve':
			return 'preserve'
		default:
			return undefined
	}
}

export type PackageAppJsxBundleOptions = {
	jsx?: EsbuildJsx
	jsxImportSource?: string
}

/**
 * esbuild JSX options taken from the package's root `tsconfig.json`.
 * The host does not sniff the module graph; a package that wants
 * `remix/ui`, `preact`, or another runtime sets `compilerOptions.jsx`
 * / `jsxImportSource` itself.
 */
export function createPackageAppJsxBundleOptions(
	files: Record<string, string>,
): PackageAppJsxBundleOptions {
	const compilerOptions = readRootTsconfigCompilerOptions(files)
	if (compilerOptions == null) return {}
	const options: PackageAppJsxBundleOptions = {}
	const jsx = compilerOptions.jsx
	if (typeof jsx === 'string') {
		const mapped = mapTsconfigJsx(jsx)
		if (mapped != null) options.jsx = mapped
	}
	const jsxImportSource = compilerOptions.jsxImportSource
	if (typeof jsxImportSource === 'string' && jsxImportSource.length > 0) {
		options.jsxImportSource = jsxImportSource
	}
	return options
}

function readRootTsconfigCompilerOptions(
	files: Record<string, string>,
): Record<string, unknown> | null {
	const raw = files[packageTsconfigPath]
	if (raw == null) return null
	try {
		const parsed: unknown = JSON.parse(raw)
		if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null
		}
		const compilerOptions = (parsed as { compilerOptions?: unknown })
			.compilerOptions
		if (
			compilerOptions == null ||
			typeof compilerOptions !== 'object' ||
			Array.isArray(compilerOptions)
		) {
			return null
		}
		return compilerOptions as Record<string, unknown>
	} catch {
		return null
	}
}
