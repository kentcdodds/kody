/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type RemixNode } from "remix/ui";
import { type Action } from "remix/router";
import { getAppBaseUrl } from "#app/app-base-url.ts";
import { OgHead } from "#app/ssr-document.tsx";
import { handleFrameRequest } from "#app/frame-registry.ts";
import "#app/frame-registrations.ts";
import { renderAppPage } from "#app/ssr-render.tsx";
import { type routes } from "#app/routes.ts";
import { publicOgPages } from "#worker/og/pages.ts";

export function createCommunityHandler(env: Env) {
  return {
    middleware: [],
    async handler({ request }) {
      const frameResponse = await handleFrameRequest(
        request,
        env,
        new URL(request.url).pathname,
      );
      if (frameResponse) return frameResponse;

      const origin = getAppBaseUrl({ env, requestUrl: request.url });
      const page = publicOgPages.community;

      return renderAppPage({
        request,
        env,
        title: "Community packages",
        extraHead: (
          <OgHead
            title={page.ogTitle}
            description={page.ogDescription}
            canonicalUrl={`${origin}${page.path}`}
            ogImageUrl={`${origin}/og/community.png`}
          />
        ) as RemixNode,
      });
    },
  } satisfies Action<typeof routes.community>;
}

export { createCommunityApiHandler } from "#app/community-api.ts";
