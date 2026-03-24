export const generatedUiShellResourceUri =
	'ui://generated-ui-shell/entry-point.html' as const

export function renderGeneratedUiShellEntryPoint(baseUrl: string | URL) {
	const stylesheetHref = new URL('/styles.css', baseUrl).toString()
	const widgetScriptHref = new URL(
		'/mcp-apps/generated-ui-shell.js',
		baseUrl,
	).toString()

	return `
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Generated UI Shell</title>
		<link rel="stylesheet" href="${stylesheetHref}" />
		<style>
			:root {
				color-scheme: light dark;
			}

			:root[data-theme='light'] {
				color-scheme: light;
			}

			:root[data-theme='dark'] {
				color-scheme: dark;
			}

			* {
				box-sizing: border-box;
			}

			body {
				margin: 0;
				padding: var(--spacing-md);
				font-family: var(--font-family);
				font-size: var(--font-size-base);
				color: var(--color-text);
				background: var(--color-background);
			}

			.generated-ui-shell {
				width: min(100%, 56rem);
				margin: 0 auto;
				display: grid;
				gap: var(--spacing-md);
			}

			.generated-ui-shell.fullscreen {
				width: 100%;
				max-width: none;
			}

			.generated-ui-card,
			.generated-ui-error,
			.generated-ui-loading {
				border: 1px solid var(--color-border);
				border-radius: var(--radius-lg);
				background: var(--color-surface);
				box-shadow: var(--shadow-sm);
				padding: var(--spacing-lg);
			}

			.generated-ui-card {
				display: grid;
				gap: var(--spacing-md);
			}

			.generated-ui-card h1,
			.generated-ui-error h1,
			.generated-ui-loading h1 {
				margin: 0;
				font-size: var(--font-size-lg);
				font-weight: var(--font-weight-semibold);
			}

			.generated-ui-card p,
			.generated-ui-error p,
			.generated-ui-loading p {
				margin: 0;
				color: var(--color-text-muted);
			}

			.generated-ui-actions {
				display: flex;
				flex-wrap: wrap;
				gap: var(--spacing-sm);
			}

			.generated-ui-button {
				border: 1px solid var(--color-border);
				border-radius: var(--radius-md);
				padding: var(--spacing-sm) var(--spacing-md);
				background: var(--color-background);
				color: var(--color-text);
				font-family: var(--font-family);
				font-size: var(--font-size-base);
				font-weight: var(--font-weight-medium);
				cursor: pointer;
			}

			.generated-ui-button.primary {
				background: var(--color-primary);
				border-color: transparent;
				color: var(--color-on-primary);
			}

			.generated-ui-button:focus-visible {
				outline: 2px solid var(--color-primary);
				outline-offset: 2px;
			}

			.generated-ui-button:disabled {
				opacity: 0.65;
				cursor: not-allowed;
			}

			.generated-ui-code {
				margin: 0;
				padding: var(--spacing-md);
				border: 1px solid var(--color-border);
				border-radius: var(--radius-md);
				background: color-mix(
					in srgb,
					var(--color-background) 78%,
					var(--color-surface)
				);
				font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
				font-size: var(--font-size-sm);
				white-space: pre-wrap;
				word-break: break-word;
			}

			.generated-ui-preview {
				display: grid;
				gap: var(--spacing-sm);
				padding: var(--spacing-md);
				border: 1px solid var(--color-border);
				border-radius: var(--radius-md);
				background: color-mix(
					in srgb,
					var(--color-surface) 92%,
					var(--color-background)
				);
			}

			.generated-ui-preview[data-tone='danger'] {
				border-color: color-mix(
					in srgb,
					var(--color-danger) 45%,
					var(--color-border)
				);
			}

			.generated-ui-list {
				margin: 0;
				padding-left: 1.25rem;
			}
		</style>
	</head>
	<body>
		<div class="generated-ui-shell" data-generated-ui-shell>
			<section class="generated-ui-card">
				<header class="generated-ui-preview">
					<h1 data-generated-ui-title>Generated UI</h1>
					<p data-generated-ui-description>
						This shell renders inline generated code or a saved app artifact.
					</p>
					<p data-generated-ui-status role="status">Waiting for render data from the host.</p>
					<p class="generated-ui-error" data-generated-ui-error hidden></p>
				</header>
				<div class="generated-ui-actions">
					<button
						class="generated-ui-button"
						data-action="toggle-fullscreen"
						type="button"
					>
						Toggle fullscreen
					</button>
					<button
						class="generated-ui-button primary"
						data-action="open-link"
						type="button"
					>
						Open saved app link
					</button>
				</div>
				<iframe
					data-generated-ui-frame
					title="Generated UI preview"
					style="width: 100%; min-height: 28rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-background);"
				></iframe>
			</section>
		</div>
		<script type="module" src="${widgetScriptHref}" crossorigin="anonymous"></script>
	</body>
</html>
`.trim()
}
