import { css, ref, type Handle } from 'remix/ui'
import { navigate } from '#client/client-router.tsx'
import { on } from '#client/event-mixin.ts'
import { replaceLocation } from '#client/replace-location.ts'
import { type ProfilePackageFilters } from '#universal/community-public-types.ts'
import {
	buildProfileHref,
	isProfilePackageFilterOnlyHrefChange,
} from '#universal/profile-search.ts'
import { inputCss } from '#universal/styles/style-primitives.ts'
import {
	acknowledgeRecordTableSearchInput,
	reconcileRecordTableSearchExternalValue,
	writeUncontrolledSearchInput,
	type RecordTableSearchSync,
} from './record-table-search-sync.ts'

/**
 * Live profile inventory search. The uncapped list is already loaded, so each
 * keystroke rewrites `q` with replaceState and re-filters in render. When
 * `limit` caps the inventory, `q` is loader-affecting: navigate (replace)
 * so search hits the full corpus instead of the newest-N page. The field
 * stays uncontrolled: a Remix-controlled value (or `type="search"`) restores
 * the previous query on the first character and drops focus.
 */
export function ProfileRepositorySearchInput(
	handle: Handle<{
		username: string
		filters: ProfilePackageFilters
	}>,
) {
	let input: HTMLInputElement | null = null
	const initialValue = handle.props.filters.query
	let focused = false
	let sync: RecordTableSearchSync = {
		lastExternalValue: initialValue,
		pendingExternalValue: null,
	}

	function applyExternalValue(nextValue: string) {
		writeUncontrolledSearchInput(input, nextValue)
		sync = acknowledgeRecordTableSearchInput(nextValue)
	}

	return () => {
		const nextValue = handle.props.filters.query
		const reconciled = reconcileRecordTableSearchExternalValue(
			sync,
			nextValue,
			focused,
		)
		sync = reconciled.state
		if (reconciled.applyValue !== null) {
			applyExternalValue(reconciled.applyValue)
		}
		return (
			<input
				type="text"
				role="searchbox"
				inputMode="search"
				autoComplete="off"
				autoCorrect="off"
				spellCheck="false"
				name="q"
				data-testid="profile-repository-search"
				defaultValue={initialValue}
				placeholder="Search by name, description, or tags"
				mix={[
					css(inputCss),
					ref((node, signal) => {
						input = node as HTMLInputElement
						signal.addEventListener('abort', () => {
							if (input === node) input = null
						})
					}),
					on('focus', () => {
						focused = true
					}),
					on('input', (event) => {
						const value = (event.currentTarget as HTMLInputElement).value
						sync = acknowledgeRecordTableSearchInput(value)
						const href = buildProfileHref({
							username: handle.props.username,
							...handle.props.filters,
							query: value,
							extraSearchParams: new URL(window.location.href).searchParams,
						})
						const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`
						if (isProfilePackageFilterOnlyHrefChange(currentPath, href)) {
							replaceLocation(href)
							return
						}
						navigate(href, {
							replace: true,
							preventScrollReset: true,
						})
					}),
					on('blur', () => {
						focused = false
						if (sync.pendingExternalValue !== null) {
							applyExternalValue(sync.pendingExternalValue)
						}
					}),
				]}
			/>
		)
	}
}
