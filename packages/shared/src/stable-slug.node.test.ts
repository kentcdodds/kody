import { expect, test } from 'vitest'
import { fnv1a32, fnv1a32Hex } from './fnv1a.ts'
import { slugWithStableDisambiguator } from './stable-slug.ts'

test('fnv1a32 matches known FNV-1a vectors', () => {
	expect(fnv1a32('')).toBe(0x811c9dc5)
	expect(fnv1a32('a')).toBe(0xe40c292c)
	expect(fnv1a32Hex('')).toBe('811c9dc5')
})

test('clean values pass through and lossy slugs gain a stable hash suffix', () => {
	const options = {
		fallback: 'server',
		allowedPattern: /^[\w-]+$/,
		replacementPattern: /[^\w-]+/g,
	}
	expect(slugWithStableDisambiguator({ value: 'my-server', ...options })).toBe(
		'my-server',
	)
	const slugged = slugWithStableDisambiguator({
		value: 'My Server!',
		...options,
	})
	expect(slugged).toMatch(/^My_Server_[0-9a-f]{8}$/)
	expect(slugWithStableDisambiguator({ value: 'My Server!', ...options })).toBe(
		slugged,
	)
	expect(
		slugWithStableDisambiguator({ value: 'My Server?', ...options }),
	).not.toBe(slugged)
})
