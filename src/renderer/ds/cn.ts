/**
 * Utility to conditionally join classNames. Filters falsy values.
 */
export const cn = (...classes: (string | false | null | undefined)[]): string => classes.filter(Boolean).join(' ');
