export type ListDetailSelection = {
	selectedId: string | null
	isCreating: boolean
}

function appendSearch(pathname: string, search?: string) {
	return `${pathname}${search ?? ''}`
}

export function createListDetailRoute(basePath: string) {
	const newPath = `${basePath}/new`
	const detailPrefix = `${basePath}/`

	function isRoutePath(href: string) {
		const pathname = new URL(href, 'http://localhost').pathname
		return pathname === basePath || pathname.startsWith(detailPrefix)
	}

	function getSelection(href: string): ListDetailSelection {
		const pathname = new URL(href, 'http://localhost').pathname
		if (pathname === newPath) {
			return {
				selectedId: null,
				isCreating: true,
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
			selectedId: decodeURIComponent(segment),
			isCreating: false,
		}
	}

	function buildListHref(search = '') {
		return appendSearch(basePath, search)
	}

	function buildNewHref(search = '') {
		return appendSearch(newPath, search)
	}

	function buildDetailHref(id: string, search = '') {
		return appendSearch(`${basePath}/${encodeURIComponent(id)}`, search)
	}

	return {
		isRoutePath,
		getSelection,
		buildListHref,
		buildNewHref,
		buildDetailHref,
	}
}
