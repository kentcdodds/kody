import { expect, test } from 'vitest'
import { entitlementResourceVisibility } from './resource-visibility.ts'

test('stored_email_messages howToReduce names the delete paths that exist', () => {
	expect(entitlementResourceVisibility.stored_email_messages.howToReduce).toBe(
		'Delete messages you no longer need from /account/email, or with emailMessageDelete.',
	)
})
