import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, test } from 'vitest'
import { parseModuleSource } from '#worker/module-source.ts'
import { getPackageCodemodById } from '../registry.ts'
import {
	prefixPackagesInvokeSpecifiersCodemod,
	prefixPackagesInvokeSpecifiersCodemodId,
} from './0007-prefix-packages-invoke-specifiers.ts'

test('0007 prefixes JS and TS literals while preserving options and export precedence', () => {
	const files = {
		'index.ts': `
const result = await packages.invoke('@owner/pkg/specifier-export', {
  exportName: computedExport,
  params: buildParams(),
  idempotencyKey,
  topic: 'events',
})
await packages?.invoke("@owner/other", options)
await packages.invoke('kody:@owner/already/export', { params: {} })
`,
		'spaced.ts':
			"await packages.invoke('@owner / package / export-name', { exportName: fallback, params: buildParams() })\n",
		'worker.js': 'await packages.invoke(`@owner/template/export`, options)\n',
	}
	const result = prefixPackagesInvokeSpecifiersCodemod.transform(files)

	expect(result).toMatchObject({
		changed: true,
		changedPaths: ['index.ts', 'spaced.ts', 'worker.js'],
		needsManual: [],
	})
	expect(result.files['index.ts']).toContain(
		"packages.invoke('kody:@owner/pkg/specifier-export', {\n  exportName: computedExport,\n  params: buildParams(),",
	)
	expect(result.files['index.ts']).toContain(
		'packages?.invoke("kody:@owner/other", options)',
	)
	expect(result.files['index.ts']).toContain(
		"packages.invoke('kody:@owner/already/export', { params: {} })",
	)
	expect(result.files['worker.js']).toBe(
		'await packages.invoke(`kody:@owner/template/export`, options)\n',
	)
	expect(result.files['spaced.ts']).toBe(
		"await packages.invoke('kody:@owner/package/export-name', { exportName: fallback, params: buildParams() })\n",
	)

	const repeated = prefixPackagesInvokeSpecifiersCodemod.transform(result.files)
	expect(repeated).toEqual({
		files: result.files,
		changed: false,
		changedPaths: [],
		needsManual: [],
	})
})

test('0007 detects and rewrites comment-separated packages.invoke access', () => {
	const files = {
		'before-operator.ts': `
await packages /* block note */ .invoke('@owner/block/export')
await packages // line note
  .invoke('@owner/line/export')
`,
		'before-invoke.ts': `
await packages. /* block note */ invoke('@owner/block/export')
await packages. // line note
  invoke('@owner/line/export')
await packages /* optional note */ ?. /* property note */ invoke('@owner/optional/export')
`,
	}

	expect(prefixPackagesInvokeSpecifiersCodemod.detect(files)).toEqual([
		{
			path: 'before-invoke.ts',
			message:
				'Uses a deprecated prefixless packages.invoke specifier; add the kody: prefix.',
		},
		{
			path: 'before-operator.ts',
			message:
				'Uses a deprecated prefixless packages.invoke specifier; add the kody: prefix.',
		},
	])

	const result = prefixPackagesInvokeSpecifiersCodemod.transform(files)
	expect(result.changedPaths).toEqual([
		'before-invoke.ts',
		'before-operator.ts',
	])
	expect(result.needsManual).toEqual([])
	expect(result.files['before-operator.ts']).toContain(
		"packages /* block note */ .invoke('kody:@owner/block/export')",
	)
	expect(result.files['before-operator.ts']).toContain(
		"packages // line note\n  .invoke('kody:@owner/line/export')",
	)
	expect(result.files['before-invoke.ts']).toContain(
		"packages. /* block note */ invoke('kody:@owner/block/export')",
	)
	expect(result.files['before-invoke.ts']).toContain(
		"packages. // line note\n  invoke('kody:@owner/line/export')",
	)
	expect(result.files['before-invoke.ts']).toContain(
		"packages /* optional note */ ?. /* property note */ invoke('kody:@owner/optional/export')",
	)
})

