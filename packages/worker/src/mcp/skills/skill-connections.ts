import { z } from 'zod'
import { connectionSelectionSchema } from '#mcp/connections/auth-spec.ts'

export const skillConnectionBindingSchema = z.object({
	provider: z.string().min(1),
	selection: connectionSelectionSchema,
	description: z.string().optional(),
	required: z.boolean().default(true),
})

export type SkillConnectionBinding = z.infer<
	typeof skillConnectionBindingSchema
>

export function parseSkillConnectionBindings(
	raw: string | null,
): Array<SkillConnectionBinding> | null {
	if (!raw) return null
	try {
		const value = JSON.parse(raw) as unknown
		return z.array(skillConnectionBindingSchema).parse(value)
	} catch {
		return null
	}
}

export function normalizeSkillConnectionBindings(
	value: Array<SkillConnectionBinding> | undefined,
) {
	if (!value || value.length === 0) return null
	return z.array(skillConnectionBindingSchema).parse(value)
}
