/**
 * One-shot hard reload when a stale tab hits "Unknown Start release." after a
 * deploy (KODY-9E / issue 7795797021). Mirrors the boot-chunk reload flag in
 * `entry.tsx` (`kody:boot-chunk-reload`): set before reload, clear after a
 * successful boot so a later deploy can recover again.
 */

import { isUnknownStartReleaseError } from '#client/sentry-browser-filters.ts'
import {
	getSessionStorageItem,
	setSessionStorageItem,
} from '#client/session-storage-access.ts'

export const unknownStartReleaseReloadFlag = 'kody:unknown-start-release-reload'

/**
 * If `error` is the post-deploy Start release miss, attempt one hard reload
 * for this tab session. Returns whether a reload was triggered. Never throws
 * when sessionStorage is unavailable (and does not reload in that case, to
 * avoid a loop with no flag). Leave the flag set across a failed recovery;
 * call `clearUnknownStartReleaseReloadFlag` after a successful boot.
 */
export function reloadOnUnknownStartRelease(error: unknown): boolean {
	if (!isUnknownStartReleaseError(error)) return false
	if (typeof window === 'undefined') return false
	try {
		if (getSessionStorageItem(unknownStartReleaseReloadFlag)) return false
		if (!setSessionStorageItem(unknownStartReleaseReloadFlag, '1')) {
			return false
		}
		window.location.reload()
		return true
	} catch {
		return false
	}
}

/** Best-effort clear after a successful client boot (mirrors boot-chunk). */
export function clearUnknownStartReleaseReloadFlag(): void {
	try {
		sessionStorage.removeItem(unknownStartReleaseReloadFlag)
	} catch {
		// Storage may be unavailable (private mode); clearing is best-effort.
	}
}
