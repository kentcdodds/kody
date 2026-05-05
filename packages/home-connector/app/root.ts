import { html } from 'remix/html-template'
import { routes } from './routes.ts'

type NavigationItem = {
	href: string
	label: string
	description: string
	matchPaths?: Array<string>
}

const navigationSections: Array<{
	label: string
	items: Array<NavigationItem>
}> = [
	{
		label: 'Overview',
		items: [
			{
				href: routes.home.pattern,
				label: 'Dashboard',
				description: 'Health, counts, and quick actions',
			},
			{
				href: routes.systemStatus.pattern,
				label: 'System status',
				description: 'Connection, endpoints, config, and inventory',
			},
			{
				href: routes.diagnostics.pattern,
				label: 'Diagnostics',
				description: 'Discovery recency, warnings, and drill-downs',
			},
			{
				href: routes.islandRouterStatus.pattern,
				label: 'Island router',
				description: 'SSH readiness, interfaces, neighbors, and host diagnosis',
			},
			{
				href: routes.islandRouterApiStatus.pattern,
				label: 'Island Router API',
				description: 'HTTP API PIN storage and proxy readiness',
				matchPaths: [routes.islandRouterApiSetup.pattern],
			},
			{
				href: routes.health.pattern,
				label: 'Health JSON',
				description: 'Machine-readable local health endpoint',
			},
		],
	},
	{
		label: 'Integrations',
		items: [
			{
				href: routes.rokuStatus.pattern,
				label: 'Roku',
				description: 'Devices and discovery',
				matchPaths: [routes.rokuSetup.pattern],
			},
			{
				href: routes.lutronStatus.pattern,
				label: 'Lutron',
				description: 'Processors and credentials',
				matchPaths: [routes.lutronSetup.pattern],
			},
			{
				href: routes.accessNetworksUnleashedStatus.pattern,
				label: 'Access Networks Unleashed',
				description: 'Controller discovery and auth information',
				matchPaths: [routes.accessNetworksUnleashedSetup.pattern],
			},
			{
				href: routes.sonosStatus.pattern,
				label: 'Sonos',
				description: 'Players and groups',
				matchPaths: [routes.sonosSetup.pattern],
			},
			{
				href: routes.samsungTvStatus.pattern,
				label: 'Samsung TV',
				description: 'Discovery and pairing',
				matchPaths: [routes.samsungTvSetup.pattern],
			},
			{
				href: routes.bondStatus.pattern,
				label: 'Bond',
				description: 'Bridge state and token setup',
				matchPaths: [routes.bondSetup.pattern],
			},
			{
				href: routes.jellyfishStatus.pattern,
				label: 'JellyFish',
				description: 'Controllers, patterns, and zones',
				matchPaths: [routes.jellyfishSetup.pattern],
			},
			{
				href: routes.venstarStatus.pattern,
				label: 'Venstar',
				description: 'Managed thermostats and LAN scans',
				matchPaths: [routes.venstarSetup.pattern],
			},
		],
	},
]

function isNavigationItemActive(
	item: NavigationItem,
	currentPath: string | undefined,
) {
	if (!currentPath) return false
	return [item.href, ...(item.matchPaths ?? [])].includes(currentPath)
}

function renderNavigation(currentPath: string | undefined) {
	return html`${navigationSections.map(
		(section) => html`<section class="nav-section">
			<div class="nav-section-title">${section.label}</div>
			<ul class="nav-list">
				${section.items.map((item) => {
					const active = isNavigationItemActive(item, currentPath)
					return html`<li>
						<a
							class="nav-link ${active ? 'nav-link-active' : ''}"
							href="${item.href}"
						>
							<span class="nav-link-label">${item.label}</span>
							<span class="nav-link-description">${item.description}</span>
						</a>
					</li>`
				})}
			</ul>
		</section>`,
	)}`
}

