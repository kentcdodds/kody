import { expect, test } from 'vitest'
import {
	accountDeletionConfirmationPhrase,
	isAccountDeletionConfirmation,
} from './account-deletion-confirmation.ts'

test('account deletion confirmation requires the exact GOODBYE KODY phrase', () => {
	expect(accountDeletionConfirmationPhrase).toBe('GOODBYE KODY')
	expect(isAccountDeletionConfirmation('GOODBYE KODY')).toBe(true)
	expect(isAccountDeletionConfirmation('  GOODBYE KODY  ')).toBe(true)
	expect(isAccountDeletionConfirmation('goodbye kody')).toBe(false)
	expect(isAccountDeletionConfirmation('GOODBYE  KODY')).toBe(false)
	expect(isAccountDeletionConfirmation('')).toBe(false)
})
