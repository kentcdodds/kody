import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { css } from 'remix/ui'
import { expect, test } from 'vitest'
import { proseCss } from './style-primitives.ts'

test('prose lists wrap long inline code instead of stretching past the viewport', async () => {
	const html = await renderToString(
		jsx('div', {
			mix: css(proseCss),
			children: jsx('ol', {
				children: jsx('li', {
					children: jsx('code', {
						children: 'https://www.googleapis.com/auth/gmail.compose',
					}),
				}),
			}),
		}),
	)

	expect(html).toContain('overflow-wrap: anywhere')
	expect(html).toContain('min-width: 0')
	expect(html).toContain('white-space: pre')
	expect(html).toContain('overflow-wrap: normal')
})

test('prose tables keep column layout instead of wrapping the last cell to a sliver', async () => {
	const html = await renderToString(
		jsx('div', {
			mix: css(proseCss),
			children: 'x',
		}),
	)

	expect(html).toContain('display: table')
	expect(html).toContain('white-space: nowrap')
	expect(html).toContain('overflow-wrap: break-word')
	expect(html).toContain('overflow-x: auto')
	expect(html).not.toContain('display: block')
})
