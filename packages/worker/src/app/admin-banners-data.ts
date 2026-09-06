import { type AdminBannersLoaderData } from '#universal/loader-data.ts'
import { listSiteBannersForAdmin } from '#worker/site-banners/service.ts'

export async function loadAdminBannersData(
	env: Env,
): Promise<AdminBannersLoaderData> {
	return {
		ok: true,
		banners: await listSiteBannersForAdmin(env.APP_DB),
	}
}
