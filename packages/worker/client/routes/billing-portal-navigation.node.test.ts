import { expect, test, vi } from 'vitest'

import { navigateBillingPortalOnPrimaryClick } from './billing-portal-navigation.ts'

function click(init: {
	button?: number
	metaKey?: boolean
	altKey?: boolean
	ctrlKey?: boolean
	shiftKey?: boolean
}) {
	return {
		button: 0,
		metaKey: false,
		altKey: false,
		ctrlKey: false,
		shiftKey: false,
		preventDefault: vi.fn(),
		...init,
	}
}

test('Manage subscription primary click hard-navigates and modified clicks do not', () => {
	const assign = vi.fn()
	vi.stubGlobal('window', { location: { assign } })

	const primary = click({})
	navigateBillingPortalOnPrimaryClick(primary as unknown as Event)
	expect(primary.preventDefault).toHaveBeenCalledOnce()
	expect(assign).toHaveBeenCalledOnce()
	expect(assign).toHaveBeenCalledWith('/account/billing/portal')

	for (const modified of [
		click({ metaKey: true }),
		click({ ctrlKey: true }),
		click({ shiftKey: true }),
		click({ altKey: true }),
		click({ button: 1 }),
	]) {
		navigateBillingPortalOnPrimaryClick(modified as unknown as Event)
		expect(modified.preventDefault).not.toHaveBeenCalled()
	}
	expect(assign).toHaveBeenCalledOnce()
	vi.unstubAllGlobals()
})
