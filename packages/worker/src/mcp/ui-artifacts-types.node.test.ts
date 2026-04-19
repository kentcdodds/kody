import { expect, test } from 'vitest'
import { hasUiArtifactServerCode } from './ui-artifacts-types.ts'

test('hasUiArtifactServerCode ignores null, empty, and whitespace-only values', () => {
	expect(hasUiArtifactServerCode(null)).toBe(false)
	expect(hasUiArtifactServerCode(undefined)).toBe(false)
	expect(hasUiArtifactServerCode(false)).toBe(false)
	expect(hasUiArtifactServerCode(true)).toBe(true)
})
