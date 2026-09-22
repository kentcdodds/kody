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

	const line = readAnchoredText({
		path: 'src/file.ts',
		content: source,
		fragment: 'L165',
	})
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
	expect(line.content).toContain('165|line 165')
	expect(line.content).toContain('145|line 145')
	expect(line.content).toContain('185|line 185')
	expect(line.content).not.toContain('144|line 144')
	expect(line.content).not.toContain('186|line 186')
	expect(line.content).not.toBe(source)

	const range = readAnchoredText({
		path: 'src/file.ts',
		content: source,
		fragment: 'L165-L180',
	})
	expect(range.anchor).toMatchObject({
		kind: 'lines',
		requestedStartLine: 165,
		requestedEndLine: 180,
		startLine: 165,
		endLine: 180,
	})
	expect(range.content).toContain('165|line 165')
	expect(range.content).toContain('180|line 180')
	expect(range.content).not.toContain('164|line 164')
	expect(range.content).not.toContain('181|line 181')

	const heading = readAnchoredText({
		path: 'README.md',
		content: readme,
		fragment: 'export-jsdoc',
	})
	expect(heading.anchor).toMatchObject({
		kind: 'heading',
		heading: { slug: 'export-jsdoc', title: 'Export JSDoc' },
	})
	expect(heading.content).toContain('Document the export.')
	expect(heading.content).toContain('## Export JSDoc')
	expect(heading.content).not.toContain('Elsewhere.')
	expect(heading.content).not.toContain('Intro.')

	expect(() =>
		readAnchoredText({
			path: 'README.md',
			content: readme,
			fragment: 'missing-heading',
		}),
	).toThrow(/Unknown heading "missing-heading" for README.md/)
	expect(() =>
		readAnchoredText({
			path: 'src/file.ts',
			content: source,
			fragment: 'L999',
		}),
	).toThrow(/Line 999 is past the end of src\/file\.ts#L999 \(200 lines\)/)
	expect(() =>
		readAnchoredText({
			path: 'src/file.ts',
			content: source,
			fragment: 'L180-L165',
		}),
	).toThrow(/must start at or before the end line/)
	expect(() =>
		readAnchoredText({
			path: 'src/file.ts',
			content: source,
			fragment: 'L0',
		}),
	).toThrow(/Line numbers start at 1/)
	expect(() =>
		readAnchoredText({
			path: 'src/file.ts',
			content: source,
			fragment: 'export-jsdoc',
		}),
	).toThrow(/Heading anchor "export-jsdoc" is not supported on src\/file\.ts/)
})
