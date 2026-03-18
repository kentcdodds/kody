export type ScrollFades = {
	top: boolean
	bottom: boolean
}

export type ScrollAnchor = {
	scrollHeight: number
	scrollTop: number
}

export function getScrollFades(container: HTMLElement | null): ScrollFades {
	if (!container) {
		return { top: false, bottom: false }
	}

	const canScroll = container.scrollHeight > container.clientHeight + 1
	if (!canScroll) {
		return { top: false, bottom: false }
	}

	return {
		top: container.scrollTop > 1,
		bottom:
			container.scrollTop + container.clientHeight < container.scrollHeight - 1,
	}
}

export function isScrolledNearEdge(
	container: HTMLElement,
	input: {
		edge: 'top' | 'bottom'
		thresholdPx: number
	},
) {
	if (input.edge === 'top') {
		return container.scrollTop <= input.thresholdPx
	}

	return (
		container.scrollHeight - container.scrollTop - container.clientHeight <=
		input.thresholdPx
	)
}

export function captureScrollAnchor(container: HTMLElement): ScrollAnchor {
	return {
		scrollHeight: container.scrollHeight,
		scrollTop: container.scrollTop,
	}
}

export function restoreScrollAnchorAfterPrepend(
	container: HTMLElement,
	anchor: ScrollAnchor,
) {
	container.scrollTop =
		anchor.scrollTop + (container.scrollHeight - anchor.scrollHeight)
}

export function scrollToEdge(container: HTMLElement, edge: 'top' | 'bottom') {
	container.scrollTop = edge === 'top' ? 0 : container.scrollHeight
}
