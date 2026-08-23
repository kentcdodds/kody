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
