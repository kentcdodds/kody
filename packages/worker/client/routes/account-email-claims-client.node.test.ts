import { type Handle } from 'remix/ui'
import { expect, test, vi } from 'vitest'
import { createAccountEmailClaims } from './account-email-claims-client.ts'

class TestDetailsElement {
	open: boolean
	constructor(open: boolean) {
		this.open = open
	}
}

class TestInputElement {
	value: string
	constructor(value: string) {
		this.value = value
	}
}

vi.stubGlobal('HTMLDetailsElement', TestDetailsElement)
vi.stubGlobal('HTMLInputElement', TestInputElement)

function createStubHandle() {
	return {
		update() {
			return Promise.resolve(new AbortController().signal)
		},
	} as unknown as Handle
}

function createCurrentTargetEvent<TEvent extends Event>(
	currentTarget: TestDetailsElement | TestInputElement,
) {
	return { currentTarget } as unknown as TEvent
}

test('change-email disclosure stays open when the first new-email keystroke rerenders', () => {
	const claims = createAccountEmailClaims(createStubHandle())

	claims.handleEmailChangeToggle(
		createCurrentTargetEvent(new TestDetailsElement(true)),
	)
	expect(claims.snapshot.emailChangeOpen).toBe(true)

	claims.updateDraftEmail(
		createCurrentTargetEvent<InputEvent>(new TestInputElement('n')),
	)

	expect(claims.snapshot.draftEmail).toBe('n')
	expect(claims.snapshot.emailChangeOpen).toBe(true)

	claims.handleEmailChangeToggle(
		createCurrentTargetEvent(new TestDetailsElement(false)),
	)
	expect(claims.snapshot.emailChangeOpen).toBe(false)
})
