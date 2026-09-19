import type { TSkillSummary } from 'librechat-data-provider';

/**
 * Whether a user may invoke and therefore see this skill.
 *
 * Deployment skills shipped with the product are the model's tools, not the user's: the office
 * specialists load them through the `skill` tool, and a user has nothing to pick. `user-invocable:
 * false` in a skill's frontmatter takes it out of every user-facing surface while leaving it
 * available to the model.
 *
 * Only an explicit `false` hides a skill, so skills authored before the field existed stay visible
 * without a migration.
 */
export function isUserInvocable(skill: Pick<TSkillSummary, 'userInvocable'>): boolean {
  return skill.userInvocable !== false;
}
