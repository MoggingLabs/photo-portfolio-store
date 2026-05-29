// Static role -> permissions map. O(1) lookup, no DB hit for role-only checks.
//
// Role scopes (high-level intent):
// - superadmin: platform-wide root. Holds every permission.
// - admin: org-level admin. Manages orgs, events, members, refunds; cannot
//   touch compliance takedowns or platform overrides.
// - organizer: runs a specific event. Reads/writes/publishes the event,
//   manages event members, sees orders for splits. No deletes.
// - photographer: uploads + manages own media; sees orders for splits.
// - assistant: scoped helper. Uploads + reads media only.
// - attendee: end buyer. Search + public reads only.
//
// Event-scoped escalation (an organizer of event X, etc.) is layered on top of
// these baselines by `rbac.ts` after consulting `event_members`.

import { PERMISSIONS, type Permission } from './permissions.js';

type UserRole = 'superadmin' | 'admin' | 'photographer' | 'organizer' | 'assistant' | 'attendee';

export type { UserRole };

export const ROLE_PERMISSIONS: Record<UserRole, ReadonlyArray<Permission>> = {
  superadmin: PERMISSIONS,
  admin: [
    'org:read',
    'org:write',
    'org:admin',
    'event:read',
    'event:write',
    'event:publish',
    'event:delete',
    'event:members:manage',
    'media:upload',
    'media:read',
    'media:delete',
    'search:bib',
    'search:name',
    'search:face',
    'search:text',
    'commerce:read_orders',
    'commerce:refund',
    'compliance:read_audit',
    'admin:moderate',
    'integrations:manage',
  ],
  organizer: [
    'org:read',
    'event:read',
    'event:write',
    'event:publish',
    'event:members:manage',
    'media:read',
    'search:bib',
    'search:name',
    'search:face',
    'search:text',
    'commerce:read_orders',
  ],
  photographer: [
    'event:read',
    'media:upload',
    'media:read',
    'media:delete',
    'commerce:read_orders',
    'search:bib',
    'search:name',
    'search:text',
  ],
  assistant: ['event:read', 'media:upload', 'media:read'],
  attendee: ['event:read', 'search:bib', 'search:name', 'search:face', 'search:text'],
};

// Event-member role -> permissions granted *within that event*. Layered on top
// of the user's baseline role permissions when a resource-scoped check matches
// the event the user belongs to.
type EventMemberRole = 'organizer' | 'photographer' | 'assistant';

export type { EventMemberRole };

export const EVENT_MEMBER_PERMISSIONS: Record<EventMemberRole, ReadonlyArray<Permission>> = {
  organizer: [
    'event:read',
    'event:write',
    'event:publish',
    'event:members:manage',
    'media:read',
    'media:upload',
    'media:delete',
    'commerce:read_orders',
  ],
  photographer: [
    'event:read',
    'media:upload',
    'media:read',
    'media:delete',
    'commerce:read_orders',
  ],
  assistant: ['event:read', 'media:upload', 'media:read'],
};

export const roleHasPermission = (role: UserRole, perm: Permission): boolean =>
  ROLE_PERMISSIONS[role].includes(perm);

export const eventRoleHasPermission = (role: EventMemberRole, perm: Permission): boolean =>
  EVENT_MEMBER_PERMISSIONS[role].includes(perm);
