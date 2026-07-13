import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { assertWithinEntitlement } from '#worker/entitlements/service.ts'
import { buildSavedPackageEmbedText } from '#worker/package-registry/embed.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import {
	assertKodyDescriptionLength,
	kodyPackageIdPattern,
} from '#worker/package-registry/types.ts'
import { getMcpUserPackageScope } from '#worker/package-registry/user-scope.ts'
import { upsertSavedPackageVector } from '#worker/package-registry/vectorize.ts'
import { ensureEntitySource } from '#worker/repo/source-service.ts'
import { syncArtifactSourceSnapshot } from '#worker/repo/source-sync.ts'

export const defaultStubPackageDescription =
	'Stub package created for a clone-edit-push workflow. Replace this description on the first real publish.'

export function buildStubPackageFiles(input: {
	name: string
	kodyId: string
	description: string
}): Record<string, string> {
	const packageJson = {
		name: input.name,
		private: true,
		exports: { '.': './src/index.ts' },
		kody: {
			id: input.kodyId,
			description: input.description,
		},
	}
	return {
		'package.json': `${JSON.stringify(packageJson, null, '\t')}\n`,
		'README.md': [
			`# ${input.name}`,
			'',
			'## Intent',
			'',
			input.description,
			'',
			'Update this Intent section to capture the user-defined goal before',
			'publishing real package source.',
			'',
		].join('\n'),
		'src/index.ts': [
			'export default async function main() {',
			"\treturn { status: 'stub' }",
			'}',
			'',
		].join('\n'),
	}
}

export async function createStubSavedPackage(input: {
	env: Env
	baseUrl: string
	user: McpUserContext
	kodyId: string
	description?: string
}) {
	const kodyId = input.kodyId.trim()
	if (!kodyPackageIdPattern.test(kodyId)) {
		throw new Error(
			`Cannot create package: kody_id "${input.kodyId}" must be lower-kebab-case (for example "my-package").`,
		)
	}
	await assertWithinEntitlement({
		db: input.env.APP_DB,
		userId: input.user.userId,
		email: input.user.email,
		resource: 'saved_packages',
	})
	const scope = await getMcpUserPackageScope(input.env.APP_DB, input.user)
	const name = `@${scope}/${kodyId}`
	const description = input.description?.trim() || defaultStubPackageDescription
	assertKodyDescriptionLength(description)
	const files = buildStubPackageFiles({ name, kodyId, description })
	const packageJsonContent = files['package.json']
	if (!packageJsonContent) {
		throw new Error('Stub package files are missing package.json.')
	}
	const manifest = parseAuthoredPackageJson({
		content: packageJsonContent,
		manifestPath: 'package.json',
		expectedPackageScope: scope,
	})
	const packageId = crypto.randomUUID()
	const ensuredSource = await ensureEntitySource({
		db: input.env.APP_DB,
		env: input.env,
		userId: input.user.userId,
		entityKind: 'package',
		entityId: packageId,
		sourceRoot: '/',
		manifestPath: 'package.json',
		requirePersistence: true,
	})
	await syncArtifactSourceSnapshot({
		env: input.env,
		userId: input.user.userId,
		baseUrl: input.baseUrl,
		sourceId: ensuredSource.id,
		bootstrapAccess: ensuredSource.bootstrapAccess ?? null,
		files,
	})
	const now = new Date().toISOString()
	await insertSavedPackage(input.env.APP_DB, {
		id: packageId,
		user_id: input.user.userId,
		name: manifest.name,
		kody_id: manifest.kody.id,
		description: manifest.kody.description,
		tags_json: JSON.stringify(manifest.kody.tags ?? []),
		search_text: manifest.kody.searchText ?? null,
		source_id: ensuredSource.id,
		has_app: 0,
		hidden: 0,
		created_at: now,
		updated_at: now,
	})
	await upsertSavedPackageVector(input.env, {
		packageId,
		userId: input.user.userId,
		embedText: buildSavedPackageEmbedText(manifest),
	})
	await refreshSavedPackageProjection({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.user.userId,
		packageId,
		sourceId: ensuredSource.id,
	})
	return { packageId, kodyId: manifest.kody.id, name: manifest.name }
}
