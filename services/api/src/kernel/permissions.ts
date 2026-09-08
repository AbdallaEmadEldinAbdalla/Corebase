import { ERROR_CODES } from '@steadhold/types';
import { ApiError } from './errors.ts';
import { can, type Role, type Capability } from '@steadhold/types';

/**
 * The role matrix moved to `@steadhold/types` so the dashboard can answer the same
 * question without re-implementing it (D-428). This module keeps the one part that
 * is genuinely server-side — turning a "no" into an HTTP 403 — and re-exports the
 * rest, so every existing import site is unchanged.
 */
export {
  CAPABILITIES, ROLE_CAPABILITIES, can, canAssignRole, canActOn,
  type Role, type Capability,
} from '@steadhold/types';

/**
 * Throw 403 unless the role allows it.
 *
 * The message names the capability and the role, because "forbidden" sends the
 * reader to a support ticket while "a member cannot delete a project" sends them
 * to the right person in their own org.
 */
export function require_(role: Role | undefined, capability: Capability): void {
  if (!role) {
    throw new ApiError(404, ERROR_CODES.PROJECT_NOT_FOUND,
      'No such organization, or you are not a member of it.');
  }
  if (!can(role, capability)) {
    throw new ApiError(403, ERROR_CODES.UNAUTHORIZED,
      `A ${role} cannot do this (${capability}).`);
  }
}
