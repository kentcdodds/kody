import { expect, test } from 'vitest'
import {
	markdownResponse,
	prefersMarkdown,
	withVaryAccept,
} from './markdown-negotiation.ts'

function requestWithAccept(accept: string | null): Request {
	return new Request(
		'https://kody.example/guides/oauth',
		accept === null ? undefined : { headers: { accept } },
	)
}

test('markdown negotiation prefers markdown only when it outranks HTML and sets response headers', async () => {
	// Browsers and default fetches keep the HTML page.
	expect(prefersMarkdown(requestWithAccept(null))).toBe(false)
	expect(prefersMarkdown(requestWithAccept('*/*'))).toBe(false)
	expect(
		prefersMarkdown(
			requestWithAccept(
				'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			),
		),
	).toBe(false)
	// Markdown-first agents get the raw document.
	expect(prefersMarkdown(requestWithAccept('text/markdown'))).toBe(true)
	expect(
		prefersMarkdown(requestWithAccept('text/markdown, text/plain;q=0.9')),
	).toBe(true)
	expect(
		prefersMarkdown(requestWithAccept('text/markdown;q=1, text/html;q=0.5')),
	).toBe(true)
	// Explicit ties go to HTML.
	expect(prefersMarkdown(requestWithAccept('text/html, text/markdown'))).toBe(
		false,
	)
	expect(prefersMarkdown(requestWithAccept('text/markdown;q=0.5, */*'))).toBe(
		false,
	)
	// Wildcards match both representations; exact types override them.
	expect(
		prefersMarkdown(requestWithAccept('text/html;q=0, text/*;q=0.8')),
	).toBe(true)
	expect(
		prefersMarkdown(requestWithAccept('text/markdown;q=0, text/*;q=0.8')),
	).toBe(false)
	expect(prefersMarkdown(requestWithAccept('text/*'))).toBe(false)

	const plain = withVaryAccept(new Response('x'))
	expect(plain.headers.get('vary')).toBe('Accept')
	const existing = withVaryAccept(
		new Response('x', { headers: { Vary: 'Cookie' } }),
	)
	expect(existing.headers.get('vary')).toBe('Cookie, Accept')
	const already = withVaryAccept(
		new Response('x', { headers: { Vary: 'accept' } }),
	)
	expect(already.headers.get('vary')).toBe('accept')

	const response = markdownResponse('# Hello\n')
	expect(response.status).toBe(200)
	expect(response.headers.get('content-type')).toBe(
		'text/markdown; charset=utf-8',
	)
	expect(response.headers.get('vary')).toBe('Accept')
	expect(await response.text()).toBe('# Hello\n')
})
