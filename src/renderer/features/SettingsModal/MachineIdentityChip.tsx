/**
 * Read-only chip that shows the local Electron's persisted machine identity
 * (label + machineId prefix). Renders inside the Connect Cloud card so the
 * user can see what the cloud will identify their laptop as before — and
 * after — they link.
 *
 * The full editable + cloud-side list lives in {@link MachinesCard}; this
 * chip is the "always-visible" identity affordance.
 */
import { makeStyles, tokens } from '@fluentui/react-components';
import { Desktop16Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo } from 'react';

import { Caption1 } from '@/renderer/ds';
import { $machineIdentity } from '@/renderer/services/machines';

const useStyles = makeStyles({
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  id: {
    fontFamily: tokens.fontFamilyMonospace,
    color: tokens.colorNeutralForeground3,
  },
});

export const MachineIdentityChip = memo(() => {
  const styles = useStyles();
  const identity = useStore($machineIdentity);
  if (!identity) {
    return null;
  }
  // Shorten the UUID to the first 8 chars — enough to disambiguate two
  // machines in a list, doesn't dominate the chip.
  const shortId = identity.machineId.slice(0, 8);
  return (
    <span className={styles.root} title={`Machine id: ${identity.machineId}`}>
      <Desktop16Regular />
      <span>{identity.label}</span>
      <Caption1 className={styles.id}>{shortId}</Caption1>
    </span>
  );
});

MachineIdentityChip.displayName = 'MachineIdentityChip';
