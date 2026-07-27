import { makeStyles, tokens } from '@fluentui/react-components';

/**
 * The shared nav-sidebar idiom, extracted from the Work sidebar: tight
 * Fluent Tree geometry, the NavItem-style selected treatment (subtle
 * background + semibold label + 3px brand rail), and section-header
 * typography. Every tab sidebar built on Tree/TreeItemLayout consumes this
 * hook so the navs cannot drift apart.
 */
export const useNavTreeStyles = makeStyles({
  /**
   * Shared tree geometry for nav rows. Override `--spacingHorizontalXXL`
   * so Fluent's per-level indent stays tight.
   */
  tree: {
    paddingTop: '2px',
    paddingBottom: '2px',
    '--spacingHorizontalXXL': '12px',
  },
  navItem: {
    position: 'relative',
  },
  /** Selected state à la Fluent NavItem: subtle bg + left brand indicator. */
  navItemSelected: {
    '& > .fui-TreeItemLayout': {
      backgroundColor: tokens.colorSubtleBackgroundSelected,
      fontWeight: tokens.fontWeightSemibold,
    },
    '::before': {
      content: '""',
      position: 'absolute',
      left: '2px',
      top: '6px',
      bottom: '6px',
      width: '3px',
      borderRadius: tokens.borderRadiusCircular,
      backgroundColor: tokens.colorCompoundBrandForeground1,
      zIndex: 1,
    },
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    paddingLeft: tokens.spacingHorizontalMNudge,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXL,
    paddingBottom: tokens.spacingVerticalXS,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
  },
  sectionHeaderLabel: {
    flex: '1 1 0',
  },
});
