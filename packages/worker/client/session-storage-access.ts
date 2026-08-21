/**
 * Safe sessionStorage accessors.
 *
 * Firefox throws `SecurityError: The operation is insecure.` when storage is
 * blocked (tracking protection / cookie policy) — including for
 * `typeof sessionStorage` and property access, not only getItem/setItem.
 * Callers must never probe sessionStorage outside a try; these helpers keep
 * that guard in one place (KODY-CLOUDFLARE-5Q).
 */

export function getSessionStorageItem(key: string): string | null {
	try {
		return sessionStorage.getItem(key)
	} catch {
		return null
	}
}

export function setSessionStorageItem(key: string, value: string): boolean {
	try {
		sessionStorage.setItem(key, value)
		return true
	} catch {
		return false
	}
}
