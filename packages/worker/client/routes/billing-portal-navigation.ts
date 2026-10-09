import { routes } from '#universal/routes.ts'

/**
 * Primary clicks hard-navigate to the billing portal. That handler 302s to
 * Stripe, and a Remix soft-nav fetch of the redirect throws
 * `TypeError: Failed to fetch` (KODY-88). The anchor keeps `href` for
 * new-tab and no-JS visits, and sets `data-rmx-document` so Remix leaves
 * the navigation to the browser before this handler hydrates.
 */
export function billingPortalPath(orgSlug: string) {
	return routes.orgBillingPortal.href({ orgSlug })
}

export function navigateBillingPortalOnPrimaryClick(
	event: Event,
	orgSlug: string,
) {
	if (isModifiedClick(event)) return
	event.preventDefault()
	window.location.assign(billingPortalPath(orgSlug))
}

function isModifiedClick(event: Event) {
	if (!('button' in event)) return false
	const mouse = event as MouseEvent
	if (mouse.button !== 0) return true
	return Boolean(
		mouse.metaKey || mouse.altKey || mouse.ctrlKey || mouse.shiftKey,
	)
}
