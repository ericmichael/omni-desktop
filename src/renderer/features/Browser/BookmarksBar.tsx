import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { Delete16Regular, Star16Regular } from '@fluentui/react-icons';
import { memo, useCallback } from 'react';

import { fallbackTitle } from '@/lib/url';
import { Menu, MenuDivider, MenuItem, MenuList, MenuPopover, MenuTrigger } from '@/renderer/ds';
import { browserApi } from '@/renderer/features/Browser/state';
import type { BrowserBookmark } from '@/shared/types';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    height: '28px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollbarWidth: 'thin',
  },
  rootGlass: {
    backgroundColor: 'transparent',
    borderBottomColor: 'rgba(255, 255, 255, 0.14)',
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    height: '22px',
    paddingLeft: '8px',
    paddingRight: '8px',
    borderRadius: tokens.borderRadiusSmall,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase100,
    cursor: 'pointer',
    flexShrink: 0,
    maxWidth: '160px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
  },
  destructive: { color: tokens.colorPaletteRedForeground1 },
});

export const BookmarksBar = memo(
  ({
    bookmarks,
    isGlass,
    onOpen,
  }: {
    bookmarks: BrowserBookmark[];
    isGlass?: boolean;
    onOpen: (url: string) => void;
  }) => {
    const styles = useStyles();

    const handleRemove = useCallback((id: string) => {
      void browserApi.removeBookmark(id);
    }, []);

    // Hide the bar entirely when empty — don't clutter the chrome with a
    // "how to bookmark" hint. The bar reappears the moment a bookmark is
    // saved (Cmd+D / star button in the toolbar).
    if (bookmarks.length === 0) {
      return null;
    }

    return (
      <div className={`${styles.root}${isGlass ? ` ${  styles.rootGlass}` : ''}`}>
        {bookmarks.map((b) => {
          const label = b.title || fallbackTitle(b.url);
          return (
            <Menu key={b.id} positioning={{ position: 'below', align: 'start' }} openOnContext>
              <MenuTrigger>
                <button
                  type="button"
                  className={styles.chip}
                  title={`${b.title}\n${b.url}`}
                  onClick={() => onOpen(b.url)}
                >
                  <Star16Regular style={{ width: 12, height: 12, flexShrink: 0 }} />
                  <span>{label}</span>
                </button>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem onClick={() => onOpen(b.url)}>Open</MenuItem>
                  <MenuDivider />
                  <MenuItem
                    icon={<Delete16Regular className={styles.destructive} />}
                    onClick={() => handleRemove(b.id)}
                    className={styles.destructive}
                  >
                    Remove bookmark
                  </MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          );
        })}
      </div>
    );
  }
);
BookmarksBar.displayName = 'BookmarksBar';
