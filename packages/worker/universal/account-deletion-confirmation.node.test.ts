import { expect, test } from 'vitest'
import {
	accountDeletedConfirmationMessage,
	accountDeletedHomePath,
	accountDeletionConfirmationPhrase,
	isAccountDeletedHome,
	isAccountDeletionConfirmation,
} from './account-deletion-confirmation.ts'

test('account deletion confirmation requires the exact GOODBYE KODY phrase', () => {
	expect(
		isAccountDeletionConfirmation(`  ${accountDeletionConfirmationPhrase}  `),
	).toBe(true)
	expect(isAccountDeletionConfirmation('goodbye kody')).toBe(false)
	expect(isAccountDeletionConfirmation('GOODBYE  KODY')).toBe(false)
	expect(isAccountDeletionConfirmation('')).toBe(false)
})

test('account deleted homepage query is the signed-out confirmation', () => {
	expect(accountDeletedHomePath()).toBe('/?accountDeleted=1')
	expect(accountDeletedConfirmationMessage).toBe(
		'Your Kody account has been deleted',
	)
	expect(isAccountDeletedHome('?accountDeleted=1')).toBe(true)
	expect(isAccountDeletedHome('accountDeleted=1')).toBe(true)
	expect(isAccountDeletedHome('?accountDeleted=1&x=1')).toBe(true)
	expect(isAccountDeletedHome('')).toBe(false)
	expect(isAccountDeletedHome('?accountDeleted=true')).toBe(false)
})
