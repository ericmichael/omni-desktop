/**
 * Pure helper that disambiguates a slug against an existence check.
 *
 * `slug` is the candidate produced by `slugify(label)`. `isTaken` is a
 * synchronous predicate that returns true when a slug is already in use.
 *
 * If the slug isn't taken, returns it unchanged. Otherwise appends `-2`,
 * `-3`, … until it finds a free name. Hard cap at 999 to avoid pathologic
 * collision storms.
 *
 * Used by the launcher's project-creation paths (`ProjectManager.addProject`,
 * `InboxManager.promoteToProject`) to prevent raw `SQLITE_CONSTRAINT` errors
 * from the schema's `slug TEXT NOT NULL UNIQUE` constraint when two
 * projects' labels slugify to the same value.
 */
export function slugifyUnique(slug: string, isTaken: (s: string) => boolean): string {
  if (!isTaken(slug)) {
    return slug;
  }
  for (let i = 2; i < 1000; i++) {
    const candidate = `${slug}-${i}`;
    if (!isTaken(candidate)) {
      return candidate;
    }
  }
  throw new Error(`slugifyUnique: exhausted 999 disambiguation attempts for "${slug}"`);
}
