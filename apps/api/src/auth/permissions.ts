// Permission catalog — compile-time const tuple.
//
// Every permission is shaped `${domain}:${action}` (or
// `${domain}:${subdomain}:${action}` for nested namespaces). Adding a new
// permission requires touching this file and `role-permissions.ts`; nothing
// downstream may invent permission strings at runtime.

export const PERMISSIONS = [
  // Org
  'org:read',
  'org:write',
  'org:admin',
  // Event
  'event:read',
  'event:write',
  'event:publish',
  'event:delete',
  'event:members:manage',
  // Media
  'media:upload',
  'media:read',
  'media:delete',
  // Search
  'search:bib',
  'search:name',
  'search:face',
  'search:text',
  // Commerce
  'commerce:read_orders',
  'commerce:refund',
  // Compliance
  'compliance:read_audit',
  'compliance:takedown',
  // Admin
  'admin:moderate',
  'admin:override',
  // Integrations (F4.1) — manage per-org connector configs/credentials.
  'integrations:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// Structural guard — every Permission must be `${string}:${string}` (i.e.
// have at least one colon). If a future entry violates this, the assignment
// below fails at compile time.
type EnforceColonShape<P extends string> = P extends `${string}:${string}` ? P : never;
type _CheckShape = EnforceColonShape<Permission>;
const _shapeCheck: _CheckShape = '' as Permission;
void _shapeCheck;

export const isPermission = (value: string): value is Permission =>
  (PERMISSIONS as readonly string[]).includes(value);
