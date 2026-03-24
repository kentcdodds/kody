import { html } from 'remix/html-template'

const styles = `
	:root {
		color-scheme: light dark;

		/* Colors - Light mode (blue and gray) */
		--color-primary: #2563eb;
		--color-primary-hover: #1d4ed8;
		--color-primary-active: #1e40af;
		--color-on-primary: #ffffff;
		--color-primary-text: #1e40af;
		--color-background: #f8fafc;
		--color-surface: #f1f5f9;
		--color-text: #0f172a;
		--color-text-muted: #64748b;
		--color-border: #cbd5e1;
		--color-danger: #dc2626;
		--color-danger-hover: #b91c1c;
		--color-on-danger: #ffffff;

		/* Colors - Dark mode (blue and gray) */
		--color-primary-dark: #3b82f6;
		--color-primary-hover-dark: #60a5fa;
		--color-primary-active-dark: #93c5fd;
		--color-on-primary-dark: #0f172a;
		--color-primary-text-dark: #60a5fa;
		--color-background-dark: #0f172a;
		--color-surface-dark: #1e293b;
		--color-text-dark: #f8fafc;
		--color-text-muted-dark: #94a3b8;
		--color-border-dark: #334155;
		--color-danger-dark: #f87171;
		--color-danger-hover-dark: #ef4444;
		--color-on-danger-dark: #450a0a;

		/* Typography */
		--font-family: system-ui, sans-serif;
		--font-size-xs: 0.75rem;
		--font-size-sm: 0.875rem;
		--font-size-base: 1rem;
		--font-size-lg: 1.25rem;
		--font-size-xl: 2rem;
		--font-size-2xl: 3rem;
		--font-weight-normal: 400;
		--font-weight-medium: 500;
		--font-weight-semibold: 600;
		--font-weight-bold: 700;

		/* Spacing */
		--spacing-xs: 0.25rem;
		--spacing-sm: 0.5rem;
		--spacing-md: 1rem;
		--spacing-lg: 1.5rem;
		--spacing-xl: 2rem;
		--spacing-2xl: 3rem;

		/* Border radius */
		--radius-sm: 0.25rem;
		--radius-md: 0.5rem;
		--radius-lg: 0.75rem;
		--radius-xl: 1rem;
		--radius-full: 999px;

		/* Shadows */
		--shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
		--shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1),
			0 2px 4px -2px rgb(0 0 0 / 0.1);
		--shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1),
			0 4px 6px -4px rgb(0 0 0 / 0.1);
		--shadow-sm-dark: 0 1px 2px 0 rgb(255 255 255 / 0.05);
		--shadow-md-dark: 0 4px 6px -1px rgb(255 255 255 / 0.08),
			0 2px 4px -2px rgb(255 255 255 / 0.08);
		--shadow-lg-dark: 0 10px 15px -3px rgb(255 255 255 / 0.1),
			0 4px 6px -4px rgb(255 255 255 / 0.1);

		/* Transitions */
		--transition-fast: 0.15s ease;
		--transition-normal: 0.2s ease;

		/* Responsive spacing - used for page-level padding */
		--spacing-page: var(--spacing-2xl);
		--spacing-section: var(--spacing-xl);
		--spacing-header: var(--spacing-xl);
	}

	@media (max-width: 1024px) {
		:root {
			--spacing-page: var(--spacing-xl);
			--spacing-section: var(--spacing-lg);
			--spacing-header: var(--spacing-lg);
		}
	}

	@media (max-width: 640px) {
		:root {
			--spacing-page: var(--spacing-md);
			--spacing-section: var(--spacing-md);
			--spacing-header: var(--spacing-md);
			--font-size-xl: 1.5rem;
			--font-size-2xl: 2rem;
		}
	}

	@media (prefers-color-scheme: dark) {
		:root {
			--color-primary: var(--color-primary-dark);
			--color-primary-hover: var(--color-primary-hover-dark);
			--color-primary-active: var(--color-primary-active-dark);
			--color-on-primary: var(--color-on-primary-dark);
			--color-primary-text: var(--color-primary-text-dark);
			--color-background: var(--color-background-dark);
			--color-surface: var(--color-surface-dark);
			--color-text: var(--color-text-dark);
			--color-text-muted: var(--color-text-muted-dark);
			--color-border: var(--color-border-dark);
			--color-danger: var(--color-danger-dark);
			--color-danger-hover: var(--color-danger-hover-dark);
			--color-on-danger: var(--color-on-danger-dark);
			--shadow-sm: var(--shadow-sm-dark);
			--shadow-md: var(--shadow-md-dark);
			--shadow-lg: var(--shadow-lg-dark);
		}
	}

	*,
	*::before,
	*::after {
		box-sizing: border-box;
	}

	html {
		background: var(--color-background);
	}

	body {
		margin: 0;
		min-height: 100vh;
		padding: var(--spacing-page);
		font-family: var(--font-family);
		font-size: var(--font-size-base);
		line-height: 1.5;
		color: var(--color-text);
		background: var(--color-background);
		transition:
			background-color var(--transition-normal),
			color var(--transition-normal);
	}

	main {
		width: min(100%, 60rem);
		margin: 0 auto;
		display: grid;
		gap: var(--spacing-lg);
	}

	h1,
	h2 {
		margin: 0;
		color: var(--color-text);
		line-height: 1.2;
	}

	h1 {
		font-size: var(--font-size-xl);
	}

	h2 {
		font-size: var(--font-size-lg);
	}

	p,
	ul {
		margin: 0;
	}

	a {
		color: var(--color-primary);
		text-decoration-color: color-mix(in srgb, var(--color-primary) 45%, transparent);
	}

	a:hover {
		color: var(--color-primary-hover);
	}

	code,
	pre {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
			"Liberation Mono", "Courier New", monospace;
	}

	code {
		padding: 0.125rem 0.375rem;
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
		background: color-mix(in srgb, var(--color-surface) 82%, transparent);
	}

	.app-shell,
	.stack {
		display: grid;
		gap: var(--spacing-lg);
	}

	.page-header {
		display: grid;
		gap: var(--spacing-sm);
	}

	.card {
		display: grid;
		gap: var(--spacing-md);
		align-content: start;
		padding: var(--spacing-lg);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-md);
	}

	.status-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
		gap: var(--spacing-md);
		align-items: start;
	}

	.status-grid > *,
	.card > * {
		min-width: 0;
	}

	.info-list {
		display: grid;
		gap: var(--spacing-md);
	}

	.info-row {
		display: grid;
		gap: var(--spacing-xs);
	}

	.info-label {
		font-weight: var(--font-weight-bold);
	}

	.info-value {
		min-width: 0;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.info-value code {
		white-space: normal;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.list {
		padding-left: 1.25rem;
	}

	.list li + li {
		margin-top: var(--spacing-sm);
	}

	.muted {
		color: var(--color-text-muted);
	}
`

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
				${styles}
			</style>
		</head>
		<body>
			<main>${input.body}</main>
		</body>
	</html>`
}
