import { expect, test } from 'vitest'
import { highlightCacheHeaderName } from '../../worker/universal/highlight-cache-header.ts'
import handler from './index.ts'

test('highlight worker returns tokens and a cache header', async () => {
	const response = await handler.fetch(
		new Request('https://highlight.internal/highlight', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				snippets: [{ code: 'const x = 1', lang: 'ts' }],
			}),
		}),
		{},
	)
	expect(response.status).toBe(200)
	const body = (await response.json()) as {
		results: Array<{ code: string; plain: boolean }>
	}
	expect(body.results).toHaveLength(1)
	expect(body.results[0]?.code).toBe('const x = 1')
	expect(body.results[0]?.plain).toBe(false)
	expect(response.headers.get(highlightCacheHeaderName)).toBe('miss')
})
