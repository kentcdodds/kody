import { expect, test } from 'vitest'
import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { PackageFilesExplorer } from '#client/package-files-explorer.tsx'
import { type PackageFilesLoaderData } from '#universal/loader-data.ts'

function tabbedFileData(): PackageFilesLoaderData {
	const code = '\t\t<Button'
	return {
		ok: true,
		title: 'tab-width-fixture',
		backHref: '/@jane/tab-width-fixture',
		backLabel: 'Code',
		filesBasePath: '/@jane/tab-width-fixture/tree/main',
		selectedPath: 'example.tsx',
		kind: 'file',
		paths: ['example.tsx'],
		children: [{ name: 'example.tsx', path: 'example.tsx', kind: 'file' }],
		content: code,
		contentPath: 'example.tsx',
		contentKind: 'code',
		language: 'tsx',
		contentHighlighted: {
			code,
			lang: 'tsx',
			plain: false,
			fg: '#24292e',
			bg: '#fff',
			lines: [[{ content: '\t' }, { content: '\t' }, { content: '<Button' }]],
		},
		username: 'jane',
		kodyId: 'tab-width-fixture',
		viewerIsOwner: true,
		isPrivate: false,
		isListed: false,
	}
}

test('package file line numbers stay out of the tab-stop origin', async () => {
	const html = await renderToString(
		jsx(PackageFilesExplorer, { data: tabbedFileData() }),
	)

	expect(html).toContain('data-testid="package-files-code"')
	expect(html).toContain('\t')
	expect(html).toContain('&lt;Button')
	expect(html).toContain('counter(package-file-line)')
	expect(html).toMatch(/\.line::before\s*\{[^}]*position:\s*absolute/)
	expect(html).toMatch(/\.line\s*\{[^}]*padding-inline-start/)
	expect(html).not.toMatch(/\.line::before\s*\{[^}]*display:\s*inline-block/)
})
