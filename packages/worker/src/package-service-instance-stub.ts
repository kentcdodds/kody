import { DurableObject } from 'cloudflare:workers'

/**
 * Temporary export so production `kody-runtime` can drop the transferred
 * `PackageServiceInstance` binding. Existing Durable Objects still require
 * the class to be exported (Cloudflare error 10064). Remove this module when
 * top-level runtime-worker tag `v2` `deleted_classes` lands.
 */
export class PackageServiceInstance extends DurableObject<Env> {}
