import { expect, test } from 'vitest'
import { parsePackageInvokeInput } from './input-parsing.ts'

test('packages.invoke rejects unknown input keys and names the accepted keys', () => {
	expect(() =>
		parsePackageInvokeInput({
			kodyId: 'article-audio',
			exportName: './create',
			input: { url: 'https://example.com/article' },
		}),
	).toThrow(
		'packages.invoke received unknown input key "input". Accepted keys: kodyId, packageId, exportName, params, idempotencyKey, topic.',
	)
})
