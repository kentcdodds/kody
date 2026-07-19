import { type AdminFeatureFlagsLoaderData } from '#app/loader-data.ts'
import { listFeatureFlagsForAdmin } from '#worker/feature-flags/service.ts'

export async function loadAdminFeatureFlagsData(
	env: Env,
): Promise<AdminFeatureFlagsLoaderData> {
	return {
		ok: true,
		featureFlags: await listFeatureFlagsForAdmin(env.APP_DB),
	}
}
