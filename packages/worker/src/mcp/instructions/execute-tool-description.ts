export const executeToolDescription = `Run one ephemeral ESM module in the signed-in user's isolated Kody account. The module can read or write that account's data and connected services (for example send email, persist packages, or call a connected API). Discover the capability with search and adapt that entity's execute snippet. Prefer a package over rewriting helpers. Project large results before returning (e.g. { id, subject, snippet }). Same user and \`code\` graph reuse one isolate for the UTC day — vary args via \`params\`.

import { kody } from 'kody:runtime'
export default async function main(params) {
  return await kody.capability_id(params)
}`
