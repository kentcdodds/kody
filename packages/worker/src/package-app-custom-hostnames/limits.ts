/**
 * ADR 0071 abuse / allotment bounds for package-app custom hostnames.
 * Paying orgs get one domain at no extra charge; extras are noted for later
 * Stripe metering. This hard cap prevents unbounded Cloudflare for SaaS
 * growth before metering ships (CF's first 100 hostnames are free).
 */
export const packageAppCustomHostnameMaxPerOrg = 20

/** Org-scoped add budget: 10 claims per hour. Sync/delete are uncapped. */
export const packageAppCustomHostnameAddRateLimit = {
	maxRequests: 10,
	windowSeconds: 60 * 60,
} as const

export function packageAppCustomHostnameAddRateLimitKey(orgId: string) {
	return `package-app-custom-hostname:add:org:${orgId}`
}