test('0007 rewrites only proven Kody packages bindings', () => {
	const files = {
		'global.ts': "await packages.invoke('@owner/global/export')\n",
		'kody-import.ts': `
import { packages } from 'kody:runtime'
await packages.invoke('@owner/imported/export')
`,
		'shadowed.ts': `
await packages.invoke('@owner/file-level/export')
function nested(packages) {
  return packages.invoke('@owner/shadowed/export')
}
`,
		'unrelated-import.ts': `
import { packages } from 'other-library'
await packages.invoke('@owner/unrelated/export')
`,
		'local.ts': `
const packages = { invoke: (value) => value }
packages.invoke('@owner/local/export')
`,
		'ambiguous-alias.ts': `
const packages = runtimePackages
packages.invoke('@private-owner/private-package/export')
`,
		'for-of.ts': `
for (const packages of providers) {
  packages.invoke('@owner/for-of/export')
}
`,
		'switch.ts': `
switch (kind) {
  case 'local': {
    const packages = createPackages()
    packages.invoke('@owner/switch/export')
  }
}
`,
		'class-private.ts': `
class Runner {
  #run(packages) {
    return packages.invoke('@owner/private-method/export')
  }
}
`,
		'ts-namespace.ts': `
namespace packages {
  export const value = true
}
packages.invoke('@owner/namespace/export')
`,
	}
	const result = prefixPackagesInvokeSpecifiersCodemod.transform(files)

	expect(result.changedPaths).toEqual(['global.ts', 'kody-import.ts'])
	expect(result.files['global.ts']).toContain(
		"packages.invoke('kody:@owner/global/export')",
	)
	expect(result.files['shadowed.ts']).toContain(
		"packages.invoke('@owner/file-level/export')",
	)
	expect(result.files['shadowed.ts']).toContain(
		"packages.invoke('@owner/shadowed/export')",
	)
	expect(result.files['kody-import.ts']).toContain(
		"packages.invoke('kody:@owner/imported/export')",
	)
	expect(result.files['unrelated-import.ts']).toBe(files['unrelated-import.ts'])
	expect(result.files['local.ts']).toBe(files['local.ts'])
	expect(result.files['ambiguous-alias.ts']).toBe(files['ambiguous-alias.ts'])
	for (const path of [
		'for-of.ts',
		'switch.ts',
		'class-private.ts',
		'ts-namespace.ts',
	]) {
		expect(result.files[path]).toBe(files[path])
	}
	const expectedManualPaths = [
		'ambiguous-alias.ts',
		'class-private.ts',
		'for-of.ts',
		'local.ts',
		'shadowed.ts',
		'switch.ts',
		'ts-namespace.ts',
		'unrelated-import.ts',
	].sort((left, right) => left.localeCompare(right))
	expect(result.needsManual.map((finding) => finding.path)).toEqual(
		expectedManualPaths,
	)
	expect(
		result.needsManual.every(
			(finding) =>
				finding.message ===
				'A packages.invoke call is ambiguous or cannot be safely rewritten; add the kody: prefix manually.',
		),
	).toBe(true)
	expect(
		JSON.stringify(result.needsManual.map((finding) => finding.message)),
	).not.toContain('private-owner')

	const repeated = prefixPackagesInvokeSpecifiersCodemod.transform(result.files)
	expect(repeated.files).toEqual(result.files)
	expect(repeated.changed).toBe(false)
	expect(repeated.needsManual).toEqual(result.needsManual)
})

test('0007 rewrites parseable Markdown and MDX examples', () => {
	const files = {
		'README.md': `
\`\`\`ts
await packages.invoke('@owner/pkg/export', { params: { value: 1 } })
\`\`\`

Inline: \`packages.invoke("@owner/pkg", { exportName: "run" })\`.

\`\`\`text
packages.invoke('@owner/prose/export')
\`\`\`
`,
		'guide.mdx': `
## Example

\`\`\`javascript
await packages?.invoke('@owner/mdx/export', options)
\`\`\`
`,
	}
	const result = prefixPackagesInvokeSpecifiersCodemod.transform(files)

	expect(result.changedPaths).toEqual(['guide.mdx', 'README.md'])
	expect(result.needsManual).toEqual([
		{
			path: 'README.md',
			message:
				'A packages.invoke call is ambiguous or cannot be safely rewritten; add the kody: prefix manually.',
		},
	])
	expect(result.files['README.md']).toContain(
		"packages.invoke('kody:@owner/pkg/export', { params: { value: 1 } })",
	)
	expect(result.files['README.md']).toContain(
		'packages.invoke("kody:@owner/pkg", { exportName: "run" })',
	)
	expect(result.files['README.md']).toContain(
		"```text\npackages.invoke('@owner/prose/export')",
	)
	expect(result.files['guide.mdx']).toContain(
		"packages?.invoke('kody:@owner/mdx/export', options)",
	)
})

