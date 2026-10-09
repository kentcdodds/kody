import { type RouteLoader } from '#client/client-router.tsx'
import {
	LazyAccountRoute,
	accountArea,
	lazyRouteLoader,
} from '#client/lazy-route.tsx'
import { routePattern } from '#universal/route-pattern.ts'
import { routes } from '#universal/routes.ts'
import { profileRouteLoader } from './profile.tsx'

export const orgAccountClientLoaders: Record<string, RouteLoader> = {
	[routePattern(routes.orgActivity)]: lazyRouteLoader(
		accountArea,
		(module) => module.accountActivityRouteLoader,
	),
	[routePattern(routes.orgConnections)]: lazyRouteLoader(
		accountArea,
		(module) => module.accountConnectionsRouteLoader,
	),
	[routePattern(routes.orgEmail)]: lazyRouteLoader(
		accountArea,
		(module) => module.accountEmailRouteLoader,
	),
	[routePattern(routes.orgIntegrations)]: lazyRouteLoader(
		accountArea,
		(module) => module.accountIntegrationsRouteLoader,
	),
	[routePattern(routes.orgJobs)]: lazyRouteLoader(
		accountArea,
		(module) => module.accountJobsRouteLoader,
	),
	[routePattern(routes.orgMcpServers)]: lazyRouteLoader(
		accountArea,
		(module) => module.accountMcpServersRouteLoader,
	),
	[routePattern(routes.orgMemories)]: lazyRouteLoader(
		accountArea,
		(module) => module.accountMemoriesRouteLoader,
	),
	[routePattern(routes.orgPackages)]: profileRouteLoader,
	[routePattern(routes.orgSecretProviders)]: lazyRouteLoader(
		accountArea,
		(module) => module.accountSecretProvidersRouteLoader,
	),
	[routePattern(routes.orgSecrets)]: lazyRouteLoader(
		accountArea,
		(module) => module.accountSecretsRouteLoader,
	),
	[routePattern(routes.orgShared)]: lazyRouteLoader(
		accountArea,
		(module) => module.accountSharedRouteLoader,
	),
	[routePattern(routes.orgValues)]: lazyRouteLoader(
		accountArea,
		(module) => module.accountValuesRouteLoader,
	),
	[routePattern(routes.orgWaiting)]: lazyRouteLoader(
		accountArea,
		(module) => module.accountWaitingRouteLoader,
	),
	[routePattern(routes.orgWebhooks)]: lazyRouteLoader(
		accountArea,
		(module) => module.accountWebhooksRouteLoader,
	),
	[routePattern(routes.orgWorkflows)]: lazyRouteLoader(
		accountArea,
		(module) => module.accountWorkflowsRouteLoader,
	),
	[routePattern(routes.accountOrganizationsNew)]: lazyRouteLoader(
		accountArea,
		(module) => module.accountOrganizationsNewRouteLoader,
	),
	[routePattern(routes.accountOrganizations)]: lazyRouteLoader(
		accountArea,
		(module) => module.accountOrganizationsRouteLoader,
	),
}

export const orgAccountClientRoutes = {
	[routePattern(routes.orgActivity)]: (
		<LazyAccountRoute render={(module) => <module.AccountActivityRoute />} />
	),
	[routePattern(routes.orgConnections)]: (
		<LazyAccountRoute render={(module) => <module.AccountConnectionsRoute />} />
	),
	[routePattern(routes.orgEmail)]: (
		<LazyAccountRoute render={(module) => <module.AccountEmailRoute />} />
	),
	[routePattern(routes.orgIntegrations)]: (
		<LazyAccountRoute
			render={(module) => <module.AccountIntegrationsRoute />}
		/>
	),
	[routePattern(routes.orgJobs)]: (
		<LazyAccountRoute render={(module) => <module.AccountJobsRoute />} />
	),
	[routePattern(routes.orgMcpServers)]: (
		<LazyAccountRoute render={(module) => <module.AccountMcpServersRoute />} />
	),
	[routePattern(routes.orgMemories)]: (
		<LazyAccountRoute render={(module) => <module.AccountMemoriesRoute />} />
	),
	[routePattern(routes.orgPackages)]: (
		<LazyAccountRoute
			render={(module) => <module.AccountRepositoriesRoute />}
		/>
	),
	[routePattern(routes.orgSecretProviders)]: (
		<LazyAccountRoute
			render={(module) => <module.AccountSecretProvidersRoute />}
		/>
	),
	[routePattern(routes.orgSecrets)]: (
		<LazyAccountRoute render={(module) => <module.AccountSecretsRoute />} />
	),
	[routePattern(routes.orgShared)]: (
		<LazyAccountRoute render={(module) => <module.AccountSharedRoute />} />
	),
	[routePattern(routes.orgValues)]: (
		<LazyAccountRoute render={(module) => <module.AccountValuesRoute />} />
	),
	[routePattern(routes.orgWaiting)]: (
		<LazyAccountRoute render={(module) => <module.AccountWaitingRoute />} />
	),
	[routePattern(routes.orgWebhooks)]: (
		<LazyAccountRoute render={(module) => <module.AccountWebhooksRoute />} />
	),
	[routePattern(routes.orgWorkflows)]: (
		<LazyAccountRoute render={(module) => <module.AccountWorkflowsRoute />} />
	),
	[routePattern(routes.accountOrganizationsNew)]: (
		<LazyAccountRoute
			render={(module) => <module.AccountOrganizationsNewRoute />}
		/>
	),
	[routePattern(routes.accountOrganizations)]: (
		<LazyAccountRoute
			render={(module) => <module.AccountOrganizationsRoute />}
		/>
	),
}
