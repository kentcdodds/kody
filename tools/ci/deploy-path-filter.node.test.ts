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
})
