import { expect, test, vi } from 'vitest'
import {
	eventHasFileDrag,
	installFileDropNavigationGuard,
	isFileInputDropTarget,
	isLikelyImageFile,
	preventFileDropNavigation,
	readDroppedImageFile,
} from './file-drop-navigation.ts'
import { listenForAvatarFileDrop } from './listen-for-avatar-file-drop.ts'

function createDragEvent(input: {
	type: string
	types?: Array<string>
	files?: Array<File>
	target?: EventTarget | null
	dropEffect?: string
}): DragEvent {
	const dataTransfer = {
		types: input.types ?? [],
		files: input.files ?? [],
		dropEffect: input.dropEffect ?? 'none',
	}
	return {
		type: input.type,
		dataTransfer,
		target: input.target ?? null,
		preventDefault: vi.fn(),
	} as unknown as DragEvent
}

function createFileInputTarget(): EventTarget {
	return {
		tagName: 'INPUT',
		type: 'file',
		closest: (selector: string) =>
			selector === 'input[type="file"]' ? createFileInputTarget() : null,
	} as unknown as EventTarget
}

test('file-drop helpers keep the page from navigating and route images to avatar upload', () => {
	expect(
		eventHasFileDrag(
			createDragEvent({ type: 'dragover', types: ['text/plain'] }),
		),
	).toBe(false)
	expect(
		eventHasFileDrag(createDragEvent({ type: 'dragover', types: ['Files'] })),
	).toBe(true)
	expect(
		eventHasFileDrag(
			createDragEvent({
				type: 'dragover',
				types: ['application/x-moz-file'],
			}),
		),
	).toBe(true)

	const textDrag = createDragEvent({
		type: 'drop',
		types: ['text/plain'],
	})
	expect(preventFileDropNavigation(textDrag)).toBe(false)
	expect(textDrag.preventDefault).not.toHaveBeenCalled()

	const pageDrop = createDragEvent({
		type: 'drop',
		types: ['Files'],
		target: { tagName: 'DIV', closest: () => null } as unknown as EventTarget,
	})
	expect(preventFileDropNavigation(pageDrop)).toBe(true)
	expect(pageDrop.preventDefault).toHaveBeenCalledOnce()

	const fileInputDrop = createDragEvent({
		type: 'drop',
		types: ['Files'],
		target: createFileInputTarget(),
	})
	expect(isFileInputDropTarget(fileInputDrop.target)).toBe(true)
	expect(preventFileDropNavigation(fileInputDrop)).toBe(false)
	expect(fileInputDrop.preventDefault).not.toHaveBeenCalled()

	const labeledInput = {
		tagName: 'INPUT',
		type: 'file',
	}
	const labelTarget = {
		tagName: 'SPAN',
		closest: (selector: string) => (selector === 'label' ? labelTarget : null),
		control: labeledInput,
		querySelector: () => labeledInput,
	} as unknown as EventTarget
	expect(isFileInputDropTarget(labelTarget)).toBe(false)
	const labelDrop = createDragEvent({
		type: 'drop',
		types: ['Files'],
		target: labelTarget,
	})
	expect(preventFileDropNavigation(labelDrop)).toBe(true)
	expect(labelDrop.preventDefault).toHaveBeenCalledOnce()

	const photo = new File([Uint8Array.from([1, 2, 3])], 'photo.heic', {
		type: '',
	})
	const notes = new File(['todo'], 'notes.txt', { type: 'text/plain' })
	expect(isLikelyImageFile(photo)).toBe(true)
	expect(isLikelyImageFile(notes)).toBe(false)
	expect(
		readDroppedImageFile({
			files: [notes, photo],
		} as unknown as DataTransfer),
	).toBe(photo)

	const listeners = new Map<string, (event: Event) => void>()
	const target = {
		addEventListener: vi.fn(
			(type: string, listener: (event: Event) => void) => {
				listeners.set(type, listener)
			},
		),
		removeEventListener: vi.fn(),
	}
	const stop = installFileDropNavigationGuard(target)
	expect(listeners.has('dragover')).toBe(true)
	expect(listeners.has('drop')).toBe(true)
	const guardedDrop = createDragEvent({
		type: 'drop',
		types: ['Files'],
		target: { tagName: 'MAIN', closest: () => null } as unknown as EventTarget,
	})
	listeners.get('drop')?.(guardedDrop)
	expect(guardedDrop.preventDefault).toHaveBeenCalledOnce()
	stop()
	expect(target.removeEventListener).toHaveBeenCalledTimes(2)

	const controller = new AbortController()
	const received: Array<File> = []
	const dragStates: Array<boolean> = []
	const avatarListeners = new Map<string, (event: Event) => void>()
	listenForAvatarFileDrop({
		target: {
			addEventListener: (type, listener) => {
				avatarListeners.set(type, listener as (event: Event) => void)
			},
			removeEventListener: vi.fn(),
		},
		signal: controller.signal,
		onDragActiveChange: (active) => {
			dragStates.push(active)
		},
		onImageFile: (file) => {
			received.push(file)
		},
	})

	const enter = createDragEvent({ type: 'dragenter', types: ['Files'] })
	avatarListeners.get('dragenter')?.(enter)
	avatarListeners.get('dragenter')?.(enter)
	expect(dragStates).toEqual([true])
	avatarListeners.get('dragleave')?.(enter)
	expect(dragStates).toEqual([true])
	avatarListeners.get('dragleave')?.(enter)
	expect(dragStates).toEqual([true, false])

	const droppedPhoto = new File([Uint8Array.from([9])], 'face.avif', {
		type: 'image/avif',
	})
	const avatarDrop = createDragEvent({
		type: 'drop',
		types: ['Files'],
		files: [droppedPhoto],
		target: { tagName: 'MAIN', closest: () => null } as unknown as EventTarget,
	})
	avatarListeners.get('drop')?.(avatarDrop)
	expect(avatarDrop.preventDefault).toHaveBeenCalledOnce()
	expect(received).toEqual([droppedPhoto])
	expect(dragStates.at(-1)).toBe(false)

	const ignoredInputDrop = createDragEvent({
		type: 'drop',
		types: ['Files'],
		files: [droppedPhoto],
		target: createFileInputTarget(),
	})
	avatarListeners.get('drop')?.(ignoredInputDrop)
	expect(received).toHaveLength(1)

	const labeledAvatarDrop = createDragEvent({
		type: 'drop',
		types: ['Files'],
		files: [droppedPhoto],
		target: labelTarget,
	})
	avatarListeners.get('drop')?.(labeledAvatarDrop)
	expect(labeledAvatarDrop.preventDefault).toHaveBeenCalledOnce()
	expect(received).toEqual([droppedPhoto, droppedPhoto])
})
