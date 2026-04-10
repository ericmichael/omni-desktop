import { Tab, TabList } from '@fluentui/react-components';

type SegmentedControlProps<T extends string> = {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  layoutId?: string;
  className?: string;
};

export const SegmentedControl = <T extends string>({
  value,
  options,
  onChange,
  className,
}: SegmentedControlProps<T>) => (
  <TabList
    selectedValue={value}
    onTabSelect={(_e, data) => onChange(data.value as T)}
    size="small"
    className={className}
  >
    {options.map((opt) => (
      <Tab key={opt.value} value={opt.value}>
        {opt.label}
      </Tab>
    ))}
  </TabList>
);
