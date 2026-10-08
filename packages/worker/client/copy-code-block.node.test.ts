import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { CopyCodeBlock } from './copy-code-block.tsx'

const snippet = 'npx @kodycodes/cli execute --local'

test('code block copy control is an icon button beside the snippet', async () => {
	const html = await renderToString(
		jsx(CopyCodeBlock, { code: snippet, lang: 'bash' }),
	)

	expect(html).toMatch(/<div[^>]*\sdata-copy-code=""/)
	expect(html).toContain('aria-label="Copy code to clipboard"')
	expect(html).toContain('data-icon="copy"')
	expect(html).toContain('width="0.5rem"')
	expect(html).toContain('height="0.5rem"')
	expect(html).toContain('width: 1rem')
	expect(html).toContain('height: 1rem')
	expect(html).toContain('margin-inline-end: 1.35rem')
	expect(html).not.toContain('2rem')
	expect(html).toContain('role="status"')
	expect(html).toContain(snippet)

	const withoutCopy = await renderToString(
		jsx(CopyCodeBlock, { code: snippet, lang: 'bash', copy: false }),
	)
	expect(withoutCopy).toContain(snippet)
	expect(withoutCopy).not.toMatch(/<div[^>]*\sdata-copy-code/)
	expect(withoutCopy).not.toContain('<button')
	expect(withoutCopy).not.toContain('data-icon="copy"')
	expect(withoutCopy).not.toContain('Copy code to clipboard')
})
