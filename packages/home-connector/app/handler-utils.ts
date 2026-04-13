import { html } from 'remix/html-template'

type InfoRow = {
	label: string
	value: string | number | ReturnType<typeof html>
}

export function renderInfoRows(rows: Array<InfoRow>) {
	return html`<div class="info-list">
		${rows.map(
			(row) =>
				html`<div class="info-row">
					<div class="info-label">${row.label}</div>
					<div class="info-value">${row.value}</div>
				</div>`,
		)}
	</div>`
}

export function formatJson(value: unknown) {
	return JSON.stringify(value, null, 2)
}

export function renderCodeBlock(value: string) {
	return html`<pre><code>${value}</code></pre>`
}

export function renderBanner(input: { tone: 'success' | 'error'; message: string }) {
	return html`<section
		class="card ${input.tone === 'error' ? 'card-error' : 'card-success'}"
	>
		<p>${input.message}</p>
	</section>`
}
