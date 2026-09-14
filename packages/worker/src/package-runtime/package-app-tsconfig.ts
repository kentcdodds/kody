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
		const parsed: unknown = parseTsconfigJsonc(raw)
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

/**
 * TypeScript `tsconfig.json` is JSONC: comments and trailing commas are
 * legal. `JSON.parse` would throw, and this helper would then ignore
 * `jsx` / `jsxImportSource`.
 */
function parseTsconfigJsonc(raw: string): unknown {
	const withoutBom = raw.replace(/^\uFEFF/, '')
	return JSON.parse(stripTrailingCommas(stripJsoncComments(withoutBom)))
}

function stripJsoncComments(source: string) {
	let output = ''
	let inLineComment = false
	let inBlockComment = false
	let inString = false
	let stringQuote = ''
	let isEscaped = false

	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? ''
		const next = source[index + 1] ?? ''

		if (inLineComment) {
			if (char === '\n') {
				inLineComment = false
				output += char
			}
			continue
		}

		if (inBlockComment) {
			if (char === '*' && next === '/') {
				inBlockComment = false
				index += 1
			}
			continue
		}

		if (inString) {
			output += char
			if (isEscaped) {
				isEscaped = false
				continue
			}
			if (char === '\\') {
				isEscaped = true
				continue
			}
			if (char === stringQuote) {
				inString = false
				stringQuote = ''
			}
			continue
		}

		if (char === '"' || char === "'") {
			inString = true
			stringQuote = char
			output += char
			continue
		}

		if (char === '/' && next === '/') {
			inLineComment = true
			index += 1
			continue
		}

		if (char === '/' && next === '*') {
			inBlockComment = true
			index += 1
			continue
		}

		output += char
	}

	return output
}

function stripTrailingCommas(source: string) {
	let output = ''
	let inString = false
	let stringQuote = ''
	let isEscaped = false

	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? ''

		if (inString) {
			output += char
			if (isEscaped) {
				isEscaped = false
				continue
			}
			if (char === '\\') {
				isEscaped = true
				continue
			}
			if (char === stringQuote) {
				inString = false
				stringQuote = ''
			}
			continue
		}

		if (char === '"' || char === "'") {
			inString = true
			stringQuote = char
			output += char
			continue
		}

		if (char === ',') {
			let lookahead = index + 1
			while (lookahead < source.length) {
				const next = source[lookahead] ?? ''
				if (next === ' ' || next === '\t' || next === '\n' || next === '\r') {
					lookahead += 1
					continue
				}
				break
			}
			const nextNonWhitespace = source[lookahead] ?? ''
			if (nextNonWhitespace === '}' || nextNonWhitespace === ']') {
				continue
			}
		}

		output += char
	}

	return output
}
