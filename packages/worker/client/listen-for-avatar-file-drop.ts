import {
	eventHasFileDrag,
	isFileInputDropTarget,
	preventFileDropNavigation,
	readDroppedImageFile,
} from './file-drop-navigation.ts'

export function listenForAvatarFileDrop(input: {
	target?: Pick<Document, 'addEventListener' | 'removeEventListener'>
	signal: AbortSignal
	onDragActiveChange: (active: boolean) => void
	onImageFile: (file: File) => void
}): void {
	if (input.signal.aborted) return
	const target = input.target ?? document
	let dragDepth = 0
	let dragActive = false

	function setDragActive(next: boolean) {
		if (dragActive === next) return
		dragActive = next
		input.onDragActiveChange(next)
	}

	function handleDragEnter(event: Event) {
		if (!eventHasFileDrag(event as DragEvent)) return
		dragDepth += 1
		setDragActive(true)
	}

	function handleDragLeave(event: Event) {
		if (!eventHasFileDrag(event as DragEvent)) return
		dragDepth = Math.max(0, dragDepth - 1)
		if (dragDepth === 0) setDragActive(false)
	}

	function handleDragOver(event: Event) {
		preventFileDropNavigation(event as DragEvent)
	}

	function handleDrop(event: Event) {
		const dragEvent = event as DragEvent
		dragDepth = 0
		setDragActive(false)
		if (isFileInputDropTarget(dragEvent.target)) return
		if (!preventFileDropNavigation(dragEvent)) return
		const file = readDroppedImageFile(dragEvent.dataTransfer)
		if (!file) return
		input.onImageFile(file)
	}

	target.addEventListener('dragenter', handleDragEnter)
	target.addEventListener('dragleave', handleDragLeave)
	target.addEventListener('dragover', handleDragOver)
	target.addEventListener('drop', handleDrop)
	input.signal.addEventListener(
		'abort',
		() => {
			target.removeEventListener('dragenter', handleDragEnter)
			target.removeEventListener('dragleave', handleDragLeave)
			target.removeEventListener('dragover', handleDragOver)
			target.removeEventListener('drop', handleDrop)
		},
		{ once: true },
	)
}