test('0007 leaves escaped and multi-backtick Markdown inline forms manual', () => {
	const files = {
		'escaping.md':
			"Escaped delimiters: \\`packages.invoke('@owner/escaped/export')\\`.\n\n" +
			"Multi-backtick span: ``packages.invoke('@owner/multiple/export')``.\n",
	}
	const result = prefixPackagesInvokeSpecifiersCodemod.transform(files)

	expect(result).toEqual({
		files,
		changed: false,
		changedPaths: [],
		needsManual: [
			{
				path: 'escaping.md',
				message:
					'A packages.invoke call is ambiguous or cannot be safely rewritten; add the kody: prefix manually.',
			},
		],
	})
})

test('0007 never rewrites packages.invoke inside Markdown HTML comments', () => {
	const files = {
		'comment.md': `
<!--
\`packages.invoke('@private-owner/private-package/export')\`
-->

\`packages.invoke('@owner/visible/export')\`
`,
	}
	const result = prefixPackagesInvokeSpecifiersCodemod.transform(files)

	expect(result.changedPaths).toEqual(['comment.md'])
	expect(result.files['comment.md']).toContain(
		"packages.invoke('@private-owner/private-package/export')",
	)
	expect(result.files['comment.md']).toContain(
		"packages.invoke('kody:@owner/visible/export')",
	)
	expect(result.needsManual).toEqual([
		{
			path: 'comment.md',
			message:
				'A packages.invoke call is ambiguous or cannot be safely rewritten; add the kody: prefix manually.',
		},
	])
	expect(result.needsManual[0]?.message).not.toContain('private-owner')
})

test('0007 partially rewrites safe calls and emits fixed privacy-safe manual findings', () => {
	const files = {
		'ambiguous.ts': `
await packages.invoke('@private-owner/private-package/export', options)
await packages.invoke(dynamicSpecifier, options)
await packages.invoke(\`@\${owner}/pkg/export\`, options)
`,
		'broken.ts': `await packages.invoke('@owner/package/export'`,
		'object-only.ts':
			"await packages.invoke({ kodyId: 'legacy', exportName: 'run' })\n",
	}
	const result = prefixPackagesInvokeSpecifiersCodemod.transform(files)

	expect(result.changedPaths).toEqual(['ambiguous.ts'])
	expect(result.files['ambiguous.ts']).toContain(
		"packages.invoke('kody:@private-owner/private-package/export', options)",
	)
	expect(result.files['object-only.ts']).toBe(files['object-only.ts'])
	expect(result.needsManual).toEqual([
		{
			path: 'broken.ts',
			message:
				'File references packages.invoke but could not be parsed; add kody: prefixes manually.',
		},
	])
	expect(JSON.stringify(result.needsManual)).not.toContain('private-owner')
	expect(JSON.stringify(result.needsManual)).not.toContain('private-package')
})

test('0007 detect orders rewritable and manual findings and omits prefixed calls', () => {
	const findings = prefixPackagesInvokeSpecifiersCodemod.detect({
		'a-rewrite.ts':
			"packages.invoke('@private-owner/private-package/export')\n",
		'b-manual.ts': 'packages.invoke(privateSpecifier)\n',
		'c-prefixed.ts':
			"packages.invoke('kody:@private-owner/private-package/export')\n",
		'd-parse.ts': "packages.invoke('@private-owner/private-package/export'\n",
		'e-unrelated-parse.ts': 'const packages = (\nconst invoke = true\n',
	})

	expect(findings).toEqual([
		{
			path: 'a-rewrite.ts',
			message:
				'Uses a deprecated prefixless packages.invoke specifier; add the kody: prefix.',
		},
		{
			path: 'b-manual.ts',
			message:
				'Uses a deprecated prefixless packages.invoke specifier; add the kody: prefix.',
		},
		{
			path: 'd-parse.ts',
			message:
				'File references packages.invoke but could not be parsed; add kody: prefixes manually.',
		},
	])
	expect(findings.map((finding) => finding.path)).not.toContain('c-prefixed.ts')
	expect(findings.map((finding) => finding.path)).not.toContain(
		'e-unrelated-parse.ts',
	)
	expect(JSON.stringify(findings)).not.toContain('private-owner')
	expect(JSON.stringify(findings)).not.toContain('private-package')
})

