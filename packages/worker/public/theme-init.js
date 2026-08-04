/* oxlint-disable no-undef -- classic browser script served from public/;
   the lint config's browser env does not apply here. */
// Runs as a blocking classic script in <head> so the theme is applied before
// first paint (no flash) and enhance-only motion can gate on `html.js`.
// Inline scripts are blocked by CSP (`script-src 'self'`), hence this file.
;(function () {
	try {
		var stored = localStorage.getItem('kody-theme')
		var theme =
			stored ||
			(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
		document.documentElement.dataset.theme = theme
	} catch {
		/* blocked storage: CSS falls back to the system scheme */
	}
	document.documentElement.classList.add('js')

	// Follow system changes unless the user chose explicitly.
	try {
		var scheme = matchMedia('(prefers-color-scheme: dark)')
		scheme.addEventListener('change', function (event) {
			var stored = null
			try {
				stored = localStorage.getItem('kody-theme')
			} catch {
				/* ignore */
			}
			if (!stored) {
				document.documentElement.dataset.theme = event.matches
					? 'dark'
					: 'light'
			}
		})
	} catch {
		/* matchMedia unavailable: theme just won't track system changes */
	}

	// Smooth scrolling is for anchors clicked while you're already on the page.
	// Arriving at a #hash must land instantly, so opt in only after the
	// browser's initial jump has settled.
	addEventListener('load', function () {
		requestAnimationFrame(function () {
			document.documentElement.classList.add('is-settled')
		})
	})
})()
