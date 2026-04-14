/**
 * Starter content injected into a new page on creation. Templates are just
 * markdown strings — the ContextEditor (Yoopta) parses them into blocks.
 *
 * Templates are intentionally minimal: a small set of headings that guide
 * shaping without being prescriptive. Users can freely edit, rearrange, or
 * delete any section. There are no HTML comments or placeholder prose — those
 * become noise the user has to manually clean up.
 */

export type TemplateKey = 'inbox-item';

/**
 * Template for a new inbox item. Three optional sections that match how people
 * actually think about work: what does "done" look like, what's out of scope,
 * and a scratch space for research. All sections are editable and removable.
 */
const INBOX_ITEM_TEMPLATE = `## Outcome

## Not doing

## Notes
`;

const TEMPLATES: Record<TemplateKey, string> = {
  'inbox-item': INBOX_ITEM_TEMPLATE,
};

/** Get template content by key. Returns empty string for unknown keys. */
export function getTemplate(key: TemplateKey | undefined): string {
  if (!key) {
return '';
}
  return TEMPLATES[key] ?? '';
}
