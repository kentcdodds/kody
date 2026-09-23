import { expect, test, vi } from 'vitest'
import { createPackageTitleInstallArm } from './community-detail-install.ts'

const idleTooltip =
	'This was built by another user. Verify it before using. Click again to confirm fork.'

test('an outside click clears an armed package-title fork and a click on the control does not', () => {
	class FakeNode {}
	class FakeElement extends FakeNode {
		attributes = new Map<string, string>([
			['data-title-idle-label', 'Fork'],
			['data-title-idle-tooltip', idleTooltip],
			['aria-label', 'Fork'],
		])
		tooltip = { textContent: idleTooltip }
		parentElement: FakeElement | null = null

		constructor(listingId: string) {
			super()
			this.attributes.set('data-package-title-listing', listingId)
		}

		getAttribute(name: string) {
			return this.attributes.get(name) ?? null
		}

		setAttribute(name: string, value: string) {
			this.attributes.set(name, value)
		}

		querySelector(selector: string) {
			if (selector === '[data-title-status-tooltip]') return this.tooltip
			return null
		}

		closest(selector: string) {
			if (selector === '[data-community-install]') return this
			return null
		}
	}

	class FakeText extends FakeNode {
		constructor(readonly parentElement: FakeElement) {
			super()
		}
	}

	const control = new FakeElement('listing-1')
	const listeners = new Map<string, EventListener>()
	vi.stubGlobal('Element', FakeElement)
	vi.stubGlobal('Node', FakeNode)
	vi.stubGlobal('HTMLElement', class FakeHTMLElement {})
	vi.stubGlobal('document', {
		querySelectorAll(selector: string) {
			if (selector === '[data-community-install]') return [control]
			return []
		},
		addEventListener(type: string, listener: EventListener) {
			listeners.set(type, listener)
		},
		removeEventListener(type: string) {
			listeners.delete(type)
		},
	})

	let listingId: string | null = null
	let armed = false
	const installArm = createPackageTitleInstallArm({
		confirm: {
			get doubleCheck() {
				return armed
			},
			reset() {
				armed = false
			},
			arm() {
				armed = true
			},
		},
		getListingId: () => listingId,
		setListingId(next) {
			listingId = next
		},
	})

	try {
		installArm.arm(control as unknown as Element, 'listing-1')
		expect(armed).toBe(true)
		expect(listingId).toBe('listing-1')
		expect(control.attributes.get('aria-label')).toBe('Confirm fork')
		expect(control.tooltip.textContent).toBe('Confirm fork')
		expect(listeners.has('click')).toBe(true)

		const click = listeners.get('click')
		click?.({ target: new FakeText(control) } as unknown as Event)
		expect(armed).toBe(true)
		expect(listeners.has('click')).toBe(true)

		const outside = new FakeElement('elsewhere')
		outside.closest = () => null
		click?.({ target: outside } as unknown as Event)
		expect(armed).toBe(false)
		expect(listingId).toBeNull()
		expect(control.attributes.get('aria-label')).toBe('Fork')
		expect(control.tooltip.textContent).toBe(idleTooltip)
		expect(listeners.has('click')).toBe(false)
	} finally {
		vi.unstubAllGlobals()
	}
})