test('0007 evaluates dynamic JS specifiers once and preserves runtime rejection inputs', () => {
	const source = `
let producerCalls = 0
function produce(value) {
  producerCalls += 1
  return value
}
packages.invoke(produce('  @owner/pkg/export  '))
packages.invoke(produce('kody:@owner/already'))
try { packages.invoke(produce('not-a-specifier')) } catch {}
try { packages.invoke(produce(42)) } catch {}
globalThis.codemodResult = { producerCalls }
`
	const transformed =
		prefixPackagesInvokeSpecifiersCodemod.transform({
			'index.js': source,
		}).files['index.js'] ?? ''
	const context: {
		codemodResult?: { producerCalls: number }
		packages: {
			invoke(value: unknown): unknown
		}
	} = {
		packages: {
			invoke(value) {
				if (value === 'not-a-specifier' || typeof value !== 'string') {
					throw new Error('rejected')
				}
				return value
			},
		},
	}

	expect(transformed).toContain('kody-codemod-0007')
	expect(transformed).not.toContain(': unknown')
	expect(transformed).not.toContain(' as `kody:')
	const observed: Array<unknown> = []
	context.packages.invoke = (value) => {
		observed.push(value)
		if (value === 'not-a-specifier' || typeof value !== 'string') {
			throw new Error('rejected')
		}
		return value
	}
	runInNewContext(transformed, context)
	expect(context.codemodResult?.producerCalls).toBe(4)
	expect(observed).toEqual([
		'kody:@owner/pkg/export',
		'kody:@owner/already',
		'not-a-specifier',
		42,
	])
})

test('0007 preserves sequence-expression semantics and evaluates it once', () => {
	const source = `
let initCalls = 0
function init() {
  initCalls += 1
}
const spec = '@owner/pkg/run'
const result = packages.invoke((init(), spec))
globalThis.codemodResult = { initCalls, result }
`
	const result = prefixPackagesInvokeSpecifiersCodemod.transform({
		'sequence.js': source,
	})
	const transformed = result.files['sequence.js'] ?? ''
	const observed: Array<unknown> = []
	const context: {
		codemodResult?: { initCalls: number; result: unknown }
		packages: { invoke(value: unknown): unknown }
	} = {
		packages: {
			invoke(value) {
				observed.push(value)
				return value
			},
		},
	}

	expect(transformed).toContain('})((init(), spec)))')
	runInNewContext(transformed, context)
	expect(context.codemodResult).toEqual({
		initCalls: 1,
		result: 'kody:@owner/pkg/run',
	})
	expect(observed).toEqual(['kody:@owner/pkg/run'])
	expect(prefixPackagesInvokeSpecifiersCodemod.transform(result.files)).toEqual(
		{
			files: result.files,
			changed: false,
			changedPaths: [],
			needsManual: [],
		},
	)
})

