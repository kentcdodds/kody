import { ensureGuideCatalogModules } from './build-guide-catalog-modules.ts'

/**
 * Vitest global setup: `#worker/guide-catalog-modules.ts` dynamically
 * imports the pre-generated guide catalog module from
 * `packages/worker/src/generated/`, a gitignored build artifact. Generating
 * it here keeps `vitest run` working on a fresh clone. The generator is
 * stamped, so warm runs cost ~0 ms.
 */
export default async function setup() {
	await ensureGuideCatalogModules()
}
