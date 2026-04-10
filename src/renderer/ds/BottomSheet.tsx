import {
  Drawer,
  DrawerBody,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import type { PropsWithChildren } from 'react';
import { useCallback } from 'react';

type BottomSheetProps = {
  open: boolean;
  onClose: () => void;
  className?: string;
};

const useStyles = makeStyles({
  drawer: {
    position: 'absolute',
    top: 'max(3rem, env(safe-area-inset-top, 3rem))',
    bottom: '0',
    left: '0',
    right: '0',
    height: 'auto',
    maxWidth: '100%',
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
  },
});

export const BottomSheet = ({ open, onClose, className, children }: PropsWithChildren<BottomSheetProps>) => {
  const styles = useStyles();

  const handleOpenChange = useCallback(
    (_event: unknown, data: { open: boolean }) => {
      if (!data.open) onClose();
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
