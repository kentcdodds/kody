export async function writeClipboardText(value: string) {
	if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(value)
			return
		} catch {
			// Fall through to execCommand when the async clipboard API rejects.
		}
	}

	if (typeof document === 'undefined') {
		throw new Error('Clipboard is unavailable.')
	}

	const textArea = document.createElement('textarea')
	textArea.value = value
	textArea.setAttribute('readonly', '')
	textArea.style.position = 'fixed'
	textArea.style.opacity = '0'
	document.body.append(textArea)
	textArea.select()
	try {
		if (
			typeof document.execCommand === 'function' &&
			document.execCommand('copy')
		) {
			return
		}
	} finally {
		textArea.remove()
	}

	throw new Error('Clipboard is unavailable.')
}
