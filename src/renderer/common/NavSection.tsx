import { makeStyles, tokens } from '@fluentui/react-components';
import { ChevronDown12Regular, ChevronRight12Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { atom } from 'nanostores';
import { memo, type ReactNode, useCallback } from 'react';

import { useNavTreeStyles } from '@/renderer/common/nav-tree';
import { CounterBadge, SectionLabel } from '@/renderer/ds';

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

const useStyles = makeStyles({
  /* The label IS the toggle: a bare button that inherits the section-header
     typography, with the chevron in front. Takes the label's flex role so
     the action buttons keep hugging the right edge. */
  toggle: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    padding: 0,
    border: 'none',
    backgroundColor: 'transparent',
    font: 'inherit',
    color: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': { color: tokens.colorNeutralForeground1 },
    ':focus-visible': {
      outline: `2px solid ${tokens.colorBrandStroke1}`,
      outlineOffset: '2px',
      borderRadius: tokens.borderRadiusSmall,
    },
  },
  chevron: {
    display: 'inline-flex',
    flexShrink: 0,
  },
});

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
  const styles = useStyles();
  const nav = useNavTreeStyles();
  const collapsed = Boolean(useStore($collapsedNavSections)[id]);
  const handleToggle = useCallback(() => toggleNavSection(id), [id]);

  return (
    <>
      <div className={nav.sectionHeader}>
        <button type="button" className={styles.toggle} aria-expanded={!collapsed} onClick={handleToggle}>
          <span className={styles.chevron}>{collapsed ? <ChevronRight12Regular /> : <ChevronDown12Regular />}</span>
          <SectionLabel>{label}</SectionLabel>
        </button>
        {collapsed && collapsedBadge > 0 && <CounterBadge count={collapsedBadge} size="small" color="brand" />}
        {actions}
      </div>
      {!collapsed && children}
    </>
  );
});
