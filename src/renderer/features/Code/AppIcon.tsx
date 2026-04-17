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
import { memo } from 'react';

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

/**
 * Renders an app icon. Accepts either:
 * - A Fluent icon name (e.g. `"Globe20Regular"`) → renders the component
 * - An inline SVG string (starts with `<svg`) → renders via innerHTML
 * - Anything else → falls back to Globe icon
 */
export const AppIcon = memo(({ icon, size = 20, className }: { icon: string; size?: number; className?: string }) => {
  // Inline SVG from marketplace
  if (icon.trimStart().startsWith('<svg')) {
    return (
      <span
        className={className}
        style={{ display: 'inline-flex', width: size, height: size, color: 'inherit' }}
        dangerouslySetInnerHTML={{ __html: icon.replace(/<svg/, `<svg width="${size}" height="${size}" fill="currentColor"`) }}
      />
    );
  }

  // Fluent icon name
  const Icon = ICON_MAP[icon] ?? Globe20Regular;
  return <Icon className={className} style={{ width: size, height: size }} />;
});
AppIcon.displayName = 'AppIcon';
