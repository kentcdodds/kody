import { expect, test } from 'vitest'
import { classifyProductionDeployPaths } from './deploy-path-filter.ts'

test('production deploy path filter selects worker scripts only when their sources change', () => {
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
		deployJobs: false,
		deployHighlight: false,
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

	expect(classifyProductionDeployPaths([])).toEqual({
		deployMain: true,
		deployPlatform: true,
		deployRuntime: true,
		deployJobs: true,
		deployHighlight: true,
	})

	// MCP + fetch-gateway run on platform and runtime; do not skip those
	// scripts the way a UI-only origin path would.
	expect(
		classifyProductionDeployPaths([
			'docs/guides/what-is-kody.md',
			'packages/worker/src/mcp/index.ts',
		]),
	).toEqual({
		deployMain: true,
		deployPlatform: true,
		deployRuntime: true,
		deployJobs: false,
		deployHighlight: false,
	})
	expect(
		classifyProductionDeployPaths([
			'docs/use/secrets-and-values.md',
			'packages/worker/src/mcp/fetch-gateway.ts',
			'packages/worker/src/mcp/fetch-gateway.node.test.ts',
		]),
	).toEqual({
		deployMain: true,
		deployPlatform: true,
		deployRuntime: true,
		deployJobs: false,
		deployHighlight: false,
	})
	expect(
		classifyProductionDeployPaths([
			'packages/worker/src/app/canonical-host.ts',
			'packages/worker/src/app/package-app-origin.ts',
		]),
	).toEqual({
		deployMain: true,
		deployPlatform: true,
		deployRuntime: true,
		deployJobs: false,
		deployHighlight: false,
	})

	// Runtime-token wiring in deploy.yml must not upload jobs/highlight.
	expect(
		classifyProductionDeployPaths(['.github/workflows/deploy.yml']),
	).toEqual({
		deployMain: true,
		deployPlatform: true,
		deployRuntime: true,
		deployJobs: false,
		deployHighlight: false,
	})
	expect(
		classifyProductionDeployPaths([
			'.github/workflows/deploy.yml',
			'docs/contributing/environment-variables.md',
			'docs/contributing/setup-manifest.md',
			'tools/ci/sync-worker-secrets.node.test.ts',
			'tools/ci/sync-worker-secrets.ts',
		]),
	).toEqual({
		deployMain: true,
		deployPlatform: true,
		deployRuntime: true,
		deployJobs: false,
		deployHighlight: false,
	})

	expect(
		classifyProductionDeployPaths([
			'packages/backup-control-plane/worker.ts',
			'tools/disaster-recovery/readiness-assessment.ts',
			'docs/contributing/disaster-recovery.md',
		]),
	).toEqual({
		deployMain: false,
		deployPlatform: false,
		deployRuntime: false,
		deployJobs: false,
		deployHighlight: false,
	})
	expect(
		classifyProductionDeployPaths([
			'packages/backup-control-plane/worker.ts',
			'packages/shared/src/backup-full-manifest.ts',
			'tools/disaster-recovery/readiness-assessment.ts',
			'docs/contributing/disaster-recovery.md',
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
			'packages/worker/src/origin-handler.ts',
			'packages/worker/src/platform-worker.ts',
			'packages/worker/src/runtime-worker.ts',
			'packages/worker/src/app/canonical-host.ts',
			'docs/contributing/architecture/request-lifecycle.md',
		]),
	).toEqual({
		deployMain: true,
		deployPlatform: true,
		deployRuntime: true,
		deployJobs: false,
		deployHighlight: false,
	})

	expect(
		classifyProductionDeployPaths(['packages/jobs-worker/src/index.ts']),
	).toEqual({
		deployMain: false,
		deployPlatform: false,
		deployRuntime: false,
		deployJobs: true,
		deployHighlight: false,
	})
	expect(
		classifyProductionDeployPaths([
			'packages/jobs-worker/src/index.ts',
			'packages/worker/src/app/handlers/home.ts',
		]),
	).toEqual({
		deployMain: true,
		deployPlatform: false,
		deployRuntime: false,
		deployJobs: true,
		deployHighlight: false,
	})
	expect(
		classifyProductionDeployPaths(['packages/shared/src/jobs/rpc.ts']),
	).toEqual({
		deployMain: true,
		deployPlatform: false,
		deployRuntime: false,
		deployJobs: true,
		deployHighlight: false,
	})
	expect(
		classifyProductionDeployPaths([
			'packages/worker/universal/highlighted-code.ts',
		]),
	).toEqual({
		deployMain: true,
		deployPlatform: false,
		deployRuntime: false,
		deployJobs: false,
		deployHighlight: true,
	})
	expect(
		classifyProductionDeployPaths(['tools/ci/deploy-path-filter.ts']),
	).toEqual({
		deployMain: true,
		deployPlatform: true,
		deployRuntime: true,
		deployJobs: false,
		deployHighlight: false,
	})
})
