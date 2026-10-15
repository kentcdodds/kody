import { z } from 'zod'
import { followStatuses, followTargetKinds } from '#worker/follow/types.ts'

export const followViewSchema = z.object({
	name: z.string().describe('Target @handle/name.'),
	kind: z.enum(followTargetKinds),
	status: z.enum(followStatuses),
	created_at: z.string(),
	paused_at: z.string().nullable(),
	last_delivery_skip_reason: z
		.string()
		.nullable()
		.describe(
			'Set when a delivery was skipped before the handler ran, for example zero_credits.',
		),
})
