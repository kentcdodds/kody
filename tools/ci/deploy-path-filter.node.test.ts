import { expect, test } from 'vitest'
import { classifyProductionDeployPaths } from './deploy-path-filter.ts'

test('production deploy path filter selects Durable Object scripts only when needed', () => {
	expect(
		classifyProductionDeployPaths([
			'packages/worker/src/blog/posts/your-assistants-home.md',
			'packages/worker/client/routes/blog.tsx',
			'packages/worker/public/styles.css',
		]),
	).toEqual({
		deployMain: true,
		deployPlatform: false,
		deployRuntime: false,
		deployJobs: false,
		deployHighlight: false,
	})

	expect(
		classifyProductionDeployPaths(['docs/guides/what-is-kody.md']),
	).toEqual({
		deployMain: true,
		deployPlatform: true,
		deployRuntime: false,
		deployJobs: false,
		deployHighlight: false,
	})
	expect(
		classifyProductionDeployPaths([
			'docs/guides/what-is-kody.md',
			'packages/worker/src/blog/posts/your-assistants-home.md',
			'packages/worker/client/routes/blog.tsx',
		]),
	).toEqual({
		deployMain: true,
		deployPlatform: true,
		deployRuntime: false,
		deployJobs: false,
		deployHighlight: false,
	})
	expect(
		classifyProductionDeployPaths(['packages/worker/src/guides/catalog.ts']),
	).toEqual({
		deployMain: true,
		deployPlatform: true,
		deployRuntime: false,
		deployJobs: false,
		deployHighlight: false,
	})

	expect(
		classifyProductionDeployPaths([
			'packages/worker/src/app/handlers/package-app.ts',
		]),
	).toEqual({
		deployMain: true,
		deployPlatform: true,
		deployRuntime: true,
		deployJobs: true,
		deployHighlight: true,
	})
	expect(
		classifyProductionDeployPaths(['packages/worker/src/app/handlers/home.ts']),
	).toEqual({
		deployMain: true,
		deployPlatform: false,
		deployRuntime: false,
		deployJobs: false,
		deployHighlight: false,
	})
	expect(
		classifyProductionDeployPaths(['packages/highlight-worker/src/index.ts']),
	).toEqual({
		deployMain: false,
		deployPlatform: false,
		deployRuntime: false,
		deployJobs: false,
		deployHighlight: true,
	})
	expect(
		classifyProductionDeployPaths([
			'packages/highlight-worker/src/index.ts',
			'packages/worker/client/routes/blog-post.tsx',
		]),
	).toEqual({
		deployMain: true,
		deployPlatform: false,
		deployRuntime: false,
		deployJobs: false,
		deployHighlight: true,
	})
	expect(
		classifyProductionDeployPaths([
			'docs/guides/what-is-kody.md',
			'packages/worker/src/mcp/index.ts',
		]),
	).toEqual({
		deployMain: true,
		deployPlatform: true,
		deployRuntime: true,
		deployJobs: true,
		deployHighlight: true,
	})

	const noFleet = {
		deployMain: false,
		deployPlatform: false,
		deployRuntime: false,
		deployJobs: false,
		deployHighlight: false,
	}
	expect(
		classifyProductionDeployPaths([
			'packages/backup-control-plane/backup-policy.ts',
			'tools/disaster-recovery/readiness-assessment.ts',
			'docs/contributing/disaster-recovery.md',
			'docs/contributing/environment-variables.md',
		]),
	).toEqual(noFleet)
	expect(
		classifyProductionDeployPaths([
			'packages/shared/src/backup-full-manifest.ts',
		]),
	).toEqual({
		deployMain: true,
		deployPlatform: false,
		deployRuntime: false,
		deployJobs: false,
		deployHighlight: false,
	})
	// #1994-shaped backup change: DR plane + shared manifest + contributing
	// docs. Origin must pick up the parser; highlight/jobs must not redeploy.
	expect(
		classifyProductionDeployPaths([
			'docs/contributing/disaster-recovery.md',
			'docs/contributing/environment-variables.md',
			'packages/backup-control-plane/backup-policy.ts',
			'packages/shared/src/backup-full-manifest.ts',
			'packages/shared/src/backup-full-manifest.node.test.ts',
			'tools/disaster-recovery/canonical-readiness-signatures.node.test.ts',
			'tools/disaster-recovery/trusted-d1-restore-identities.json',
		]),
	).toEqual({
		deployMain: true,
		deployPlatform: false,
		deployRuntime: false,
		deployJobs: false,
		deployHighlight: false,
	})
	expect(
		classifyProductionDeployPaths([
			'packages/backup-control-plane/worker.ts',
			'packages/highlight-worker/src/index.ts',
		]),
	).toEqual({
		deployMain: false,
		deployPlatform: false,
		deployRuntime: false,
		deployJobs: false,
		deployHighlight: true,
	})
})
