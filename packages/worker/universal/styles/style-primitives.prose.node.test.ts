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
	expect(html).toContain('[data-markdown-table-compact-last]')
})

test('prose headings with ids expose permalink anchors and scroll margin', async () => {
	const html = await renderToString(
		jsx('div', {
			mix: css(proseCss),
			children: jsx('h2', {
				id: 'example',
				children: [
					jsx('a', {
						href: '#example',
						'data-heading-anchor': '',
						children: 'link',
					}),
					'Example section',
				],
			}),
		}),
	)

	expect(html).toContain('scroll-margin-top: 5.5rem')
	expect(html).toContain('[data-heading-anchor]')
	expect(html).toContain('display: flex')
})