const styles = `
	:root {
		color-scheme: light dark;
		--color-primary: #2563eb;
		--color-primary-hover: #1d4ed8;
		--color-primary-active: #1e40af;
		--color-on-primary: #ffffff;
		--color-primary-text: #1d4ed8;
		--color-background: #f8fafc;
		--color-surface: #ffffff;
		--color-surface-muted: #f1f5f9;
		--color-text: #0f172a;
		--color-text-muted: #64748b;
		--color-border: #cbd5e1;
		--color-success: #15803d;
		--color-success-surface: #dcfce7;
		--color-warning: #b45309;
		--color-warning-surface: #fef3c7;
		--color-danger: #dc2626;
		--color-danger-surface: #fee2e2;
		--font-family: system-ui, sans-serif;
		--font-size-xs: 0.75rem;
		--font-size-sm: 0.875rem;
		--font-size-base: 1rem;
		--font-size-lg: 1.25rem;
		--font-size-xl: 2rem;
		--font-size-2xl: 2.75rem;
		--font-weight-medium: 500;
		--font-weight-semibold: 600;
		--font-weight-bold: 700;
		--spacing-xs: 0.25rem;
		--spacing-sm: 0.5rem;
		--spacing-md: 1rem;
		--spacing-lg: 1.5rem;
		--spacing-xl: 2rem;
		--spacing-2xl: 3rem;
		--radius-sm: 0.25rem;
		--radius-md: 0.5rem;
		--radius-lg: 0.75rem;
		--radius-xl: 1rem;
		--radius-full: 999px;
		--shadow-sm: 0 1px 2px 0 rgb(15 23 42 / 0.06);
		--shadow-md: 0 18px 40px -24px rgb(15 23 42 / 0.35);
	}

	@media (prefers-color-scheme: dark) {
		:root {
			--color-primary: #60a5fa;
			--color-primary-hover: #93c5fd;
			--color-primary-active: #bfdbfe;
			--color-on-primary: #0f172a;
			--color-primary-text: #93c5fd;
			--color-background: #020617;
			--color-surface: #0f172a;
			--color-surface-muted: #111c31;
			--color-text: #f8fafc;
			--color-text-muted: #94a3b8;
			--color-border: #23304a;
			--color-success: #4ade80;
			--color-success-surface: rgb(34 197 94 / 0.12);
			--color-warning: #fbbf24;
			--color-warning-surface: rgb(251 191 36 / 0.12);
			--color-danger: #f87171;
			--color-danger-surface: rgb(248 113 113 / 0.12);
			--shadow-sm: 0 1px 2px 0 rgb(2 6 23 / 0.45);
			--shadow-md: 0 18px 40px -24px rgb(2 6 23 / 0.9);
		}
	}

	@media (max-width: 1024px) {
		:root {
			--font-size-xl: 1.75rem;
			--font-size-2xl: 2.25rem;
		}
	}

	*,
	*::before,
	*::after {
		box-sizing: border-box;
	}

	html {
		background: var(--color-background);
		overflow-x: hidden;
	}

	body {
		margin: 0;
		min-height: 100vh;
		font-family: var(--font-family);
		font-size: var(--font-size-base);
		line-height: 1.5;
		color: var(--color-text);
		background:
			radial-gradient(circle at top left, rgb(37 99 235 / 0.08), transparent 28%),
			var(--color-background);
		overflow-x: hidden;
	}

	h1,
	h2,
	h3 {
		margin: 0;
		line-height: 1.15;
		color: var(--color-text);
	}

	h1 {
		font-size: var(--font-size-2xl);
		overflow-wrap: anywhere;
	}

	h2 {
		font-size: var(--font-size-lg);
	}

	h3 {
		font-size: 1rem;
	}

	p,
	li {
		overflow-wrap: anywhere;
	}

	p,
	ul,
	ol {
		margin: 0;
	}

	a {
		color: var(--color-primary);
		text-decoration-color: color-mix(in srgb, var(--color-primary) 45%, transparent);
	}

	a:hover {
		color: var(--color-primary-hover);
	}

	button {
		appearance: none;
		border: 1px solid var(--color-primary);
		border-radius: var(--radius-md);
		background: var(--color-primary);
		color: var(--color-on-primary);
		padding: 0.625rem 1rem;
		font: inherit;
		font-weight: var(--font-weight-semibold);
		cursor: pointer;
		transition:
			background-color 0.15s ease,
			border-color 0.15s ease,
			transform 0.15s ease;
	}

	button:hover {
		background: var(--color-primary-hover);
		border-color: var(--color-primary-hover);
		transform: translateY(-1px);
	}

	button:active {
		background: var(--color-primary-active);
		border-color: var(--color-primary-active);
		transform: translateY(0);
	}

	input,
	select,
	textarea {
		font: inherit;
	}

	code,
	pre {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
			'Liberation Mono', 'Courier New', monospace;
	}

	code {
		padding: 0.125rem 0.375rem;
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
		background: color-mix(in srgb, var(--color-surface-muted) 88%, transparent);
	}

	pre {
		margin: 0;
		padding: var(--spacing-md);
		overflow: auto;
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: color-mix(in srgb, var(--color-surface-muted) 88%, transparent);
	}

	.layout-shell {
		display: grid;
		grid-template-columns: minmax(16rem, 18rem) minmax(0, 1fr);
		min-height: 100vh;
	}

	.sidebar {
		position: sticky;
		top: 0;
		align-self: start;
		height: 100vh;
		padding: var(--spacing-xl);
		display: grid;
		align-content: start;
		gap: var(--spacing-xl);
		border-right: 1px solid var(--color-border);
		background: color-mix(in srgb, var(--color-surface) 78%, transparent);
		backdrop-filter: blur(20px);
	}

	.sidebar-brand {
		display: grid;
		gap: var(--spacing-sm);
	}

	.sidebar-brand-title {
		font-size: 1.1rem;
		font-weight: var(--font-weight-bold);
	}

	.sidebar-brand-copy {
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
	}

	.nav-section {
		display: grid;
		gap: var(--spacing-sm);
	}

	.nav-section-title {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-bold);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.nav-list {
		list-style: none;
		padding: 0;
		display: grid;
		gap: var(--spacing-xs);
	}

	.nav-link {
		display: grid;
		gap: 0.1rem;
		padding: 0.75rem 0.875rem;
		border-radius: var(--radius-lg);
		text-decoration: none;
		border: 1px solid transparent;
		color: inherit;
		background: transparent;
	}

	.nav-link:hover {
		background: color-mix(in srgb, var(--color-surface-muted) 80%, transparent);
		border-color: color-mix(in srgb, var(--color-border) 65%, transparent);
		color: inherit;
	}

	.nav-link-active {
		background: color-mix(in srgb, var(--color-primary) 10%, var(--color-surface));
		border-color: color-mix(in srgb, var(--color-primary) 45%, var(--color-border));
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-primary) 30%, transparent);
	}

	.nav-link-label {
		font-weight: var(--font-weight-semibold);
	}

	.nav-link-description {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.layout-main {
		min-width: 0;
		padding: var(--spacing-xl);
	}

	.page {
		min-width: 0;
		width: min(100%, 92rem);
		margin: 0 auto;
		display: grid;
		gap: var(--spacing-lg);
	}

	.app-shell,
	.stack,
	.page-header,
	.page-intro,
	.section-stack {
		min-width: 0;
		display: grid;
		gap: var(--spacing-lg);
	}

	.page-intro {
		padding: clamp(1.25rem, 1.5vw, 1.75rem);
		border-radius: var(--radius-xl);
		border: 1px solid color-mix(in srgb, var(--color-primary) 20%, var(--color-border));
		background:
			linear-gradient(
				135deg,
				color-mix(in srgb, var(--color-primary) 11%, var(--color-surface)),
				var(--color-surface)
			);
		box-shadow: var(--shadow-md);
	}

	.page-eyebrow {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-bold);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-primary-text);
	}

	.title-row,
	.card-heading,
	.summary-card-heading,
	.split-row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--spacing-sm);
	}

	.card-grid,
	.metric-grid,
	.action-grid,
	.status-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
		gap: var(--spacing-md);
		align-items: start;
	}

	.metric-grid {
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
	}

	.card {
		display: grid;
		gap: var(--spacing-md);
		align-content: start;
		padding: var(--spacing-lg);
		background: color-mix(in srgb, var(--color-surface) 88%, transparent);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xl);
		box-shadow: var(--shadow-sm);
		min-width: 0;
	}

	.card-success {
		border-color: color-mix(in srgb, var(--color-success) 40%, var(--color-border));
		background: color-mix(in srgb, var(--color-success-surface) 55%, var(--color-surface));
	}

	.card-error {
		border-color: color-mix(in srgb, var(--color-danger) 55%, var(--color-border));
		background: color-mix(in srgb, var(--color-danger-surface) 52%, var(--color-surface));
	}

	.metric-card,
	.action-card,
	.summary-card {
		display: grid;
		gap: var(--spacing-sm);
		padding: var(--spacing-lg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xl);
		background: color-mix(in srgb, var(--color-surface) 88%, transparent);
		box-shadow: var(--shadow-sm);
		min-width: 0;
	}

	.metric-card[data-tone='good'],
	.summary-card[data-tone='good'] {
		border-color: color-mix(in srgb, var(--color-success) 45%, var(--color-border));
	}

	.metric-card[data-tone='warn'],
	.summary-card[data-tone='warn'] {
		border-color: color-mix(in srgb, var(--color-warning) 45%, var(--color-border));
	}

	.metric-card[data-tone='bad'],
	.summary-card[data-tone='bad'] {
		border-color: color-mix(in srgb, var(--color-danger) 52%, var(--color-border));
	}

	.metric-label,
	.summary-metric-label {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.metric-value {
		font-size: 1.8rem;
		font-weight: var(--font-weight-bold);
		line-height: 1;
	}

	.metric-detail,
	.summary-card-copy,
	.summary-card-note,
	.action-card-description {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.status-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: fit-content;
		padding: 0.25rem 0.65rem;
		border-radius: var(--radius-full);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-bold);
		letter-spacing: 0.04em;
		text-transform: uppercase;
		border: 1px solid transparent;
	}

	.status-badge-good {
		color: var(--color-success);
		background: color-mix(in srgb, var(--color-success-surface) 80%, var(--color-surface));
		border-color: color-mix(in srgb, var(--color-success) 35%, transparent);
	}

	.status-badge-warn {
		color: var(--color-warning);
		background: color-mix(in srgb, var(--color-warning-surface) 82%, var(--color-surface));
		border-color: color-mix(in srgb, var(--color-warning) 35%, transparent);
	}

	.status-badge-bad {
		color: var(--color-danger);
		background: color-mix(in srgb, var(--color-danger-surface) 80%, var(--color-surface));
		border-color: color-mix(in srgb, var(--color-danger) 35%, transparent);
	}

	.status-badge-neutral {
		color: var(--color-text-muted);
		background: color-mix(in srgb, var(--color-surface-muted) 84%, var(--color-surface));
		border-color: color-mix(in srgb, var(--color-border) 75%, transparent);
	}

	.summary-card-metrics {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr));
		gap: var(--spacing-sm);
	}

	.summary-card-metric {
		display: grid;
		gap: 0.15rem;
		padding: 0.75rem;
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--color-surface-muted) 80%, transparent);
	}

	.summary-metric-value {
		font-weight: var(--font-weight-bold);
	}

	.inline-links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--spacing-sm);
	}

	.inline-link {
		display: inline-flex;
		align-items: center;
		gap: var(--spacing-xs);
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius-full);
		border: 1px solid color-mix(in srgb, var(--color-border) 80%, transparent);
		background: color-mix(in srgb, var(--color-surface-muted) 78%, transparent);
		text-decoration: none;
		color: inherit;
	}

	.inline-link:hover {
		border-color: color-mix(in srgb, var(--color-primary) 45%, var(--color-border));
		color: inherit;
	}

	.action-card {
		text-decoration: none;
		color: inherit;
	}

	.action-card:hover {
		border-color: color-mix(in srgb, var(--color-primary) 40%, var(--color-border));
		transform: translateY(-1px);
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

	.list,
	.compact-list {
		padding-left: 1.25rem;
	}

	.list li + li,
	.compact-list li + li {
		margin-top: var(--spacing-sm);
	}

	.muted {
		color: var(--color-text-muted);
	}

	.field-stack {
		display: grid;
		gap: var(--spacing-md);
		max-width: 42rem;
	}

	.field-stack label {
		display: grid;
		gap: var(--spacing-xs);
		font-weight: var(--font-weight-semibold);
	}

	.field-stack input,
	.field-stack select,
	.field-stack textarea {
		padding: var(--spacing-sm) var(--spacing-md);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: color-mix(in srgb, var(--color-surface) 86%, transparent);
		color: var(--color-text);
	}

	.field-stack textarea {
		min-height: 5rem;
		resize: vertical;
	}

	.form-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--spacing-sm);
		align-items: center;
	}

	.empty-state {
		padding: var(--spacing-lg);
		border-radius: var(--radius-lg);
		border: 1px dashed color-mix(in srgb, var(--color-border) 85%, transparent);
		color: var(--color-text-muted);
		background: color-mix(in srgb, var(--color-surface-muted) 68%, transparent);
	}

	.data-table-scroll {
		width: 100%;
		max-width: 100%;
		overflow-x: auto;
	}

	.data-table {
		width: 100%;
		min-width: 42rem;
		border-collapse: collapse;
		font-size: var(--font-size-sm);
	}

	.data-table th,
	.data-table td {
		min-width: 8rem;
		padding: 0.75rem;
		text-align: left;
		vertical-align: top;
		border-bottom: 1px solid color-mix(in srgb, var(--color-border) 75%, transparent);
		overflow-wrap: normal;
		word-break: normal;
	}

	.data-table th,
	.data-table td:first-child,
	.data-table .inline-link,
	.data-table .status-badge {
		white-space: nowrap;
	}

	.data-table-diagnostics th:nth-child(3),
	.data-table-diagnostics td:nth-child(3) {
		min-width: 16rem;
	}

	.data-table-diagnostics th:nth-child(4),
	.data-table-diagnostics td:nth-child(4) {
		min-width: 12rem;
	}

	.data-table .inline-links {
		align-items: flex-start;
		min-width: max-content;
	}

	.data-table .inline-link {
		width: auto;
	}

	.data-table th {
		color: var(--color-text-muted);
		font-weight: var(--font-weight-semibold);
	}

	@media (max-width: 800px) {
		.layout-shell {
			grid-template-columns: 1fr;
		}

		.sidebar {
			position: static;
			height: auto;
			padding: var(--spacing-md);
			gap: var(--spacing-md);
			border-right: none;
			border-bottom: 1px solid var(--color-border);
		}

		.sidebar-brand-copy {
			display: none;
		}

		.sidebar nav {
			display: grid;
			gap: var(--spacing-sm);
			overflow-x: auto;
			padding-bottom: var(--spacing-xs);
			scrollbar-width: thin;
		}

		.nav-section {
			min-width: max-content;
		}

		.nav-list {
			display: flex;
			gap: var(--spacing-sm);
		}

		.nav-link {
			min-width: max-content;
			height: 100%;
			padding: 0.625rem 0.75rem;
		}

		.nav-link-description {
			display: none;
		}

		.layout-main {
			padding: var(--spacing-md);
			overflow-x: hidden;
		}

		.page-intro,
		.card,
		.metric-card,
		.action-card,
		.summary-card {
			padding: var(--spacing-md);
		}

		.card-grid,
		.metric-grid,
		.action-grid,
		.status-grid,
		.summary-card-metrics {
			grid-template-columns: minmax(0, 1fr);
		}

		.title-row,
		.card-heading,
		.summary-card-heading,
		.split-row,
		.inline-links,
		.form-actions {
			flex-direction: column;
			align-items: stretch;
		}

		.inline-link,
		button {
			justify-content: center;
			width: 100%;
		}

		.data-table .inline-link,
		.data-table button {
			width: auto;
		}
	}
`

export function RootLayout(input: {
	title: string
	body: ReturnType<typeof html>
	currentPath?: string
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
			<div class="layout-shell">
				<aside class="sidebar">
					<section class="sidebar-brand">
						<div class="page-eyebrow">Local admin</div>
						<div class="sidebar-brand-title">home connector</div>
						<p class="sidebar-brand-copy">
							Operational dashboard and diagnostics for the connector running on
							this machine.
						</p>
					</section>
					<nav aria-label="Primary">${renderNavigation(input.currentPath)}</nav>
				</aside>
				<div class="layout-main">
					<main class="page">${input.body}</main>
				</div>
			</div>
		</body>
	</html>`
}
