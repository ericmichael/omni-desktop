import { Sparkle20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo } from 'react';

import { Button } from '@/renderer/ds';

import { $globalAgentOpen, toggleGlobalAgent } from './state';

/**
 * Header button that opens/closes the global workspace agent panel. Lives in the
 * Tile deck header (`CodeDeckHeader`); reflects open state via the primary
 * (filled) vs ghost variant.
 */
export const GlobalAgentToggle = memo(() => {
  const open = useStore($globalAgentOpen);
  return (
    <Button
      size="sm"
      variant={open ? 'primary' : 'ghost'}
      leftIcon={<Sparkle20Regular style={{ width: 13, height: 13 }} />}
      onClick={toggleGlobalAgent}
    >
      Agent
    </Button>
  );
});
GlobalAgentToggle.displayName = 'GlobalAgentToggle';
