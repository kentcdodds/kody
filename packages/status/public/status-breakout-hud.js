/* oxlint-disable no-undef -- browser module served from public/; the lint
   config's browser env does not apply here. */

/**
 * Game chrome in the DOM (not the canvas) so buttons stay real, focusable
 * controls and the live status line is announced to screen readers.
 * @param {{ onQuit: () => void }} options
 */
export function createHud({ onQuit }) {
	const bar = createElement('div', 'breakout-hud')
	const quit = createElement('button', '', 'Quit (Esc)')
	quit.addEventListener('click', onQuit)
	const score = createElement('span', '')
	const balls = createElement('span', '')
	const live = createElement('span', 'breakout-live', 'Kody: checking status')
	live.setAttribute('role', 'status')
	bar.append(quit, score, balls, live)
	const panel = createElement('div', 'breakout-panel')
	panel.hidden = true
	const toast = createElement('div', 'breakout-toast')
	toast.hidden = true
	document.body.append(bar, panel, toast)

	return {
		/** Viewport y where the HUD starts; it wraps to two lines on phones. */
		top() {
			return bar.getBoundingClientRect().top
		},
		/** @param {number} value */
		setScore(value) {
			setText(score, `Score ${value.toLocaleString()}`)
		},
		/** @param {number} value */
		setLives(value) {
			setText(balls, `Balls ${'●'.repeat(Math.max(0, value))}`)
		},
		/** @param {string} status @param {Date} checkedAt */
		setLiveStatus(status, checkedAt) {
			const checked = checkedAt.toLocaleTimeString([], {
				hour: 'numeric',
				minute: '2-digit',
			})
			setText(live, `${liveStatusLabel(status)} · checked ${checked}`)
		},
		/**
		 * @param {string} title
		 * @param {string} detail
		 * @param {{ onPlayAgain: () => void }} actions
		 */
		showPanel(title, detail, { onPlayAgain }) {
			const again = createElement('button', 'breakout-primary', 'Play again')
			again.addEventListener('click', () => {
				panel.hidden = true
				onPlayAgain()
			})
			const back = createElement('button', '', 'Back to status')
			back.addEventListener('click', onQuit)
			const actions = createElement('div', 'breakout-actions')
			actions.append(again, back)
			panel.replaceChildren(
				createElement('h2', '', title),
				createElement('p', '', detail),
				actions,
			)
			panel.hidden = false
			again.focus()
		},
		showRecovered() {
			const back = createElement('button', '', 'Back to status')
			back.addEventListener('click', onQuit)
			const keep = createElement('button', '', 'Keep playing')
			keep.addEventListener('click', () => {
				toast.hidden = true
			})
			toast.replaceChildren(
				createElement('span', '', 'Kody is back. All systems operational.'),
				back,
				keep,
			)
			toast.hidden = false
		},
		hideRecovered() {
			toast.hidden = true
		},
	}
}

/** @param {string} status */
function liveStatusLabel(status) {
	switch (status) {
		case 'operational':
			return 'Kody: all systems operational'
		case 'down':
			return 'Kody: still restoring'
		case 'unreachable':
			return 'Kody: status check failed, retrying'
		default:
			return 'Kody: status unknown'
	}
}

/**
 * @template {keyof HTMLElementTagNameMap} Tag
 * @param {Tag} tag
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLElementTagNameMap[Tag]}
 */
function createElement(tag, className, text) {
	const element = document.createElement(tag)
	if (className) element.className = className
	if (text) element.textContent = text
	if (element instanceof HTMLButtonElement) element.type = 'button'
	return element
}

/** @param {HTMLElement} element @param {string} text */
function setText(element, text) {
	if (element.textContent !== text) element.textContent = text
}
