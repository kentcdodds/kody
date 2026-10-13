/**
 * Customer CNAME target / Cloudflare for SaaS origin hostname for a
 * package-app apex (`domains.<apex>`). Same host is the zone fallback origin
 * (ADR 0071) — not the apex itself, so customer DNS never points at a
 * misleading "fallback" label.
 */
export function packageAppCustomDomainsCnameTarget(
	packageAppHostname: string,
): string {
	return `domains.${packageAppHostname}`
}

/** Derive {@link packageAppCustomDomainsCnameTarget} from PACKAGE_APP_BASE_URL. */
export function packageAppCustomDomainsCnameTargetFromBaseUrl(
	packageAppBaseUrl: string | undefined | null,
): string | null {
	const base = packageAppBaseUrl?.trim()
	if (!base) return null
	try {
		return packageAppCustomDomainsCnameTarget(new URL(base).hostname)
	} catch {
		return null
	}
}
