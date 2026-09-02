import { z } from 'zod'
import { signupModes } from '#universal/signup-mode.ts'

export const signupModeSettingSchema = z.object({
	mode: z.enum(signupModes),
	source: z.enum(['kv', 'env']),
	envDefault: z.enum(signupModes),
	updatedAt: z.string().nullable(),
	updatedBy: z.string().nullable(),
})

export const signupModeInputSchema = z.object({
	mode: z
		.enum(signupModes)
		.describe('Signup gating mode: invite, open, or waitlist.'),
})
