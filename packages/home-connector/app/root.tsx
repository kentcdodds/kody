import { html } from 'remix/html-template'

export function RootLayout(input: {
	title: string
	body: ReturnType<typeof html>
}) {
	return html`<html lang="en">
		<head>
			<meta charset="utf-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1" />
			<title>${input.title}</title>
			<style>
				body {
					font-family:
						Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
						"Segoe UI", sans-serif;
					background: #0f172a;
					color: #e2e8f0;
					margin: 0;
					padding: 24px;
				}

				main {
					max-width: 960px;
					margin: 0 auto;
				}

				h1,
				h2 {
					color: #f8fafc;
				}

				a {
					color: #93c5fd;
				}

				code,
				pre {
					font-family:
						ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, Monaco, Consolas,
						"Liberation Mono", "Courier New", monospace;
				}

				.card {
					background: #111827;
					border: 1px solid #334155;
					border-radius: 12px;
					padding: 16px;
					margin-bottom: 16px;
				}

				.status-grid {
					display: grid;
					grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
					gap: 16px;
				}

				.muted {
					color: #94a3b8;
				}

				.list {
					padding-left: 20px;
				}
			</style>
		</head>
		<body>
			<main>${input.body}</main>
		</body>
	</html>`
}
