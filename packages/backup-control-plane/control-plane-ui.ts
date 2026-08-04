import { escapeHtml } from '@kody-internal/shared/escape-html.ts'
import {
	backupEscrowSecretStoreKeyKey,
	sealedFullManifestKey,
	stagingSummaryKey,
} from '@kody-internal/shared/backup-staging.ts'

import { isBackupEnabled, utcDay, backupPayload } from './backup-policy.ts'
import { type BackupEnvironment, type BackupManifest } from './backup-types.ts'
import { getD1Database } from './d1-import-api.ts'
import { verifyBackupFullManifestSignature } from './full-manifest-signing.ts'
import { readManifest } from './immutable-storage.ts'
import { verifyBackupManifestSignature } from './manifest-signing.ts'
import { type DrillReport } from './restore-drill.ts'
import { type ProductionRestoreProgress } from './production-restore.ts'
import { type RestoreConfirmToken } from './restore-confirm-token.ts'
import { readFullManifest } from './seal-full-backup.ts'
import { readSqlRestorability } from './sql-statement-stats.ts'
import { type EnqueueResult } from './workflow-trigger.ts'

const DASHBOARD_DAY_COUNT = 14

function layout(
	title: string,
	body: string,
	options?: { danger?: boolean },
): string {
	const accent = options?.danger ? '#f07178' : '#7aa2f7'
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
:root {
	color-scheme: dark;
	--bg0: #0d1117;
	--bg1: #151b24;
	--bg2: #1c2430;
	--text: #e6edf3;
	--muted: #9aa7b5;
	--line: #2b3645;
	--accent: ${accent};
	--ok: #3dd68c;
	--warn: #e0b567;
	--bad: #f07178;
	--danger-bg: #2a1215;
}
* { box-sizing: border-box; }
body {
	margin: 0;
	font: 15px/1.45 "IBM Plex Sans", "Segoe UI", sans-serif;
	color: var(--text);
	background:
		radial-gradient(1200px 600px at 10% -10%, #1a2740 0%, transparent 55%),
		radial-gradient(900px 500px at 100% 0%, #1a2030 0%, transparent 50%),
		linear-gradient(180deg, var(--bg0), #0a0e14 80%);
	min-height: 100vh;
}
main { max-width: 1080px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
header { margin-bottom: 1.75rem; }
h1 { font-size: 1.7rem; margin: 0 0 0.35rem; letter-spacing: -0.02em; }
h2 { font-size: 1.1rem; margin: 0 0 0.75rem; }
p, li { color: var(--muted); }
.panel {
	background: color-mix(in srgb, var(--bg1) 92%, black);
	border: 1px solid var(--line);
	border-radius: 10px;
	padding: 1rem 1.1rem;
	margin-bottom: 1rem;
}
.panel.danger {
	background: var(--danger-bg);
	border-color: color-mix(in srgb, var(--bad) 55%, var(--line));
}
.grid { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.kv { display: flex; flex-direction: column; gap: 0.15rem; }
.kv span { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
.kv strong { font-weight: 600; color: var(--text); word-break: break-all; }
table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
th, td { text-align: left; padding: 0.45rem 0.4rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
.ok { color: var(--ok); }
.warn { color: var(--warn); }
.bad { color: var(--bad); }
.actions { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: end; }
label { display: flex; flex-direction: column; gap: 0.25rem; color: var(--muted); font-size: 0.85rem; }
input[type="text"], input[type="date"] {
	background: var(--bg2);
	border: 1px solid var(--line);
	border-radius: 6px;
	color: var(--text);
	padding: 0.45rem 0.55rem;
	min-width: 12rem;
}
button, .button {
	appearance: none;
	border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--line));
	background: color-mix(in srgb, var(--accent) 18%, var(--bg2));
	color: var(--text);
	border-radius: 6px;
	padding: 0.5rem 0.85rem;
	font: inherit;
	cursor: pointer;
	text-decoration: none;
	display: inline-block;
}
button.danger, .button.danger {
	border-color: color-mix(in srgb, var(--bad) 60%, var(--line));
	background: color-mix(in srgb, var(--bad) 22%, var(--bg2));
}
pre {
	white-space: pre-wrap;
	word-break: break-word;
	background: var(--bg2);
	border-radius: 6px;
	padding: 0.75rem;
	border: 1px solid var(--line);
	color: var(--text);
}
.flash { margin-bottom: 1rem; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`
}

function statusClass(ok: boolean | null): string {
	if (ok === null) return 'muted'
	return ok ? 'ok' : 'bad'
}

function statusLabel(
	ok: boolean | null,
	presentLabel = 'yes',
	absentLabel = 'no',
	unknownLabel = '—',
): string {
	if (ok === null) return unknownLabel
	return ok ? presentLabel : absentLabel
}

export type DayStatus = {
	day: string
	d1Present: boolean
	d1Verified: boolean | null
	d1Restorable: boolean | null
	stagingPresent: boolean
	sealedPresent: boolean
	sealedVerified: boolean | null
	warnings: Array<string>
}

export async function collectDayStatuses(
	env: BackupEnvironment,
	now: Date = new Date(),
): Promise<Array<DayStatus>> {
	const days: Array<DayStatus> = []
	for (let offset = 0; offset < DASHBOARD_DAY_COUNT; offset += 1) {
		const date = new Date(now)
		date.setUTCDate(date.getUTCDate() - offset)
		const day = utcDay(date)
		const warnings: Array<string> = []
		const d1Key = backupPayload(
			env,
			new Date(`${day}T12:00:00.000Z`),
		).manifestKey
		let d1Present = false
		let d1Verified: boolean | null = null
		let d1Restorable: boolean | null = null
		let d1Manifest: BackupManifest | null = null
		try {
			d1Manifest = await readManifest(env.BACKUP_BUCKET, d1Key)
			d1Present = d1Manifest !== null
			if (d1Manifest !== null) {
				d1Verified = await verifyBackupManifestSignature(env, d1Manifest)
				if (!d1Verified) warnings.push('D1 manifest signature invalid')
			}
		} catch {
			d1Verified = null
			warnings.push('D1 manifest unreadable')
		}
		if (d1Manifest !== null && d1Verified === true) {
			try {
				const restorability = await readSqlRestorability(
					env.BACKUP_BUCKET,
					day,
					d1Manifest.payload.sql.objectKey,
				)
				switch (restorability.kind) {
					case 'restorable':
						d1Restorable = true
						break
					case 'unrestorable':
						d1Restorable = false
						warnings.push(
							'D1 SQL contains oversized statements and cannot be restored',
						)
						break
					case 'legacy-unknown':
						warnings.push(
							'D1 restorability unknown: legacy backup has no SQL stats',
						)
						break
					case 'missing':
						d1Restorable = false
						warnings.push(
							'D1 is not restorable: required SQL stats are missing',
						)
						break
					case 'corrupt':
						d1Restorable = false
						warnings.push('D1 is not restorable: SQL stats are unreadable')
						break
					default: {
						const exhaustive: never = restorability
						throw exhaustive
					}
				}
			} catch {
				d1Restorable = false
				warnings.push('D1 is not restorable: SQL stats lookup failed')
			}
		}

		const stagingPresent =
			(await env.BACKUP_BUCKET.head(stagingSummaryKey(day))) !== null

		let sealedPresent = false
		let sealedVerified: boolean | null = null
		try {
			const full = await readFullManifest(
				env.BACKUP_BUCKET,
				sealedFullManifestKey(day),
			)
			sealedPresent = full !== null
			if (full !== null) {
				sealedVerified = await verifyBackupFullManifestSignature(env, full)
				if (!sealedVerified) warnings.push('full manifest signature invalid')
			}
		} catch {
			sealedVerified = null
			warnings.push('full manifest unreadable')
		}

		days.push({
			day,
			d1Present,
			d1Verified,
			d1Restorable,
			stagingPresent,
			sealedPresent,
			sealedVerified,
			warnings,
		})
	}
	return days
}

export async function renderDashboard(
	env: BackupEnvironment,
	options: { flashHtml?: string; now?: Date } = {},
): Promise<string> {
	const now = options.now ?? new Date()
	const enabled = isBackupEnabled(env)
	let sourceSizeHtml = `<span class="warn">unavailable</span>`
	try {
		const meta = await getD1Database({
			accountId: env.SOURCE_ACCOUNT_ID,
			databaseId: env.SOURCE_DATABASE_ID,
			token: env.CLOUDFLARE_API_TOKEN,
		})
		sourceSizeHtml = `<strong>${escapeHtml(String(meta.fileSize))} bytes</strong>`
	} catch (error) {
		const message = error instanceof Error ? error.message : 'lookup failed'
		sourceSizeHtml = `<span class="bad">${escapeHtml(message)}</span>`
	}
	const escrowPresent =
		(await env.BACKUP_BUCKET.head(backupEscrowSecretStoreKeyKey)) !== null
	const days = await collectDayStatuses(env, now)
	const dayRows = days
		.map((day) => {
			return `<tr>
<td><code>${escapeHtml(day.day)}</code></td>
<td class="${statusClass(day.d1Present)}">${escapeHtml(statusLabel(day.d1Present))}</td>
<td class="${statusClass(day.d1Verified)}">${escapeHtml(statusLabel(day.d1Verified, 'verified', 'unverified'))}</td>
<td class="${statusClass(day.d1Restorable)}">${escapeHtml(statusLabel(day.d1Restorable, 'yes', 'no', 'unknown'))}</td>
<td class="${statusClass(day.stagingPresent)}">${escapeHtml(statusLabel(day.stagingPresent))}</td>
<td class="${statusClass(day.sealedPresent)}">${escapeHtml(statusLabel(day.sealedPresent))}</td>
<td class="${statusClass(day.sealedVerified)}">${escapeHtml(statusLabel(day.sealedVerified, 'verified', 'unverified'))}</td>
<td>${day.warnings.length === 0 ? '<span class="muted">—</span>' : escapeHtml(day.warnings.join('; '))}</td>
</tr>`
		})
		.join('\n')

	const body = `
<header>
	<h1>Kody DR backup control plane</h1>
	<p>Operator dashboard for D1 export, full-day sealing, isolated drills, and graduated production restore.</p>
</header>
${options.flashHtml ?? ''}
<section class="panel">
	<h2>Enable gate</h2>
	<div class="grid">
		<div class="kv"><span>ENABLE_PRODUCTION_D1_BACKUPS</span><strong>${escapeHtml(env.ENABLE_PRODUCTION_D1_BACKUPS)}</strong></div>
		<div class="kv"><span>BACKUP_BENCHMARK_APPROVED</span><strong>${escapeHtml(env.BACKUP_BENCHMARK_APPROVED)}</strong></div>
		<div class="kv"><span>isBackupEnabled</span><strong class="${enabled ? 'ok' : 'bad'}">${enabled ? 'true' : 'false'}</strong></div>
	</div>
</section>
<section class="panel">
	<h2>Source identity</h2>
	<div class="grid">
		<div class="kv"><span>SOURCE_ACCOUNT_ID</span><strong>${escapeHtml(env.SOURCE_ACCOUNT_ID)}</strong></div>
		<div class="kv"><span>SOURCE_DATABASE_ID</span><strong>${escapeHtml(env.SOURCE_DATABASE_ID)}</strong></div>
		<div class="kv"><span>SOURCE_DATABASE_NAME</span><strong>${escapeHtml(env.SOURCE_DATABASE_NAME)}</strong></div>
		<div class="kv"><span>Live D1 file_size</span>${sourceSizeHtml}</div>
		<div class="kv"><span>BUILD_COMMIT</span><strong>${escapeHtml(env.BUILD_COMMIT)}</strong></div>
		<div class="kv"><span>Escrow blob</span><strong class="${escrowPresent ? 'ok' : 'warn'}">${escrowPresent ? 'present' : 'missing'}</strong></div>
	</div>
</section>
<section class="panel">
	<h2>Recent days</h2>
	<table>
		<thead>
			<tr>
				<th>Day</th>
				<th>D1 manifest</th>
				<th>D1 verified</th>
				<th>D1 restorable</th>
				<th>Staging</th>
				<th>Sealed</th>
				<th>Seal verified</th>
				<th>Warnings</th>
			</tr>
		</thead>
		<tbody>
			${dayRows}
		</tbody>
	</table>
</section>
<section class="panel">
	<h2>Actions</h2>
	<div class="actions">
		<form method="post" action="/actions/run-backup">
			<button type="submit">Run today's D1 backup</button>
		</form>
		<form method="post" action="/actions/seal-day" class="actions">
			<label>Day
				<input type="text" name="day" placeholder="YYYY-MM-DD" required pattern="\\d{4}-\\d{2}-\\d{2}"/>
			</label>
			<button type="submit">Seal day</button>
		</form>
		<form method="post" action="/actions/run-drill" class="actions">
			<label>Day
				<input type="text" name="day" placeholder="YYYY-MM-DD" required pattern="\\d{4}-\\d{2}-\\d{2}"/>
			</label>
			<button type="submit">Run isolated restore drill</button>
		</form>
	</div>
</section>
<section class="panel danger">
	<h2>Production restore (dangerous)</h2>
	<p>This path imports SQL into the configured production D1 and then restores sealed durable stores through the primary worker. Use only during an approved incident.</p>
	<form method="post" action="/actions/restore/prepare" class="actions" onsubmit="return confirm('Prepare a PRODUCTION restore confirmation for this day?');">
		<label>Day
			<input type="text" name="day" placeholder="YYYY-MM-DD" required pattern="\\d{4}-\\d{2}-\\d{2}"/>
		</label>
		<button class="danger" type="submit">Prepare production restore</button>
	</form>
</section>`
	return layout('Kody DR backup control plane', body)
}

export function renderMessagePage(
	title: string,
	message: string,
	options?: { danger?: boolean; details?: string },
): string {
	const body = `
<header>
	<h1>${escapeHtml(title)}</h1>
</header>
<section class="panel${options?.danger ? ' danger' : ''}">
	<p>${escapeHtml(message)}</p>
	${options?.details ? `<pre>${escapeHtml(options.details)}</pre>` : ''}
	<p><a class="button" href="/">Back to dashboard</a></p>
</section>`
	return layout(title, body, { danger: options?.danger })
}

export function renderEnqueueResult(
	day: string,
	result: EnqueueResult,
): string {
	return renderMessagePage(
		'D1 backup enqueue',
		`Backup workflow for ${day}: ${result}.`,
	)
}

export function renderSealResult(details: string): string {
	return renderMessagePage('Seal day', details)
}

export function renderDrillReport(report: DrillReport): string {
	const failed = report.errorCode !== null
	const counts = report.tableCounts
		.map(
			(entry) =>
				`${entry.table}=${entry.count === null ? '?' : String(entry.count)}`,
		)
		.join(', ')
	const details = [
		`day=${report.day}`,
		`databaseName=${report.databaseName}`,
		`databaseId=${report.databaseId ?? 'n/a'}`,
		`quickCheck=${report.quickCheck ?? 'n/a'}`,
		`tableCounts=${counts || 'n/a'}`,
		`keptForInspection=${String(report.keptForInspection)}`,
		report.errorCode ? `errorCode=${report.errorCode}` : null,
		report.errorMessage ? `errorMessage=${report.errorMessage}` : null,
	]
		.filter(Boolean)
		.join('\n')
	return renderMessagePage(
		failed ? 'Restore drill failed' : 'Restore drill complete',
		failed
			? 'The isolated drill did not complete cleanly. The drill database was kept for inspection when creation succeeded.'
			: 'Isolated restore drill completed and the temporary database was deleted.',
		{ danger: failed, details },
	)
}

export function renderRestorePreparePage(input: {
	day: string
	sourceDatabaseName: string
	sqlObjectKey: string
	sqlBytes: number
	sqlSha256: string
	token: RestoreConfirmToken
}): string {
	const body = `
<header>
	<h1>Confirm PRODUCTION restore</h1>
	<p class="bad">This will overwrite production D1 contents and restore sealed stores for the selected day.</p>
</header>
<section class="panel danger">
	<h2>Restore target</h2>
	<div class="grid">
		<div class="kv"><span>Day</span><strong>${escapeHtml(input.day)}</strong></div>
		<div class="kv"><span>Database name</span><strong>${escapeHtml(input.sourceDatabaseName)}</strong></div>
		<div class="kv"><span>SQL object</span><strong>${escapeHtml(input.sqlObjectKey)}</strong></div>
		<div class="kv"><span>SQL bytes</span><strong>${escapeHtml(String(input.sqlBytes))}</strong></div>
		<div class="kv"><span>SQL sha256</span><strong>${escapeHtml(input.sqlSha256)}</strong></div>
		<div class="kv"><span>Token expires</span><strong>${escapeHtml(input.token.expiresAt)}</strong></div>
	</div>
	<form method="post" action="/actions/restore/execute" class="actions" style="margin-top:1rem" onsubmit="return confirm('Type-confirm and EXECUTE production restore now?');">
		<input type="hidden" name="day" value="${escapeHtml(input.day)}"/>
		<input type="hidden" name="expiresAt" value="${escapeHtml(input.token.expiresAt)}"/>
		<input type="hidden" name="confirmToken" value="${escapeHtml(input.token.token)}"/>
		<label>Type the production database name exactly (${escapeHtml(input.sourceDatabaseName)})
			<input type="text" name="typedDatabaseName" required autocomplete="off"/>
		</label>
		<button class="danger" type="submit">Execute production restore</button>
	</form>
	<p><a class="button" href="/">Cancel</a></p>
</section>`
	return layout('Confirm PRODUCTION restore', body, { danger: true })
}

export function renderRestoreAlreadyStartedPage(instanceId: string): string {
	const body = `
<header>
	<h1>Restore already started</h1>
	<p>This confirmation token already started a production restore workflow. Replays map to the same instance and are rejected as duplicates.</p>
</header>
<section class="panel danger">
	<div class="kv"><span>Instance</span><strong>${escapeHtml(instanceId)}</strong></div>
	<p>
		<a class="button" href="/restore-status?id=${encodeURIComponent(instanceId)}">View restore status</a>
		<a class="button" href="/">Dashboard</a>
	</p>
</section>`
	return layout('Restore already started', body, { danger: true })
}

export function renderRestoreStatusPage(input: {
	instanceId: string
	status: string
	progress?: ProductionRestoreProgress | null
}): string {
	const details = input.progress
		? JSON.stringify(input.progress, null, 2)
		: 'No progress payload yet.'
	const body = `
<header>
	<h1>Production restore status</h1>
	<p>Workflow instance <code>${escapeHtml(input.instanceId)}</code></p>
</header>
<section class="panel danger">
	<div class="kv"><span>Status</span><strong>${escapeHtml(input.status)}</strong></div>
	<pre>${escapeHtml(details)}</pre>
	<p>
		<a class="button" href="/restore-status?id=${encodeURIComponent(input.instanceId)}">Refresh</a>
		<a class="button" href="/">Dashboard</a>
	</p>
	<meta http-equiv="refresh" content="5;url=/restore-status?id=${encodeURIComponent(input.instanceId)}"/>
</section>`
	return layout('Production restore status', body, { danger: true })
}

export function htmlResponse(html: string, status = 200): Response {
	return new Response(html, {
		status,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
		},
	})
}
