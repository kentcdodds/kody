import { expect, test } from 'vitest'
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
		'worker.js': 'await packages.invoke(`@owner/template/export`, options)\n',
	}
	const result = prefixPackagesInvokeSpecifiersCodemod.transform(files)

	expect(result).toMatchObject({
		changed: true,
		changedPaths: ['index.ts', 'worker.js'],
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

	const repeated = prefixPackagesInvokeSpecifiersCodemod.transform(result.files)
	expect(repeated).toEqual({
		files: result.files,
		changed: false,
		changedPaths: [],
		needsManual: [],
	})
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
				'A packages.invoke specifier is dynamic or ambiguous; add the kody: prefix manually.',
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
				'A packages.invoke specifier is dynamic or ambiguous; add the kody: prefix manually.',
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
					'A packages.invoke specifier is dynamic or ambiguous; add the kody: prefix manually.',
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
				'A packages.invoke specifier is dynamic or ambiguous; add the kody: prefix manually.',
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
			path: 'ambiguous.ts',
			message:
				'A packages.invoke specifier is dynamic or ambiguous; add the kody: prefix manually.',
		},
		{
			path: 'broken.ts',
			message:
				'File references packages.invoke but could not be parsed; add kody: prefixes manually.',
		},
	])
	expect(JSON.stringify(result.needsManual)).not.toContain('private-owner')
	expect(JSON.stringify(result.needsManual)).not.toContain('private-package')
})

test('0007 is permanent and registered after the object-only migration', () => {
	expect(prefixPackagesInvokeSpecifiersCodemodId).toBe(
		'0007-prefix-packages-invoke-specifiers',
	)
	expect(getPackageCodemodById(prefixPackagesInvokeSpecifiersCodemodId)).toBe(
		prefixPackagesInvokeSpecifiersCodemod,
	)
})
