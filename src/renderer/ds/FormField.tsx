import { Field, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { PropsWithChildren, ReactNode } from 'react';

type FormFieldProps = {
  label: ReactNode;
  helperText?: ReactNode;
  className?: string;
};

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: '16px',
  },
  hint: {
    color: tokens.colorNeutralForeground3,
  },
});

export const FormField = ({ label, helperText, className, children }: PropsWithChildren<FormFieldProps>) => {
  const styles = useStyles();

  return (
    <Field
      label={label as string}
      hint={helperText ? (helperText as string) : undefined}
      className={mergeClasses(styles.root, className)}
    >
      {children}
    </Field>
  );
};