test('0007 normalizes every parseable dynamic expression and preserves the rest of each call', () => {
	const source = `
const __kodyCodemod0007Value = outerValue
const __kodyCodemod0007Trimmed = outerTrimmed
await packages.invoke(result.exports[0].import_specifier, {
  exportName: chooseExport(primary, fallback),
  params: buildParams({ complete: true }),
  idempotencyKey: event.id,
  topic: \`events:\${kind}\`,
})
await packages.invoke(condition ? left : right, options)
await packages.invoke(getSpecifier(input), buildOptions())
await packages.invoke(\`@\${owner}/\${packageName}/run\`, options)
await packages?.invoke(__kodyCodemod0007Value, options)
`
	const result = prefixPackagesInvokeSpecifiersCodemod.transform({
		'index.ts': source,
	})
	const transformed = result.files['index.ts'] ?? ''

	expect(result.needsManual).toEqual([])
	expect(transformed.match(/kody-codemod-0007/g)).toHaveLength(5)
	expect(transformed).toContain(
		'})((result.exports[0].import_specifier)), {\n  exportName: chooseExport(primary, fallback),\n  params: buildParams({ complete: true }),\n  idempotencyKey: event.id,\n  topic: `events:${kind}`,\n})',
	)
	expect(transformed).toContain('})((condition ? left : right)), options)')
	expect(transformed).toContain('})((getSpecifier(input))), buildOptions())')
	expect(transformed).toContain(
		'})((`@${owner}/${packageName}/run`)), options)',
	)
	expect(transformed).toContain(
		'packages?.invoke(((__kodyCodemod0007Value: unknown)',
	)
	expect(transformed).toContain('})((__kodyCodemod0007Value)), options)')
})

test('0007 recognizes only the exact generated wrapper shape', () => {
	const files = {
		'marker-literal.ts':
			"packages.invoke('@owner/kody-codemod-0007/run', options)\n",
		'marker-dynamic.js':
			"packages.invoke(getSpecifier('kody-codemod-0007'), options)\n",
	}
	const result = prefixPackagesInvokeSpecifiersCodemod.transform(files)

	expect(result.files['marker-literal.ts']).toBe(
		"packages.invoke('kody:@owner/kody-codemod-0007/run', options)\n",
	)
	expect(result.files['marker-dynamic.js']).toContain(
		'kody-codemod-0007 */ const',
	)
	expect(result.files['marker-dynamic.js']).toContain(
		"})((getSpecifier('kody-codemod-0007')))), options)",
	)
	expect(prefixPackagesInvokeSpecifiersCodemod.transform(result.files)).toEqual(
		{
			files: result.files,
			changed: false,
			changedPaths: [],
			needsManual: [],
		},
	)
})

test('0007 rewrites TypeScript non-null packages member and callee forms', () => {
	const source = `
packages!.invoke(firstSpecifier, firstOptions)
packages.invoke!(secondSpecifier, secondOptions)
packages!.invoke!(thirdSpecifier, thirdOptions)
(packages.invoke(fourthSpecifier, fourthOptions))!
`
	const result = prefixPackagesInvokeSpecifiersCodemod.transform({
		'non-null.ts': source,
	})
	const transformed = result.files['non-null.ts'] ?? ''

	expect(result.needsManual).toEqual([])
	expect(transformed.match(/kody-codemod-0007/g)).toHaveLength(4)
	expect(transformed).toContain('})((firstSpecifier)), firstOptions)')
	expect(transformed).toContain('})((secondSpecifier)), secondOptions)')
	expect(transformed).toContain('})((thirdSpecifier)), thirdOptions)')
	expect(transformed).toContain('})((fourthSpecifier)), fourthOptions))!')
	expect(prefixPackagesInvokeSpecifiersCodemod.transform(result.files)).toEqual(
		{
			files: result.files,
			changed: false,
			changedPaths: [],
			needsManual: [],
		},
	)
})

test('0007 rewrites static computed invoke access but ignores dynamic keys', () => {
	const files = {
		'computed.ts': `
packages['invoke'](firstSpecifier, firstOptions)
packages["invoke"](secondSpecifier, secondOptions)
packages?.['invoke']?.(thirdSpecifier, thirdOptions)
`,
		'dynamic.ts': 'packages[method](dynamicSpecifier, options)\n',
	}
	const result = prefixPackagesInvokeSpecifiersCodemod.transform(files)
	const transformed = result.files['computed.ts'] ?? ''

	expect(result.changedPaths).toEqual(['computed.ts'])
	expect(result.needsManual).toEqual([])
	expect(transformed.match(/kody-codemod-0007/g)).toHaveLength(3)
	expect(transformed).toContain("packages['invoke']((")
	expect(transformed).toContain('packages["invoke"]((')
	expect(transformed).toContain("packages?.['invoke']?.((")
	expect(result.files['dynamic.ts']).toBe(files['dynamic.ts'])
	expect(prefixPackagesInvokeSpecifiersCodemod.transform(result.files)).toEqual(
		{
			files: result.files,
			changed: false,
			changedPaths: [],
			needsManual: [],
		},
	)
})

