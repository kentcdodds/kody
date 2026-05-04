import { unleashedRequest } from './internal/request.ts'

const defaultReason =
	'Rebooting the master access point. The entire Unleashed network will briefly go offline while it restarts.'

/** Reboot the master access point (the Unleashed controller). */
export async function rebootController(input: { reason?: string } = {}) {
	const result = await unleashedRequest({
		action: 'docmd',
		comp: 'system',
		xmlBody: "<xcmd cmd='reboot' tag='system'/>",
		reason: input.reason ?? defaultReason,
	})
	return result
}
