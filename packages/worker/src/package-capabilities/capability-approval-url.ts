import { joinOriginAndEncodedPath } from '@kody-internal/shared/account-secret-route.ts'
import { routes } from '#universal/routes.ts'

export function buildPackageCapabilityApprovalUrl(input: {
	baseUrl: string
	username: string
	kodyId: string
}): string {
	return joinOriginAndEncodedPath(
		input.baseUrl,
		routes.communityPackageApproveCapabilities.href({
			username: input.username,
			kodyId: input.kodyId,
		}),
	)
}
