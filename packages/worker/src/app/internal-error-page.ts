import { html } from 'remix/html-template'
import { render } from '#app/render.ts'

/**
 * Minimal first-party HTML for uncaught handler failures. The catch that
 * calls this may have come from rendering the app shell, so this document
 * is static: no client entry, no inline scripts.
 */
export function renderInternalServerErrorPage() {
	return render(
		html`<!doctype html>
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<link rel="icon" href="/favicon.ico" sizes="any" />
					<title>Something went wrong — kody</title>
					<link rel="stylesheet" href="/styles.css" />
				</head>
				<body>
					<main>
						<h1>Something went wrong</h1>
						<p>The server hit an unexpected error. Please try again.</p>
						<p><a href="/">Go home</a></p>
					</main>
				</body>
			</html>`,
		{ status: 500 },
	)
}
