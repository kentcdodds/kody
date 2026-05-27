import { expect, test } from 'vitest'

import {
	findPresentTenseDocumentationViolations,
	formatPresentTenseViolations,
} from './present-tense-documentation.ts'

test('documentation and user-facing copy avoid changelog-style temporal phrasing', async () => {
	const violations = await findPresentTenseDocumentationViolations()
	expect(
		violations,
		violations.length
			? `Temporal phrasing found:\n${formatPresentTenseViolations(violations)}`
			: undefined,
	).toEqual([])
})