test('0007 composes nested arg0 rewrites without overlapping ranges', () => {
	const source =
		'packages.invoke(select(packages.invoke(innerSpecifier)), outerOptions)\n'
	const result = prefixPackagesInvokeSpecifiersCodemod.transform({
		'nested.js': source,
	})
	const transformed = result.files['nested.js'] ?? ''

	expect(transformed.match(/kody-codemod-0007/g)).toHaveLength(2)
	expect(transformed).toContain(
		'packages.invoke(/** @type {`kody:@${string}/${string}`} */',
	)
	expect(transformed).toContain(
		'select(packages.invoke(/** @type {`kody:@${string}/${string}`} */',
	)
	expect(prefixPackagesInvokeSpecifiersCodemod.transform(result.files)).toEqual(
		{
			files: result.files,
			changed: false,
			changedPaths: [],
			needsManual: [],
		},
	)
})

test('0007 emits type-correct TS and JSDoc-only JS wrappers', () => {
	const tsSource =
		"declare const dynamicSpecifier: unknown\npackages.invoke(dynamicSpecifier, { exportName: 'run' })\n"
	const declarationSource = `
declare const packages: {
  invoke(specifier: \`kody:@\${string}/\${string}\`, options?: unknown): unknown
}
`
	const jsSource = `
export {}
const dynamicSpecifier = /** @type {unknown} */ (null)
const options = {}
packages.invoke(dynamicSpecifier, options)
`
	const result = prefixPackagesInvokeSpecifiersCodemod.transform({
		'index.ts': tsSource,
		'worker.js': jsSource,
	})
	const transformedTs = result.files['index.ts'] ?? ''
	const transformedJs = result.files['worker.js'] ?? ''
	const compilerOptions = {
		allowJs: true,
		checkJs: true,
		noEmit: true,
		strict: true,
		target: ts.ScriptTarget.ES2022,
	} satisfies ts.CompilerOptions
	const host = ts.createCompilerHost(compilerOptions)
	const getSourceFile = host.getSourceFile.bind(host)
	host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
		fileName === 'index.ts'
			? ts.createSourceFile(fileName, transformedTs, languageVersion, true)
			: fileName === 'runtime.d.ts'
				? ts.createSourceFile(
						fileName,
						declarationSource,
						languageVersion,
						true,
					)
				: fileName === 'worker.js'
					? ts.createSourceFile(
							fileName,
							transformedJs,
							languageVersion,
							true,
							ts.ScriptKind.JS,
						)
					: getSourceFile(fileName, languageVersion, onError, shouldCreate)
	host.fileExists = (
		(fileExists) => (fileName) =>
			fileName === 'index.ts' ||
			fileName === 'worker.js' ||
			fileName === 'runtime.d.ts' ||
			fileExists(fileName)
	)(host.fileExists.bind(host))
	host.readFile = (
		(readFile) => (fileName) =>
			fileName === 'index.ts'
				? transformedTs
				: fileName === 'worker.js'
					? transformedJs
					: fileName === 'runtime.d.ts'
						? declarationSource
						: readFile(fileName)
	)(host.readFile.bind(host))
	const diagnostics = ts.getPreEmitDiagnostics(
		ts.createProgram({
			rootNames: ['index.ts', 'worker.js', 'runtime.d.ts'],
			options: compilerOptions,
			host,
		}),
	)

	expect(
		diagnostics.map((diagnostic) =>
			ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
		),
	).toEqual([])
	expect(transformedTs).toContain(
		'(__kodyCodemod0007Value: unknown): `kody:@${string}/${string}`',
	)
	expect(transformedJs).toContain('/** @type {`kody:@${string}/${string}`} */')
	expect(transformedJs).toContain('/** @type {unknown} */')
	expect(transformedJs).not.toMatch(/: unknown| as `kody:/)
})

test('0007 normalizes parseable Markdown dynamics and is idempotent', () => {
	const files = {
		'guide.md': `
\`\`\`ts
await packages.invoke(metadata.import_specifier, options)
\`\`\`

\`\`\`js
await packages.invoke(makeSpecifier(), options)
\`\`\`

Inline: \`packages.invoke(condition ? left : right, { exportName: chooseExport() })\`.
`,
		'guide.mdx': `
\`\`\`tsx
await packages?.invoke(\`@\${owner}/pkg/run\`, options)
\`\`\`
`,
	}
	const result = prefixPackagesInvokeSpecifiersCodemod.transform(files)

	expect(result.changedPaths).toEqual(['guide.md', 'guide.mdx'])
	expect(result.needsManual).toEqual([])
	expect(result.files['guide.md']).toContain(
		'(__kodyCodemod0007Value: unknown)',
	)
	expect(result.files['guide.md']).toContain('/** @type {any} */')
	expect(result.files['guide.mdx']).toContain('kody-codemod-0007')
	expect(prefixPackagesInvokeSpecifiersCodemod.transform(result.files)).toEqual(
		{
			files: result.files,
			changed: false,
			changedPaths: [],
			needsManual: [],
		},
	)
	expect(prefixPackagesInvokeSpecifiersCodemod.detect(result.files)).toEqual([])
})

