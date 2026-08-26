export type ToastTone = 'info' | 'success' | 'error'

export type ToastAction = {
	label: string
	onClick: () => void
}

export type ShowToastOptions = {
	id?: string
	description?: string
	tone?: ToastTone
	/**
	 * Auto-dismiss delay in milliseconds. `null` or `Infinity` keeps the toast
	 * until the user dismisses it (or `toast.dismiss` runs).
	 */
	duration?: number | null
	dismissible?: boolean
	action?: ToastAction
}

export type ToastRecord = {
	id: string
	message: string
	description?: string
	tone: ToastTone
	duration: number | null
	dismissible: boolean
	action?: ToastAction
}

export const defaultToastDurationMs = {
	info: 4_000,
	success: 4_000,
	error: null,
} as const

let nextToastId = 0

function createToastId() {
	if (
		typeof crypto !== 'undefined' &&
		typeof crypto.randomUUID === 'function'
	) {
		return crypto.randomUUID()
	}
	nextToastId += 1
	return `toast-${nextToastId}`
}

function resolveDuration(
	tone: ToastTone,
	duration: number | null | undefined,
): number | null {
	if (duration === undefined) return defaultToastDurationMs[tone]
	if (duration === Infinity) return null
	if (typeof duration === 'number' && duration <= 0) return null
	return duration
}

export function createToastStore() {
	let items: Array<ToastRecord> = []
	const timers = new Map<string, ReturnType<typeof setTimeout>>()
	const listeners = new Set<() => void>()

	function emit() {
		for (const listener of listeners) listener()
	}

	function clearTimer(id: string) {
		const timer = timers.get(id)
		if (timer === undefined) return
		clearTimeout(timer)
		timers.delete(id)
	}

	function subscribe(listener: () => void) {
		listeners.add(listener)
		return () => {
			listeners.delete(listener)
		}
	}

	function list() {
		return items
	}

	function dismiss(id?: string) {
		if (id === undefined) {
			if (items.length === 0) return
			for (const item of items) clearTimer(item.id)
			items = []
			emit()
			return
		}
		clearTimer(id)
		const next = items.filter((item) => item.id !== id)
		if (next.length === items.length) return
		items = next
		emit()
	}

	function show(message: string, options: ShowToastOptions = {}) {
		const tone = options.tone ?? 'info'
		const duration = resolveDuration(tone, options.duration)
		const id = options.id ?? createToastId()
		const record: ToastRecord = {
			id,
			message,
			tone,
			duration,
			dismissible: options.dismissible ?? true,
		}
		if (options.description) record.description = options.description
		if (options.action) record.action = options.action
		items = [...items.filter((item) => item.id !== id), record]
		clearTimer(id)
		if (duration !== null) {
			timers.set(
				id,
				setTimeout(() => {
					dismiss(id)
				}, duration),
			)
		}
		emit()
		return id
	}

	return { subscribe, list, show, dismiss }
}

const toastStore = createToastStore()

function showToast(message: string, options?: ShowToastOptions) {
	return toastStore.show(message, options)
}

export const toast = Object.assign(showToast, {
	info(message: string, options?: Omit<ShowToastOptions, 'tone'>) {
		return toastStore.show(message, { ...options, tone: 'info' })
	},
	success(message: string, options?: Omit<ShowToastOptions, 'tone'>) {
		return toastStore.show(message, { ...options, tone: 'success' })
	},
	error(message: string, options?: Omit<ShowToastOptions, 'tone'>) {
		return toastStore.show(message, { ...options, tone: 'error' })
	},
	dismiss: toastStore.dismiss,
})

export function subscribeToasts(listener: () => void) {
	return toastStore.subscribe(listener)
}

export function listToasts() {
	return toastStore.list()
}
