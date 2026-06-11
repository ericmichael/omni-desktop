import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';

/**
 * Round-trip markdown through remark to produce canonical CommonMark + GFM.
 *
 * Why: agents and round-trippers (Yoopta's marked-based serializer in
 * particular) emit markdown that's outside what stricter parsers accept —
 * extra blank lines between a parent bullet and its indented children break
 * nested lists; trailing whitespace and inconsistent list indent confuse
 * loose-vs-tight detection. Normalizing on write means disk content is
 * always parseable by any downstream reader (Yoopta, grep, another LLM,
 * future tools) without per-reader workarounds.
 *
 * Stringify options are chosen to minimize churn against the dash-bullet,
 * fenced-code style that the existing pages already use, so normalization
 * doesn't show up as a noisy diff on first contact.
 */
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkStringify, {
    bullet: '-',
    listItemIndent: 'one',
    fences: true,
    rule: '-',
    emphasis: '*',
    strong: '*',
  });

export function normalizeMarkdown(content: string): string {
  if (!content) {
    return content;
  }
  try {
    return String(processor.processSync(content));
  } catch {
    return content;
  }
}