test('0007 keeps generated single-backtick Markdown inline code valid', () => {
	const source =
		'Inline: `packages.invoke(condition ? left : right, options)`.\n'
	const result = prefixPackagesInvokeSpecifiersCodemod.transform({
		'inline.md': source,
	})
	const transformed = result.files['inline.md'] ?? ''
	const backticks = transformed.match(/`/g) ?? []
	const inlineContent = transformed.slice(
		transformed.indexOf('`') + 1,
		transformed.lastIndexOf('`'),
	)

	expect(backticks).toHaveLength(2)
	expect(transformed).toContain('/** @type {any} */')
	expect(transformed).not.toContain('`kody:@${string}/${string}`')
	expect(() => parseModuleSource(inlineContent)).not.toThrow()
	expect(prefixPackagesInvokeSpecifiersCodemod.transform(result.files)).toEqual(
		{
			files: result.files,
			changed: false,
			changedPaths: [],
			needsManual: [],
		},
	)
	expect(prefixPackagesInvokeSpecifiersCodemod.detect(result.files)).toEqual([])
})

test('0007 keeps multiline Markdown inline spans manual', () => {
	const source =
		'Inline: `packages.invoke(/* private comment\n*/ privateSpecifier)`.\n'
	const result = prefixPackagesInvokeSpecifiersCodemod.transform({
		'multiline-inline.md': source,
	})

	expect(result).toEqual({
		files: { 'multiline-inline.md': source },
		changed: false,
		changedPaths: [],
		needsManual: [
			{
				path: 'multiline-inline.md',
				message:
					'A packages.invoke call is ambiguous or cannot be safely rewritten; add the kody: prefix manually.',
			},
		],
	})
	expect(JSON.stringify(result.needsManual)).not.toContain('privateSpecifier')
})

test('0007 Markdown fallback requires a call shape and keeps findings privacy-safe', () => {
	const privateSource = '@private-owner/private-package/private-export'
	const files = {
		'discord.md':
			'Architecture labels: packages.invoke → runtime worker → package export.\n',
		'prose.md': `A malformed example packages.invoke(${privateSource} remains here.\n`,
		'untyped.md': `\`\`\`text\npackages.invoke(${privateSource})\n\`\`\`\n`,
		'broken.ts': `packages.invoke(${privateSource}\n`,
		'broken-optional.ts': `packages.invoke /* private */ ?. (${privateSource}\n`,
		'broken-non-null-packages.ts': `packages! /* private */ .invoke(${privateSource}\n`,
		'broken-non-null-invoke.ts': `packages.invoke! /* private */ (${privateSource}\n`,
		'broken-non-null-both.ts': `packages! /* private */ .invoke! /* private */ ?. (${privateSource}\n`,
	}
	const result = prefixPackagesInvokeSpecifiersCodemod.transform(files)

	expect(result.files).toEqual(files)
	expect(result.changed).toBe(false)
	expect(result.needsManual.map((finding) => finding.path)).toEqual([
		'broken-non-null-both.ts',
		'broken-non-null-invoke.ts',
		'broken-non-null-packages.ts',
		'broken-optional.ts',
		'broken.ts',
		'prose.md',
		'untyped.md',
	])
	expect(result.needsManual.map((finding) => finding.path)).not.toContain(
		'discord.md',
	)
	expect(JSON.stringify(result.needsManual)).not.toContain(privateSource)
	expect(JSON.stringify(result.needsManual)).not.toContain('private-owner')
	expect(JSON.stringify(result.needsManual)).not.toContain('private-package')
})

