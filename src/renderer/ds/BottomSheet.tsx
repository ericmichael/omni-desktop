import { Drawer, DrawerBody, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { PropsWithChildren } from 'react';
import { useCallback } from 'react';

type BottomSheetProps = {
  open: boolean;
  onClose: () => void;
  className?: string;
};

const useStyles = makeStyles({
  /* Height travels through Fluent's own var, never a raw `height`/`position`:
     the var drives BOTH the surface box and the slide-up transform, and
     Fluent anchors the surface itself. Overriding `position` to `absolute`
     strands its `top`/`bottom` offsets without a containing block and the
     sheet computes to zero height; overriding `height` alone desyncs the
     animation, which then only travels the var's distance.
     `--app-height` mirrors the app shell: at rest it's absent and 100dvh
     applies; while an on-screen keyboard overlays the page it's the space
     actually left. */
  drawer: {
    '--fui-Drawer--size': 'calc(var(--app-height, 100dvh) - max(3rem, env(safe-area-inset-top, 3rem)))',
    backgroundColor: tokens.colorNeutralBackground2,
    borderTopLeftRadius: '16px',
    borderTopRightRadius: '16px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens.colorNeutralStroke1,
  },
  handle: {
    display: 'flex',
    justifyContent: 'center',
    paddingTop: '10px',
    paddingBottom: '4px',
    flexShrink: 0,
  },
  handleBar: {
    width: '32px',
    height: '4px',
    borderRadius: '9999px',
    backgroundColor: tokens.colorNeutralForeground3,
    opacity: 0.4,
  },
  body: {
    flex: '1 1 0',
    minHeight: 0,
    padding: 0,
    paddingBottom: 'var(--safe-area-bottom, env(safe-area-inset-bottom, 0px))',
  },
});

export const BottomSheet = ({ open, onClose, className, children }: PropsWithChildren<BottomSheetProps>) => {
  const styles = useStyles();

  const handleOpenChange = useCallback(
    (_event: unknown, data: { open: boolean }) => {
      if (!data.open) {
        onClose();
      }
    },
    [onClose]
  );

  return (
    <Drawer
      open={open}
      onOpenChange={handleOpenChange}
      position="bottom"
      type="overlay"
      className={mergeClasses(styles.drawer, className)}
    >
      <div className={styles.handle}>
        <div className={styles.handleBar} />
      </div>
      <DrawerBody className={styles.body}>{children}</DrawerBody>
    </Drawer>
  );
};
