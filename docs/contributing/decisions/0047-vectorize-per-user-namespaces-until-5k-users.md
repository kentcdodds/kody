# 0047: One Vectorize index with per-user namespaces until 5,000 users

- **Status:** accepted
- **Date:** 2026-09-02

## Context

Every user-owned vector (memories, jobs, saved packages) lives in one Vectorize
index, `CAPABILITY_VECTOR_INDEX`, inside a namespace named by the account's
64-character `stable_user_id`
(`packages/worker/src/vectorize/vector-namespaces.ts`). Builtin capability
vectors use the reserved `__kody_builtin__` namespace. Namespace filtering is
the primary isolation boundary and the `userId` metadata filter is defense in
depth (see
[Data storage](../architecture/data-storage.md#vectorize-metadata-contracts)).

Cloudflare caps a Vectorize index at 50,000 namespaces on Workers Paid
(https://developers.cloudflare.com/vectorize/platform/limits/). With one
namespace per account, the 50,001st user's first embedding upsert fails. That
failure is silent today: it surfaces as `saved_package_search_index_debt`
accumulating and the reindex lane retrying forever, not as an alert.

The 2026-09-01 launch audit flagged the ceiling. The account count at the time
was 172, and the next agent to touch search would otherwise propose a sharding
scheme (or a switch to metadata-only filtering) as part of an unrelated change.

## Decision

Keep one index with one namespace per user, and do not shard, split, or move to
metadata-only filtering before the platform reaches 5,000 person accounts.

When sharding becomes necessary, the shape is fixed now so it is not re-derived:
N indexes bound as `CAPABILITY_VECTOR_INDEX_0..N-1`, an account's index chosen
by the first hex byte of `stable_user_id` modulo N, the same per-user namespace
inside the chosen index, and `__kody_builtin__` duplicated into every index so a
single search still hits builtins plus the caller's namespace with one query per
index. Existing accounts migrate by reindex
(`POST /__maintenance/reindex-capabilities` with `force: true`), which is
already the recovery path for Vectorize data loss. Do not drop namespace
isolation in favour of a shared namespace with `userId` metadata: namespace
filtering is applied before the similarity search and is the isolation boundary
the security model relies on.

## Consequences

- Search stays one Vectorize query per call, and account deletion stays one
  `deleteByIds` per user.
- Nothing warns as the namespace count grows. `adminUserList.total` is the
  proxy; the reviewer of any PR that adds a new per-user vector kind checks it.
- Revisit when `adminUserList` reports 5,000 person accounts, or earlier if
  Cloudflare lowers the per-index namespace limit or an upsert fails with a
  namespace-limit error. At that point implement the shape above; the budget for
  the change is one migration lane plus one reindex pass, not a redesign.
