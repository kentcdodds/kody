import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { colors, transitions } from '#universal/styles/tokens.ts'

const THEME_STORAGE_KEY = 'kody-theme'

function readTheme(): 'light' | 'dark' {
	if (typeof document === 'undefined') return 'light'
	return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/**
 * Round theme toggle from the heykody.dev redesign. The pre-paint script
 * (`public/theme-init.js`) sets `documentElement.dataset.theme` before first
 * paint; this button flips it and persists the explicit choice to
 * `localStorage('kody-theme')`. Which icon shows is pure CSS on
 * `:root[data-theme]` (see `.icon-sun` / `.icon-moon` in public/styles.css),
 * so the server-rendered markup needs no theme knowledge.
 */
export function ThemeToggle(handle: Handle) {
	let pressed = readTheme() === 'dark'

	function syncPressed() {
		const next = readTheme() === 'dark'
		if (next === pressed) return
		pressed = next
		handle.update()
	}

	if (typeof document !== 'undefined') {
		// Sync aria-pressed after hydration in case SSR guessed wrong.
		handle.queueTask(syncPressed)

		// `data-theme` has writers other than this button: `theme-init.js`
		// follows the system scheme whenever no explicit choice is stored, so a
		// mounted toggle would otherwise keep announcing a stale state. Watching
		// the attribute covers every writer without a signalling protocol
		// between them.
		const observer = new MutationObserver(syncPressed)
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme'],
		})
		handle.signal.addEventListener('abort', () => observer.disconnect())
	}

	function toggleTheme() {
		const next = readTheme() === 'dark' ? 'light' : 'dark'
		document.documentElement.dataset.theme = next
		try {
			localStorage.setItem(THEME_STORAGE_KEY, next)
		} catch {
			/* fine, theme just won't persist */
		}
		pressed = next === 'dark'
		handle.update()
	}

	return () => (
		<button
			type="button"
			aria-label="Dark mode"
			aria-pressed={pressed ? 'true' : 'false'}
			mix={[css(toggleCss), on('click', toggleTheme)]}
		>
			<svg
				class="icon-sun"
				viewBox="0 0 24 24"
				width="18"
				height="18"
				aria-hidden="true"
			>
				<circle
					cx="12"
					cy="12"
					r="4.5"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
				/>
				<path
					d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2.1 2.1M16.9 16.9L19 19M19 5l-2.1 2.1M7.1 16.9L5 19"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
				/>
			</svg>
			<svg
				class="icon-moon"
				viewBox="0 0 24 24"
				width="18"
				height="18"
				aria-hidden="true"
			>
				<path
					d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linejoin="round"
				/>
			</svg>
		</button>
	)
}

const toggleCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '44px',
	height: '44px',
	borderRadius: '50%',
	border: `1.5px solid ${colors.border}`,
	background: 'transparent',
	color: colors.textMuted,
	cursor: 'pointer',
	// Independent `rotate`/`scale` properties (not `transform`) so the hover
	// tilt and the press squish compose instead of overwriting each other.
	transition: `color ${transitions.fast}, border-color ${transitions.fast}, rotate ${transitions.normal}, scale ${transitions.fast}`,
	'&:active': {
		scale: '0.92',
	},
	'@media (hover: hover) and (pointer: fine)': {
		'&:hover': {
			color: colors.text,
			borderColor: colors.textMuted,
			rotate: '15deg',
		},
	},
	'@media (prefers-reduced-motion: reduce)': {
		transition: `color ${transitions.fast}, border-color ${transitions.fast}`,
		'&:hover': { rotate: 'none' },
		'&:active': { scale: 'none' },
	},
}
