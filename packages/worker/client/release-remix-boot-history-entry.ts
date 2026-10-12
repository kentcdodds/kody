/**
 * Remix `run()` tags the boot history entry with its frame-navigation state.
 * A Back/Forward onto a tagged entry is intercepted by Remix, which refetches
 * the whole document and reconciles `<head>` and `<body>` while the client
 * router answers the same `popstate`. The reconcile drops route head links
 * (the feature-page stylesheet) under the still-visible previous page and
 * defers scroll until the refetch settles. Every other top-level entry comes
 * from the client router's `pushState` and carries no Remix state, so
 * clearing the boot entry gives the client router sole ownership of
 * top-level history. Named-frame entries (`data-rmx-target`) keep their state
 * so Remix still reloads those frames on traversal.
 */
type NavigationEntryLike = {
	getState: () => unknown
}

export type BootHistoryNavigationLike = {
	readonly currentEntry: NavigationEntryLike | null
	updateCurrentEntry: (options: { state: unknown }) => void
}

function isRemixTopFrameState(state: unknown) {
	if (typeof state !== 'object' || state === null) return false
	if (!('$rmx' in state)) return false
	return (state as { target?: unknown }).target == null
}

export function releaseRemixBootHistoryEntry(
	navigation: BootHistoryNavigationLike | undefined = typeof window ===
	'undefined'
		? undefined
		: (window as { navigation?: BootHistoryNavigationLike }).navigation,
): void {
	const entry = navigation?.currentEntry
	if (!navigation || !entry) return
	if (!isRemixTopFrameState(entry.getState())) return
	try {
		// `state: undefined` fails the required-member check; `null` is not
		// Remix runtime state.
		navigation.updateCurrentEntry({ state: null })
	} catch {
		// Inactive document; the next boot tags and releases a fresh entry.
	}
}
