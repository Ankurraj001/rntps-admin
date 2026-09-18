import type { CardGuardian } from '@rntps/shared';
import { AppError } from './AppError.js';
import type { GuardianSub } from '../models/Student.js';

/**
 * Which guardian a WhatsApp message should go to.
 *
 * The primary guardian if they are reachable, otherwise the first who is. "Reachable"
 * means they have not opted out — the opt-out is a standing instruction from the family,
 * so falling back past it would be the one thing it exists to prevent.
 *
 * The two failure cases are told apart on purpose: "no guardian on record" is a gap in the
 * student's record for the office to fill, while "everyone opted out" is a decision the
 * family has already made and nothing to fix.
 */
export function pickReachableGuardian(guardians: GuardianSub[]): GuardianSub {
  const guardian =
    guardians.find((g) => g.isPrimary && !g.whatsappOptOut) ?? guardians.find((g) => !g.whatsappOptOut);

  if (!guardian) {
    throw AppError.badRequest(
      guardians.length === 0
        ? 'No guardian on record for this student'
        : 'Every guardian on record has opted out of WhatsApp',
    );
  }

  return guardian;
}

/**
 * Which guardian a printed card names.
 *
 * A different question from `pickReachableGuardian` above, and deliberately a different
 * function: that one is about who can be *messaged*, so it respects the WhatsApp opt-out.
 * This one is about whose name appears on a document, where an opt-out is irrelevant — a
 * father who would rather not be texted is still the child's father.
 *
 * The father where there is one, since that is the row a report card traditionally
 * carries; otherwise the primary guardian, and the relation travels with the name so the
 * card can label the row for whoever it actually is.
 */
export function cardGuardianOf(guardians: GuardianSub[] | undefined): CardGuardian | null {
  if (!guardians || guardians.length === 0) return null;

  const chosen =
    guardians.find((g) => g.relation === 'FATHER') ?? guardians.find((g) => g.isPrimary) ?? guardians[0];

  return chosen ? { name: chosen.name, relation: chosen.relation } : null;
}