test('0007 leaves object, spread, missing, and ambiguous bindings manual as before', () => {
	const files = {
		'object.ts': `packages.invoke({ kodyId: 'legacy', exportName: 'run' })\n`,
		'spread.ts': 'packages.invoke(...args)\n',
		'missing.ts': 'packages.invoke()\n',
		'bound.ts':
			'const packages = localPackages\npackages.invoke(dynamicSpecifier)\n',
	}
	const result = prefixPackagesInvokeSpecifiersCodemod.transform(files)

	expect(result.changed).toBe(false)
	expect(result.files).toEqual(files)
	expect(result.needsManual.map((finding) => finding.path)).toEqual([
		'bound.ts',
		'missing.ts',
		'spread.ts',
	])
})

test('0007 treats packages and packages.invoke mutations as ambiguous', () => {
	const files = {
		'assigned-invoke.js':
			'packages.invoke = value => value\npackages.invoke(dynamicSpecifier)\n',
		'assigned-packages.js':
			'packages = otherPackages\npackages.invoke(dynamicSpecifier)\n',
		'assigned-computed-invoke.js':
			"packages['invoke'] = replacement\npackages.invoke(dynamicSpecifier)\n",
		'assigned-non-null-invoke.ts':
			'packages!.invoke = replacement\npackages.invoke(dynamicSpecifier)\n',
		'updated-invoke.js':
			'packages.invoke++\npackages.invoke(dynamicSpecifier)\n',
		'updated-packages.js': 'packages++\npackages.invoke(dynamicSpecifier)\n',
		'deleted-invoke.js':
			'delete packages.invoke\npackages.invoke(dynamicSpecifier)\n',
		'deleted-optional-invoke.js':
			'delete packages?.invoke\npackages.invoke(dynamicSpecifier)\n',
		'destructured-object-assignment.js':
			'({ packages } = replacements)\npackages.invoke(dynamicSpecifier)\n',
		'destructured-array-assignment.js':
			';[packages] = values\npackages.invoke(dynamicSpecifier)\n',
		'for-of-assignment.js':
			'for (packages of providers) {}\npackages.invoke(dynamicSpecifier)\n',
		'for-in-assignment.js':
			'for (packages in providers) {}\npackages.invoke(dynamicSpecifier)\n',
		'for-of-object-assignment.js':
			'for ({ packages } of providers) {}\npackages.invoke(dynamicSpecifier)\n',
		'for-in-array-assignment.js':
			'for ([packages] in providers) {}\npackages.invoke(dynamicSpecifier)\n',
	}
	const result = prefixPackagesInvokeSpecifiersCodemod.transform(files)

	expect(result.changed).toBe(false)
	expect(result.files).toEqual(files)
	expect(result.needsManual.map((finding) => finding.path)).toEqual(
		Object.keys(files).sort((left, right) => left.localeCompare(right)),
	)
	expect(
		result.needsManual.every(
			(finding) =>
				finding.message ===
				'A packages.invoke call is ambiguous or cannot be safely rewritten; add the kody: prefix manually.',
		),
	).toBe(true)
	expect(JSON.stringify(result.needsManual)).not.toContain('dynamicSpecifier')
})

test('0007 is permanent and registered after the object-only migration', () => {
	expect(prefixPackagesInvokeSpecifiersCodemodId).toBe(
		'0007-prefix-packages-invoke-specifiers',
	)
	expect(getPackageCodemodById(prefixPackagesInvokeSpecifiersCodemodId)).toBe(
		prefixPackagesInvokeSpecifiersCodemod,
	)
})
