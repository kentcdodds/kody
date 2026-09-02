import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import { loadSignupModeSetting } from '#worker/signup-mode-setting.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import { signupModeSettingSchema } from './signup-mode-shared.ts'

const outputSchema = z.object({
	signupMode: signupModeSettingSchema,
})

export const adminSignupModeGetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminSignupModeGet',
		description:
			'Read the runtime signup mode (invite, open, or waitlist), whether it comes from the KV override or the SIGNUP_MODE Worker var default, and who last changed it. Admin-only platform setting; never returns user content.',
		keywords: [
			'admin',
			'signup',
			'signup mode',
			'invite',
			'waitlist',
			'open signup',
		],
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminSignupModeGet',
				async () => ({
					signupMode: await loadSignupModeSetting(ctx.env),
				}),
				{
					successReason: ({ signupMode }) =>
						`mode=${signupMode.mode};source=${signupMode.source}`,
				},
			)
		},
	},
)
