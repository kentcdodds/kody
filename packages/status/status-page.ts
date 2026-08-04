import {
	type ComponentSnapshot,
	type IncidentView,
	type StatusSnapshot,
} from './status-types.ts'

/** Server-rendered public status page. No client JavaScript; the page uses a
 * meta refresh so an open tab keeps tracking an ongoing incident. */

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
}

const pageStyles = `
:root {
	color-scheme: light dark;
	--bg: #f8fafc;
	--card: #ffffff;
	--text: #0f172a;
	--muted: #64748b;
	--border: #e2e8f0;
	--ok: #16a34a;
	--down: #dc2626;
	--unknown: #94a3b8;
	--partial: #d97706;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #0b1120;
		--card: #111a2e;
		--text: #e2e8f0;
		--muted: #94a3b8;
		--border: #1e2a44;
	}
}
* { box-sizing: border-box; }
body {
	margin: 0;
	font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
	background: var(--bg);
	color: var(--text);
	line-height: 1.5;
}
main { max-width: 720px; margin: 0 auto; padding: 2rem 1rem 4rem; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h1 { font-size: 1.5rem; margin: 0; }
.banner {
	margin: 1.25rem 0;
	padding: 1rem 1.25rem;
	border-radius: 0.75rem;
	font-weight: 600;
	color: #ffffff;
}
.banner.ok { background: var(--ok); }
.banner.down { background: var(--down); }
.banner.unknown { background: var(--unknown); }
.card {
	background: var(--card);
	border: 1px solid var(--border);
	border-radius: 0.75rem;
	padding: 1rem 1.25rem;
	margin-bottom: 1rem;
}
.component { display: flex; flex-direction: column; gap: 0.5rem; }
.component-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.component-name { font-weight: 600; }
.component-meta { color: var(--muted); font-size: 0.85rem; }
.dot { display: inline-block; width: 0.6rem; height: 0.6rem; border-radius: 50%; margin-right: 0.5rem; vertical-align: baseline; }
.dot.operational { background: var(--ok); }
.dot.down { background: var(--down); }
.dot.unknown { background: var(--unknown); }
.bars { display: flex; gap: 2px; height: 2rem; align-items: stretch; }
.bar { flex: 1 1 0; border-radius: 1px; background: var(--ok); min-width: 2px; }
.bar.empty { background: var(--border); }
.bar.partial { background: var(--partial); }
.bar.bad { background: var(--down); }
.bars-legend { display: flex; justify-content: space-between; color: var(--muted); font-size: 0.75rem; }
.incident { border-left: 3px solid var(--down); padding-left: 0.75rem; margin: 0.75rem 0; }
.incident.resolved { border-left-color: var(--ok); }
.incident-title { font-weight: 600; }
.incident-meta { color: var(--muted); font-size: 0.85rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 0.75rem; }
footer { margin-top: 2.5rem; color: var(--muted); font-size: 0.85rem; }
footer a { color: inherit; }
`

function bannerFor(snapshot: StatusSnapshot): { label: string; kind: string } {
	switch (snapshot.overallStatus) {
		case 'operational':
			return { label: 'All systems operational', kind: 'ok' }
		case 'down':
			return { label: 'Some systems are experiencing problems', kind: 'down' }
		case 'unknown':
			return { label: 'Status data is not available yet', kind: 'unknown' }
		default: {
			snapshot.overallStatus satisfies never
			throw new Error(
				`Unknown overall status: ${String(snapshot.overallStatus)}`,
			)
		}
	}
}

function renderDayBars(component: ComponentSnapshot): string {
	const bars = component.days
		.map((day) => {
			if (day.total === 0) {
				return `<div class="bar empty" title="${escapeHtml(day.day)}: no data"></div>`
			}
			const failedRatio = day.failed / day.total
			const kind =
				failedRatio === 0 ? '' : failedRatio < 0.05 ? ' partial' : ' bad'
			const pct = (((day.total - day.failed) / day.total) * 100).toFixed(2)
			return `<div class="bar${kind}" title="${escapeHtml(day.day)}: ${pct}% up"></div>`
		})
		.join('')
	return `<div class="bars">${bars}</div>`
}

function renderComponent(component: ComponentSnapshot): string {
	const statusLabel =
		component.status === 'operational'
			? 'Operational'
			: component.status === 'down'
				? 'Down'
				: 'Unknown'
	const uptime =
		component.uptimePct === null
			? 'no data yet'
			: `${component.uptimePct.toFixed(2)}% uptime (90 days)`
	const latency =
		component.status === 'operational' && component.latencyMs !== null
			? ` · ${component.latencyMs}ms`
			: ''
	const firstDay = component.days.at(0)?.day ?? ''
	const lastDay = component.days.at(-1)?.day ?? ''
	return `<div class="card component">
	<div class="component-header">
		<span class="component-name"><span class="dot ${component.status}"></span>${escapeHtml(component.name)}</span>
		<span class="component-meta">${escapeHtml(statusLabel)}${latency}</span>
	</div>
	${renderDayBars(component)}
	<div class="bars-legend"><span>${escapeHtml(firstDay)}</span><span>${escapeHtml(uptime)}</span><span>${escapeHtml(lastDay)}</span></div>
</div>`
}

function renderIncident(incident: IncidentView): string {
	const resolved = incident.resolvedAt !== null
	const detail = incident.detail ? ` — ${escapeHtml(incident.detail)}` : ''
	const timing = resolved
		? `${escapeHtml(incident.startedAt)} → ${escapeHtml(incident.resolvedAt ?? '')}`
		: `since ${escapeHtml(incident.startedAt)}`
	return `<div class="incident${resolved ? ' resolved' : ''}">
	<div class="incident-title">${escapeHtml(incident.componentName)} ${resolved ? 'outage (resolved)' : 'is down'}${detail}</div>
	<div class="incident-meta">${timing}</div>
</div>`
}

export function renderStatusPage(snapshot: StatusSnapshot): string {
	const banner = bannerFor(snapshot)
	const components = snapshot.components.map(renderComponent).join('\n')
	const openIncidents =
		snapshot.openIncidents.length > 0
			? `<h2>Open incidents</h2>${snapshot.openIncidents.map(renderIncident).join('\n')}`
			: ''
	const recentIncidents =
		snapshot.recentIncidents.length > 0
			? `<h2>Past incidents</h2>${snapshot.recentIncidents.map(renderIncident).join('\n')}`
			: '<h2>Past incidents</h2><p class="component-meta">No incidents recorded in the last 90 days.</p>'
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="60" />
<title>kody status</title>
<style>${pageStyles}</style>
</head>
<body>
<main>
	<header>
		<h1>kody status</h1>
		<span class="component-meta">Updated ${escapeHtml(snapshot.generatedAt)}</span>
	</header>
	<div class="banner ${banner.kind}">${escapeHtml(banner.label)}</div>
	${components}
	${openIncidents}
	${recentIncidents}
	<footer>
		Probes run every minute from an independently deployed worker.
		<a href="https://heykody.dev">heykody.dev</a> ·
		<a href="/status.json">JSON</a>
	</footer>
</main>
</body>
</html>`
}
