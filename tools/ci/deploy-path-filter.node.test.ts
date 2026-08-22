import { expect, test } from 'vitest'
import { classifyProductionDeployPaths } from './deploy-path-filter.ts'

test('guide body, blog post, and client UI changes skip Durable Object scripts', () => {
	expect(
		classifyProductionDeployPaths([
			'docs/guides/what-is-kody.md',
			'packages/worker/src/blog/posts/your-assistants-home.md',
			'packages/worker/client/routes/blog.tsx',
			'packages/worker/public/styles.css',
		]),
	).toEqual({
		deployAppSurface: true,
		deployMain: false,
		deployRuntime: false,
		deployJobs: false,
	})
})

test('package-app handlers still deploy the Durable Object scripts', () => {
	expect(
		classifyProductionDeployPaths([
			'packages/worker/src/app/handlers/package-app.ts',
		]),
	).toEqual({
		deployAppSurface: true,
		deployMain: true,
		deployRuntime: true,
		deployJobs: true,
	})
	expect(
		classifyProductionDeployPaths(['packages/worker/src/app/handlers/home.ts']),
	).toEqual({
		deployAppSurface: true,
		deployMain: false,
		deployRuntime: false,
		deployJobs: false,
	})
})

test('MCP or shared worker changes still deploy the Durable Object scripts', () => {
	expect(
		classifyProductionDeployPaths([
			'docs/guides/what-is-kody.md',
			'packages/worker/src/mcp/index.ts',
		]),
	).toEqual({
		deployAppSurface: true,
		deployMain: true,
		deployRuntime: true,
		deployJobs: true,
	})
	expect(
		classifyProductionDeployPaths(['packages/worker/src/guides/catalog.ts']),
	).toEqual({
		deployAppSurface: true,
		deployMain: true,
		deployRuntime: true,
		deployJobs: true,
	})
})
