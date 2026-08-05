import {
  Code,
  Folder,
  GitBranch,
  Globe,
  MessageCircle,
  Monitor,
  Music2,
  Newspaper,
  PanelsTopLeft,
  Presentation,
  SquareTerminal,
  Star,
  Users,
  Video,
} from 'lucide-react';
import { memo, useMemo } from 'react';

import { cn } from '@/renderer/ds/cn';

type LucideIcon = typeof Globe;
type AppIconSize = 16 | 20 | 32;

const APP_ICON_SIZE_CLASSES: Record<AppIconSize, string> = {
  16: 'size-4',
  20: 'size-5',
  32: 'size-8',
};

/**
 * Map of Lucide icon name → component for builtin + user-picker icons.
 */
export const ICON_MAP: Record<string, LucideIcon> = {
  GitBranch,
  MessageCircle,
  Code,
  Monitor,
  Folder,
  Globe,
  SquareTerminal,
  Users,
  Video,
  Music2,
  Newspaper,
  Star,
  PanelsTopLeft,
  Presentation,
};

const SVG_DISALLOWED_TAGS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'style']);
const SVG_URL_ATTRS = new Set(['href', 'xlink:href', 'src']);

/**
 * Parse marketplace SVG, strip script/event-handler attack surface, and return
 * serialized string. Returns `null` if input isn't a well-formed SVG root.
 */
function sanitizeSvg(input: string, size: number): string | null {
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    return null;
  }
  const doc = new DOMParser().parseFromString(input, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length > 0) {
    return null;
  }
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (SVG_DISALLOWED_TAGS.has(child.tagName.toLowerCase())) {
        child.remove();
        continue;
      }
      walk(child);
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (SVG_URL_ATTRS.has(name) && /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  };
  walk(root);
  root.setAttribute('width', String(size));
  root.setAttribute('height', String(size));
  root.setAttribute('fill', 'currentColor');
  return new XMLSerializer().serializeToString(root);
}

/**
 * Renders an app icon. Accepts either:
 * - A Lucide icon name (e.g. `"Globe"`) → renders the component
 * - An inline SVG string (starts with `<svg`) → sanitized + rendered via innerHTML
 * - Anything else → falls back to Globe icon
 */
export const AppIcon = memo(
  ({ icon, size = 20, className }: { icon: string; size?: AppIconSize; className?: string }) => {
    const sanitized = useMemo(
      () => (icon.trimStart().startsWith('<svg') ? sanitizeSvg(icon, size) : null),
      [icon, size]
    );

    if (sanitized) {
      return (
        <span
          className={cn('inline-flex text-inherit', APP_ICON_SIZE_CLASSES[size], className)}
          dangerouslySetInnerHTML={{ __html: sanitized }}
        />
      );
    }

    // Lucide icon name (or SVG that failed to parse — fall through to Globe)
    const Icon = ICON_MAP[icon] ?? Globe;
    return <Icon className={cn(APP_ICON_SIZE_CLASSES[size], className)} />;
  }
);
AppIcon.displayName = 'AppIcon';
