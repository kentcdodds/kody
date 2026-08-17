import { isRecord } from '@kody-internal/shared/is-record.ts'
import {
	buildStatusIncidentOpenedEvent,
	buildStatusIncidentResolvedEvent,
	statusIncidentOpenedTopic,
	statusIncidentResolvedTopic,
	type StatusIncidentEvent,
} from './subscription-event.ts'

const componentIdPattern = /^[a-z][a-z0-9_]{0,63}$/
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const maxDetailLength = 500

export type ParseStatusIncidentEventResult =
	| { ok: true; event: StatusIncidentEvent }
	| { ok: false; error: string }

function readNonEmptyString(value: unknown) {
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readIsoTimestamp(value: unknown) {
	const timestamp = readNonEmptyString(value)
	if (!timestamp || !isoTimestampPattern.test(timestamp)) return null
	if (!Number.isFinite(Date.parse(timestamp))) return null
	return timestamp
}

function readDetail(value: unknown) {
	if (value === null || value === undefined)
		return { ok: true as const, detail: null }
	if (typeof value !== 'string') return { ok: false as const }
	const trimmed = value.trim()
	if (trimmed.length > maxDetailLength) return { ok: false as const }
	return { ok: true as const, detail: trimmed.length > 0 ? trimmed : null }
}

function readHttpsUrl(value: unknown) {
	const raw = readNonEmptyString(value)
	if (!raw) return null
	try {
		const url = new URL(raw)
		return url.protocol === 'https:' ? raw : null
	} catch {
		return null
	}
}

/**
 * Validates the status-worker wire payload. The body is operator telemetry
 * (component id, probe detail, public status URL) — never user content.
 */
export function parseStatusIncidentEvent(
	value: unknown,
): ParseStatusIncidentEventResult {
	if (!isRecord(value)) return { ok: false, error: 'invalid-payload' }
	const topic = readNonEmptyString(value.event)
	if (
		topic !== statusIncidentOpenedTopic &&
		topic !== statusIncidentResolvedTopic
	) {
		return { ok: false, error: 'invalid-event' }
	}
	if (!isRecord(value.incident)) return { ok: false, error: 'invalid-incident' }
	const component = readNonEmptyString(value.incident.component)
	if (!component || !componentIdPattern.test(component)) {
		return { ok: false, error: 'invalid-component' }
	}
	const detail = readDetail(value.incident.detail)
	if (!detail.ok) return { ok: false, error: 'invalid-detail' }
	const startedAt = readIsoTimestamp(value.incident.started_at)
	if (!startedAt) return { ok: false, error: 'invalid-started-at' }
	const statusUrl = readHttpsUrl(value.status_url)
	if (!statusUrl) return { ok: false, error: 'invalid-status-url' }

	if (topic === statusIncidentOpenedTopic) {
		if (value.incident.resolved_at !== undefined) {
			return { ok: false, error: 'unexpected-resolved-at' }
		}
		return {
			ok: true,
			event: buildStatusIncidentOpenedEvent({
				component,
				detail: detail.detail,
				startedAt,
				statusUrl,
			}),
		}
	}

	const resolvedAt = readIsoTimestamp(value.incident.resolved_at)
	if (!resolvedAt) return { ok: false, error: 'invalid-resolved-at' }
	return {
		ok: true,
		event: buildStatusIncidentResolvedEvent({
			component,
			detail: detail.detail,
			startedAt,
			resolvedAt,
			statusUrl,
		}),
	}
}
