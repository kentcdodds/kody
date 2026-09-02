import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { signupModes } from '#universal/signup-mode.ts'
import {
	setSignupModeSetting,
	SignupModeOpenWithoutTurnstileError,
	SignupModeStaleWriteError,
} from '#worker/signup-mode-setting.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import {
	signupModeInputSchema,
	signupModeSettingSchema,
} from './signup-mode-shared.ts'

const outputSchema = z.object({
	previousMode: z.enum(signupModes),
	signupMode: signupModeSettingSchema,
})

export const adminSignupModeSetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminSignupModeSet',
		description:
			'Set the runtime signup mode stored in platform KV. Requires expectedCurrentMode matching the stored mode (optimistic concurrency). Open signup is refused unless both Turnstile keys are configured. Admin-only; never returns user content.',
		keywords: [
			'admin',
			'signup',
			'signup mode',
			'invite',
			'waitlist',
			'open signup',
			'toggle',
		],
		inputSchema: signupModeInputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminSignupModeSet',
				async () => {
					const user = requireMcpUser(ctx.callerContext)
					try {
						const result = await setSignupModeSetting({
							env: ctx.env,
							mode: args.mode,
							expectedCurrentMode: args.expectedCurrentMode,
							updatedBy: user.userId,
							actorEmail: user.email,
							path: '/mcp',
						})
						return {
							previousMode: result.previous.mode,
							signupMode: result.current,
						}
					} catch (error) {
						if (
							error instanceof SignupModeOpenWithoutTurnstileError ||
							error instanceof SignupModeStaleWriteError
						) {
							throw new McpCallerError(error.message)
						}
						throw error
					}
				},
				{
					successReason: ({ previousMode, signupMode }) =>
						`old=${previousMode};new=${signupMode.mode}`,
				},
			)
		},
	},
)
