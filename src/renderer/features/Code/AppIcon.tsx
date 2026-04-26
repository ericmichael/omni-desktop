import {
  Chat20Regular,
  Code20Regular,
  Desktop20Regular,
  Globe20Regular,
  MusicNote220Regular,
  News20Regular,
  People20Regular,
  PersonBoard20Regular,
  SlideLayout20Regular,
  Star20Regular,
  Video20Regular,
  WindowConsole20Regular,
} from '@fluentui/react-icons';
import { memo, useMemo } from 'react';

type FluentIcon = typeof Globe20Regular;

/**
 * Map of Fluent icon name → component for builtin + user-picker icons.
 */
export const ICON_MAP: Record<string, FluentIcon> = {
  Chat20Regular,
  Code20Regular,
  Desktop20Regular,
  Globe20Regular,
  WindowConsole20Regular,
  People20Regular,
  Video20Regular,
  MusicNote220Regular,
  News20Regular,
  Star20Regular,
  SlideLayout20Regular,
  PersonBoard20Regular,
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
 * - A Fluent icon name (e.g. `"Globe20Regular"`) → renders the component
 * - An inline SVG string (starts with `<svg`) → sanitized + rendered via innerHTML
 * - Anything else → falls back to Globe icon
 */
export const AppIcon = memo(({ icon, size = 20, className }: { icon: string; size?: number; className?: string }) => {
  const sanitized = useMemo(
    () => (icon.trimStart().startsWith('<svg') ? sanitizeSvg(icon, size) : null),
    [icon, size]
  );

  if (sanitized) {
    return (
      <span
        className={className}
        style={{ display: 'inline-flex', width: size, height: size, color: 'inherit' }}
        dangerouslySetInnerHTML={{ __html: sanitized }}
      />
    );
  }

  // Fluent icon name (or SVG that failed to parse — fall through to Globe)
  const Icon = ICON_MAP[icon] ?? Globe20Regular;
  return <Icon className={className} style={{ width: size, height: size }} />;
});
AppIcon.displayName = 'AppIcon';
