import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
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
	expect(html).toContain('role="status"')
	expect(html).toContain(snippet)
	expect(html).not.toContain('>Copy<')
	expect(html).not.toContain('>Copied<')

	const withoutCopy = await renderToString(
		jsx(CopyCodeBlock, { code: snippet, lang: 'bash', copy: false }),
	)
	expect(withoutCopy).toContain(snippet)
	expect(withoutCopy).not.toMatch(/<div[^>]*\sdata-copy-code/)
	expect(withoutCopy).not.toContain('<button')
	expect(withoutCopy).not.toContain('data-icon="copy"')
	expect(withoutCopy).not.toContain('Copy code to clipboard')
})
