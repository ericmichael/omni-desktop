import { Body1, Caption1, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ChevronRight20Regular } from '@fluentui/react-icons';
import type { ReactNode } from 'react';

type ListItemProps = {
  icon?: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  showChevron?: boolean;
  onClick?: () => void;
  className?: string;
};

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
    width: '100%',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '14px',
    paddingBottom: '14px',
    textAlign: 'left',
    color: tokens.colorNeutralForeground1,
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
    },
    ':active': {
      backgroundColor: tokens.colorSubtleBackgroundPressed,
    },
  },
  iconWrap: {
    width: '36px',
    height: '36px',
    borderRadius: '12px',
    backgroundColor: tokens.colorNeutralBackground3,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: tokens.colorNeutralForeground2,
  },
  content: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
  },
  label: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  detail: {
    display: 'block',
    marginTop: '2px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chevron: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
    opacity: 0.4,
  },
});

export const ListItem = ({ icon, label, detail, trailing, showChevron = true, onClick, className }: ListItemProps) => {
  const styles = useStyles();
  return (
    <button type="button" onClick={onClick} className={mergeClasses(styles.root, className)}>
      {icon && <span className={styles.iconWrap}>{icon}</span>}
      <span className={styles.content}>
        <Body1 className={styles.label}>{label}</Body1>
        {detail && <Caption1 className={styles.detail}>{detail}</Caption1>}
      </span>
      {trailing}
      {showChevron && <ChevronRight20Regular style={{ width: 14, height: 14 }} className={styles.chevron} />}
    </button>
  );
};
