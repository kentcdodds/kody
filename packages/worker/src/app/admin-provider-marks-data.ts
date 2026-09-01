import { type AdminProviderMarksLoaderData } from '#universal/loader-data.ts'
import {
	buildProviderMarkLogoPath,
	listPlatformProviderMarks,
	providerMarkAliasTokens,
} from '#worker/integrations/provider-marks.ts'

export async function loadAdminProviderMarksData(
	env: Pick<Env, 'APP_DB'>,
): Promise<AdminProviderMarksLoaderData> {
	const marks = await listPlatformProviderMarks({ db: env.APP_DB })
	return {
		ok: true,
		marks: marks.map((mark) => ({
			slug: mark.slug,
			label: mark.label,
			aliases: providerMarkAliasTokens(mark),
			logoPath: buildProviderMarkLogoPath(mark),
			createdAt: mark.createdAt,
			updatedAt: mark.updatedAt,
		})),
	}
}
