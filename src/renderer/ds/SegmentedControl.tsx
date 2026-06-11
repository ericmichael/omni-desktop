import { CounterBadge, makeStyles, Tab, TabList, tokens } from '@fluentui/react-components';

type SegmentedControlProps<T extends string> = {
  value: T;
  /** `badge` renders a small counter inside the segment (hidden when 0).
   *  `title` teaches what the segment means (native tooltip + SR description)
   *  — useful when the label is product vocabulary ("Tile", "Focus"). */
  options: { value: T; label: string; badge?: number; title?: string }[];
  onChange: (value: T) => void;
  layoutId?: string;
  className?: string;
};

const useStyles = makeStyles({
  /**
   * Fluent's filled+informative counter is colorNeutralForeground3 on
   * colorNeutralBackground5 — too low-contrast at size="small". Keep the
   * neutral chip but lift the text to the primary foreground token.
   */
  counter: {
    color: tokens.colorNeutralForeground1,
  },
});

export const SegmentedControl = <T extends string>({
  value,
  options,
  onChange,
  className,
}: SegmentedControlProps<T>) => {
  const styles = useStyles();
  return (
    <TabList
      selectedValue={value}
      onTabSelect={(_e, data) => onChange(data.value as T)}
      size="small"
      className={className}
    >
      {options.map((opt) => (
        <Tab key={opt.value} value={opt.value} title={opt.title} aria-description={opt.title}>
          {opt.label}
          {opt.badge !== undefined && opt.badge > 0 && (
            <>
              {' '}
              <CounterBadge
                count={opt.badge}
                size="small"
                appearance="filled"
                color="informative"
                className={styles.counter}
              />
            </>
          )}
        </Tab>
      ))}
    </TabList>
  );
};
