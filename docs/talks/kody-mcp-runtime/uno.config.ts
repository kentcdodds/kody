import { defineConfig } from 'unocss'

/**
 * Extends Slidev’s Uno stack (merged after the built-in config). Overrides
 * `bg-main` so slides aren’t flat white / flat gray-black.
 */
export default defineConfig({
	shortcuts: {
		'bg-main':
			'bg-gradient-to-br from-teal-50 via-white to-cyan-100 dark:(bg-gradient-to-br from-[#071a18] via-[#0f1715] to-[#0a1210])',
	},
})
