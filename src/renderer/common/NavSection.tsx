import './NavSection.css';

import { useStore } from '@nanostores/react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { atom } from 'nanostores';
import { memo, type ReactNode, useCallback } from 'react';

import { Badge } from '@/renderer/ds/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/ds/ui/collapsible';
import { SidebarGroup, SidebarGroupContent } from '@/renderer/ds/ui/sidebar';

/**
 * Collapsible nav-section shell for the sidebar's container sections
 * (Sessions, Projects, Channels, DMs). The header label is the toggle (the
 * Slack model — chevron + label); action buttons stay live either way, and
 * the body unmounts while collapsed. Which sections stay folded is
 * renderer-local (localStorage) — a this-machine preference.
 *
 * `collapsedBadge` is the section's aggregate attention count, shown ONLY
 * while collapsed — folding a section must not hide that something inside
 * needs you (badges are the sidebar's attention system).
 */

const STORAGE_KEY = 'omni.navSectionsCollapsed';

const load = (): Record<string, true> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, true>) : {};
  } catch {
    return {};
  }
};

/** Section ids currently collapsed. */
const $collapsedNavSections = atom<Record<string, true>>(load());

function toggleNavSection(id: string): void {
  const current = $collapsedNavSections.get();
  const next: Record<string, true> = { ...current };
  if (next[id]) {
    delete next[id];
  } else {
    next[id] = true;
  }
  $collapsedNavSections.set(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export const NavSection = memo(function NavSection({
  id,
  label,
  actions,
  collapsedBadge = 0,
  children,
}: {
  /** Stable collapse-state key (e.g. "sessions"). */
  id: string;
  label: string;
  /** Header action buttons — rendered (and live) collapsed or not. */
  actions?: ReactNode;
  /** Aggregate attention count, shown only while collapsed. */
  collapsedBadge?: number;
  children: ReactNode;
}): React.JSX.Element {
  const collapsed = Boolean(useStore($collapsedNavSections)[id]);
  const handleToggle = useCallback(() => toggleNavSection(id), [id]);

  return (
    <Collapsible open={!collapsed} onOpenChange={handleToggle}>
      <SidebarGroup className="nav-section">
        <div data-sidebar="section-header" className="nav-section-header">
          <CollapsibleTrigger className="nav-section-trigger text-sidebar-foreground/70 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring">
            <span className="truncate">{label}</span>
            {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          </CollapsibleTrigger>
          {collapsed && collapsedBadge > 0 && (
            <span data-sidebar="group-status" className="pointer-events-none transition-opacity">
              <Badge variant="secondary" className="h-4 min-w-4 rounded-full px-1 text-xs tabular-nums">
                {collapsedBadge}
              </Badge>
            </span>
          )}
          {actions && (
            <div data-sidebar="section-actions" className="nav-section-actions">
              {actions}
            </div>
          )}
        </div>
        <CollapsibleContent>
          <SidebarGroupContent>{children}</SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
});
