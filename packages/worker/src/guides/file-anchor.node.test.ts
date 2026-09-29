import { expect, test } from 'vitest'

import { readAnchoredText, splitFileAnchor } from './file-anchor.ts'
import { FileAnchorError } from './line-anchor.ts'

const sourceLines = Array.from(
	{ length: 200 },
	(_, index) => `line ${String(index + 1)}`,
)
const source = sourceLines.join('\n')

const readme = `# Title

Intro.

## Export JSDoc

Document the export.

## Other

Elsewhere.
`

const read = (fragment: string, path = 'src/file.ts') =>
	readAnchoredText({
		path,
		content: path === 'README.md' ? readme : source,
		fragment,
	})

test('file anchors focus line ranges and markdown headings', () => {
	expect(splitFileAnchor('src/file.ts')).toEqual({
		path: 'src/file.ts',
		fragment: null,
	})
	expect(splitFileAnchor('README.md#export%20jsdoc')).toEqual({
		path: 'README.md',
		fragment: 'export jsdoc',
	})
	expect(() => splitFileAnchor('README.md#')).toThrow(FileAnchorError)
	expect(() => splitFileAnchor('#L165')).toThrow(/File path before/)

	const line = read('L165')
	expect(line.anchor).toMatchObject({
		kind: 'lines',
		requested: 'L165',
		requestedStartLine: 165,
		requestedEndLine: 165,
		startLine: 145,
		endLine: 185,
		totalLines: 200,
		heading: null,
	})
	for (const n of [145, 165, 185])
		expect(line.content).toContain(`${n}|line ${n}`)
	for (const n of [144, 186])
		expect(line.content).not.toContain(`${n}|line ${n}`)
	expect(line.content).not.toBe(source)

	const range = read('L165-L180')
	expect(range.anchor).toMatchObject({
		kind: 'lines',
		requestedStartLine: 165,
		requestedEndLine: 180,
		startLine: 165,
		endLine: 180,
	})
	for (const n of [165, 180]) expect(range.content).toContain(`${n}|line ${n}`)
	for (const n of [164, 181])
		expect(range.content).not.toContain(`${n}|line ${n}`)

	const heading = read('export-jsdoc', 'README.md')
	expect(heading.anchor).toMatchObject({
		kind: 'heading',
		heading: { slug: 'export-jsdoc', title: 'Export JSDoc' },
	})
	expect(heading.content).toContain('Document the export.')
	expect(heading.content).toContain('## Export JSDoc')
	expect(heading.content).not.toContain('Elsewhere.')
	expect(heading.content).not.toContain('Intro.')

	for (const [fragment, error] of [
		['L999', /Line 999 is past the end of src\/file\.ts#L999 \(200 lines\)/],
		['L180-L165', /must start at or before the end line/],
		['L0', /Line numbers start at 1/],
		[
			'export-jsdoc',
			/Heading anchor "export-jsdoc" is not supported on src\/file\.ts/,
		],
	] as const) {
		expect(() => read(fragment)).toThrow(error)
	}
	expect(() => read('missing-heading', 'README.md')).toThrow(
		/Unknown heading "missing-heading" for README.md/,
	)
})
