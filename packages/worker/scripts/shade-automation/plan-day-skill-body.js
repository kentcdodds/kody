/**
 * Daily planner for shade automation — saved as Kody skill shade-automation-plan-day.
 * Computes poll window (minutes from midnight, America/Denver) from Open-Meteo sunrise/sunset. Idempotent per calendar day.
 */
async () => {
	const TZ = 'America/Denver'
	const lat = 40.42823
	const lon = -111.78912
	const now = new Date()
	const dateKey = new Intl.DateTimeFormat('en-CA', {
		timeZone: TZ,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(now)
	const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=sunrise,sunset&timezone=${encodeURIComponent(TZ)}&start_date=${dateKey}&end_date=${dateKey}`
	let startMin = 6 * 60 + 30
	let endMin = 21 * 60
	let sunrise = null
	let sunset = null
	try {
		const res = await fetch(url)
		const j = await res.json()
		sunrise = j.daily?.sunrise?.[0] ?? null
		sunset = j.daily?.sunset?.[0] ?? null
		const parseMin = (iso) => {
			const d = new Date(iso)
			return (
				Number.parseInt(
					new Intl.DateTimeFormat('en-US', {
						timeZone: TZ,
						hour: 'numeric',
						hour12: false,
					}).format(d),
					10,
				) *
					60 +
				Number.parseInt(
					new Intl.DateTimeFormat('en-US', {
						timeZone: TZ,
						minute: '2-digit',
					}).format(d),
					10,
				)
			)
		}
		if (sunrise && sunset) {
			startMin = parseMin(sunrise) - 60
			endMin = parseMin(sunset) + 60
		}
	} catch {
		// defaults above
	}
	startMin = Math.max(6 * 60, startMin)
	endMin = Math.min(22 * 60, Math.max(endMin, startMin + 90))
	const window = JSON.stringify({
		date: dateKey,
		startMin,
		endMin,
		sunrise,
		sunset,
	})
	await codemode.value_set({
		name: 'shadeAutomationPollWindow',
		value: window,
		scope: 'user',
		description: 'Daily shade poll window (Denver local minutes from midnight)',
	})
	return { ok: true, window: JSON.parse(window) }
}
