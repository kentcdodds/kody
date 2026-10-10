import { createHref } from 'remix/route-pattern/href'
import { accountAliasPath, relocateAccountHref } from '#universal/org-pages.ts'

function decodePathSegment(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		// Malformed percent-encoding (e.g. a literal `%`) must not throw;
		// the raw segment simply won't match any entity id.
		return value
	}
}

export type ListDetailSelection = {
	selectedId: string | null
	isCreating: boolean
}

type ListDetailRouteOptions = {
	parseDetailId?: (pathname: string) => string | null
}

function appendSearch(pathname: string, search?: string) {
	return `${pathname}${search ?? ''}`
}

export function createListDetailRoute(
	basePath: string,
	options: ListDetailRouteOptions = {},
) {
	const newPath = `${basePath}/new`
	const detailPrefix = `${basePath}/`

	function isRoutePath(href: string) {
		const pathname = accountAliasPath(
			new URL(href, 'http://localhost').pathname,
		)
		return pathname === basePath || pathname.startsWith(detailPrefix)
	}

	function getSelection(href: string): ListDetailSelection {
		const pathname = accountAliasPath(
			new URL(href, 'http://localhost').pathname,
		)
		if (pathname === newPath) {
			return {
				selectedId: null,
				isCreating: true,
			}
		}
		if (options.parseDetailId) {
			return {
				selectedId: options.parseDetailId(pathname),
				isCreating: false,
			}
		}
		if (!pathname.startsWith(detailPrefix)) {
			return {
				selectedId: null,
				isCreating: false,
			}
		}
		const segment = pathname.slice(detailPrefix.length)
		if (!segment || segment.includes('/')) {
			return {
				selectedId: null,
				isCreating: false,
			}
		}
		return {
			selectedId: decodePathSegment(segment),
			isCreating: false,
		}
	}

	function publish(path: string, currentHref?: string) {
		if (!currentHref) return path
		return relocateAccountHref(path, currentHref)
	}

	function buildListHref(search = '', currentHref?: string) {
		return publish(appendSearch(basePath, search), currentHref)
	}

	function buildNewHref(search = '', currentHref?: string) {
		return publish(appendSearch(newPath, search), currentHref)
	}

	function buildDetailHref(id: string, search = '', currentHref?: string) {
		// Remix treats `.` as a route delimiter, so `encodeURIComponent` is not
		// enough. `createHref` percent-encodes dots (`%2E`) the same way
		// `routes.*.href()` does for named routes.
		return publish(
			appendSearch(createHref(`${basePath}/:id`, { id }), search),
			currentHref,
		)
	}

	return {
		isRoutePath,
		getSelection,
		buildListHref,
		buildNewHref,
		buildDetailHref,
	}
}
