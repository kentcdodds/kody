/**
 * File drags onto a page otherwise navigate the browser to that file. Guard
 * dragover/drop so the app stays put, while native file inputs still receive
 * their own drops.
 */

export function eventHasFileDrag(
	event: Pick<DragEvent, 'dataTransfer'>,
): boolean {
	const types = event.dataTransfer?.types
	if (!types) return false
	return (
		Array.from(types).includes('Files') ||
		Array.from(types).includes('application/x-moz-file')
	)
}

type ClosestElement = {
	tagName?: string
	type?: string
	control?: EventTarget | null
	closest?: (selector: string) => EventTarget | null
	querySelector?: (selector: string) => EventTarget | null
}

export function isFileInputDropTarget(target: EventTarget | null): boolean {
	const element = asClosestElement(target)
	if (!element) return false
	if (isFileInputElement(element)) return true
	if (isFileInputElement(element.closest?.('input[type="file"]') ?? null)) {
		return true
	}
	const label = asClosestElement(element.closest?.('label') ?? null)
	if (!label) return false
	if (isFileInputElement(label.control ?? null)) return true
	return isFileInputElement(label.querySelector?.('input[type="file"]') ?? null)
}

function asClosestElement(target: unknown): ClosestElement | null {
	if (target == null || typeof target !== 'object') return null
	return target as ClosestElement
}

function isFileInputElement(target: unknown): boolean {
	const element = asClosestElement(target)
	return element?.tagName === 'INPUT' && element.type === 'file'
}

export function isLikelyImageFile(file: File): boolean {
	if (file.type.startsWith('image/')) return true
	return /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|tif{1,2}|webp)$/i.test(
		file.name,
	)
}

export function readDroppedImageFile(
	dataTransfer: DataTransfer | null,
): File | null {
	return Array.from(dataTransfer?.files ?? []).find(isLikelyImageFile) ?? null
}

export function preventFileDropNavigation(event: DragEvent): boolean {
	if (!eventHasFileDrag(event)) return false
	if (event.type === 'drop' && isFileInputDropTarget(event.target)) {
		return false
	}
	event.preventDefault()
	if (event.type === 'dragover' && event.dataTransfer) {
		event.dataTransfer.dropEffect = 'copy'
	}
	return true
}

export function installFileDropNavigationGuard(
	target: Pick<Document, 'addEventListener' | 'removeEventListener'> = document,
): () => void {
	const handleDragEvent = (event: Event) => {
		preventFileDropNavigation(event as DragEvent)
	}
	target.addEventListener('dragover', handleDragEvent)
	target.addEventListener('drop', handleDragEvent)
	return () => {
		target.removeEventListener('dragover', handleDragEvent)
		target.removeEventListener('drop', handleDragEvent)
	}
}
