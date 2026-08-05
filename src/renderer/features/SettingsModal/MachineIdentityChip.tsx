/**
 * Read-only chip that shows the local Electron's persisted machine identity
 * (label + machineId prefix). Renders inside the Connect Cloud card so the
 * user can see what the cloud will identify their laptop as before — and
 * after — they link.
 *
 * The full editable + cloud-side list lives in {@link MachinesCard}; this
 * chip is the "always-visible" identity affordance.
 */
import { useStore } from '@nanostores/react';
import { Monitor } from 'lucide-react';
import { memo } from 'react';

import { cn } from '@/renderer/ds/cn';
import { $machineIdentity } from '@/renderer/services/machines';

export const MachineIdentityChip = memo(() => {
  const identity = useStore($machineIdentity);
  if (!identity) {
    return null;
  }
  // Shorten the UUID to the first 8 chars — enough to disambiguate two
  // machines in a list, doesn't dominate the chip.
  const shortId = identity.machineId.slice(0, 8);
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-card border border-border text-xs text-muted-foreground"
      title={`Machine id: ${identity.machineId}`}
    >
      <Monitor />
      <span>{identity.label}</span>
      <span className={cn('text-xs text-muted-foreground', 'font-mono text-muted-foreground')}>{shortId}</span>
    </span>
  );
});

MachineIdentityChip.displayName = 'MachineIdentityChip';
