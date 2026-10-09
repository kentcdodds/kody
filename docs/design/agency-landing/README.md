# Business landing page

The production page lives at `/for/business`. Run `npm run dev:ensure` and open
that path on the reported local origin.

The [research notes](./research.md) record the design direction. The page
targets business teams and agencies, with illustrative client names and workflow
data. The pre-sale copy assumes the finished Teams experience.

The implementation is in `packages/worker/client/routes/business.tsx`, with
scoped styles, workflow examples, and a separate animated hero. Five transparent
WebP layers float independently, with SVG connections drawn in code. Motion
respects reduced-motion settings and pauses offscreen or in hidden tabs.

Get started opens onboarding with `business=true` and business campaign
attribution. Existing first-touch attribution rules apply. This does not add a
business onboarding flow or relabel existing accounts.
