import { html } from 'remix/html-template'

export type StatusTone = 'good' | 'warn' | 'bad' | 'neutral'

export type ActionLink = {
	href: string
	label: string
}

type MetricCardInput = {
	label: string
	value: string | number | ReturnType<typeof html>
	detail?: string | ReturnType<typeof html>
	tone?: StatusTone
}

type SummaryMetric = {
	label: string
	value: string | number | ReturnType<typeof html>
}

type SummaryCardInput = {
	title: string
	description: string
	status: string
	tone: StatusTone
	metrics: Array<SummaryMetric>
	primaryLink?: ActionLink
	secondaryLink?: ActionLink
	note?: string | ReturnType<typeof html>
}

type ActionCardInput = {
	href: string
	title: string
	description: string
	badge?: {
		label: string
		tone: StatusTone
	}
}

type PageIntroInput = {
	eyebrow: string
	title: string
	description: string | ReturnType<typeof html>
	actions?: Array<ActionLink>
}

function getStatusBadgeClassName(tone: StatusTone) {
	switch (tone) {
		case 'good':
			return 'status-badge status-badge-good'
		case 'warn':
			return 'status-badge status-badge-warn'
		case 'bad':
			return 'status-badge status-badge-bad'
		case 'neutral':
			return 'status-badge status-badge-neutral'
	}
}

export function renderStatusBadge(input: { label: string; tone: StatusTone }) {
	return html`<span class="${getStatusBadgeClassName(input.tone)}">
		${input.label}
	</span>`
}

export function renderPageIntro(input: PageIntroInput) {
	return html`<section class="page-intro">
		<div class="page-eyebrow">${input.eyebrow}</div>
		<div class="title-row">
			<div class="page-header">
				<h1>${input.title}</h1>
				<p class="muted">${input.description}</p>
			</div>
			${input.actions && input.actions.length > 0
				? renderInlineLinks(input.actions)
				: ''}
		</div>
	</section>`
}

export function renderMetricCard(input: MetricCardInput) {
	return html`<section
		class="metric-card"
		data-tone="${input.tone ?? 'neutral'}"
	>
		<div class="metric-label">${input.label}</div>
		<div class="metric-value">${input.value}</div>
		${input.detail
			? html`<div class="metric-detail">${input.detail}</div>`
			: ''}
	</section>`
}

export function renderSummaryCard(input: SummaryCardInput) {
	return html`<section class="summary-card" data-tone="${input.tone}">
		<div class="summary-card-heading">
			<div class="page-header">
				<h2>${input.title}</h2>
				<p class="summary-card-copy">${input.description}</p>
			</div>
			${renderStatusBadge({
				label: input.status,
				tone: input.tone,
			})}
		</div>
		<div class="summary-card-metrics">
			${input.metrics.map(
				(metric) => html`<div class="summary-card-metric">
					<div class="summary-metric-label">${metric.label}</div>
					<div class="summary-metric-value">${metric.value}</div>
				</div>`,
			)}
		</div>
		${input.primaryLink || input.secondaryLink
			? html`<div class="inline-links">
					${input.primaryLink ? renderInlineLink(input.primaryLink) : ''}
					${input.secondaryLink ? renderInlineLink(input.secondaryLink) : ''}
				</div>`
			: ''}
		${input.note
			? html`<div class="summary-card-note">${input.note}</div>`
			: ''}
	</section>`
}

export function renderActionCard(input: ActionCardInput) {
	return html`<a class="action-card" href="${input.href}">
		<div class="card-heading">
			<h2>${input.title}</h2>
			${input.badge ? renderStatusBadge(input.badge) : ''}
		</div>
		<p class="action-card-description">${input.description}</p>
	</a>`
}

export function renderInlineLink(link: ActionLink) {
	return html`<a class="inline-link" href="${link.href}">${link.label}</a>`
}

export function renderInlineLinks(links: Array<ActionLink>) {
	return html`<div class="inline-links">
		${links.map((link) => renderInlineLink(link))}
	</div>`
}

export function renderEmptyState(message: string | ReturnType<typeof html>) {
	return html`<div class="empty-state">${message}</div>`
}

export function renderDataTable(input: {
	headers: Array<string>
	rows: Array<Array<string | number | ReturnType<typeof html>>>
}) {
	if (input.rows.length === 0) {
		return renderEmptyState('No rows to display.')
	}

	return html`<table class="data-table">
		<thead>
			<tr>
				${input.headers.map((header) => html`<th scope="col">${header}</th>`)}
			</tr>
		</thead>
		<tbody>
			${input.rows.map(
				(row) => html`<tr>
					${row.map((value) => html`<td>${value}</td>`)}
				</tr>`,
			)}
		</tbody>
	</table>`
}
