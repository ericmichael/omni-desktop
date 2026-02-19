import { useStore } from '@nanostores/react';
import { motion } from 'framer-motion';
import { memo, useCallback, useState } from 'react';

import { AnimatedDialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/renderer/ds';
import { SettingsModalEnvironmentTab } from '@/renderer/features/SettingsModal/SettingsModalEnvironmentTab';
import { SettingsModalGeneralTab } from '@/renderer/features/SettingsModal/SettingsModalGeneralTab';
import { SettingsModalMcpTab } from '@/renderer/features/SettingsModal/SettingsModalMcpTab';
import { SettingsModalModelsTab } from '@/renderer/features/SettingsModal/SettingsModalModelsTab';
import { SettingsModalResetButton } from '@/renderer/features/SettingsModal/SettingsModalResetButton';
import { $isSettingsOpen } from '@/renderer/features/SettingsModal/state';

const TABS = ['General', 'Environment', 'Models', 'MCP'] as const;
type Tab = (typeof TABS)[number];

export const SettingsModal = memo(() => {
  const isOpen = useStore($isSettingsOpen);
  const [activeTab, switchTab] = useState<Tab>('General');

  const onClose = useCallback(() => {
    $isSettingsOpen.set(false);
  }, []);

  const onClickGeneral = useCallback(() => switchTab('General'), []);
  const onClickEnvironment = useCallback(() => switchTab('Environment'), []);
  const onClickModels = useCallback(() => switchTab('Models'), []);
  const onClickMcp = useCallback(() => switchTab('MCP'), []);

  const tabClickHandlers: Record<Tab, () => void> = {
    General: onClickGeneral,
    Environment: onClickEnvironment,
    Models: onClickModels,
    MCP: onClickMcp,
  };

  return (
    <AnimatedDialog open={isOpen} onClose={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>Settings</DialogHeader>
        <div className="flex gap-1 px-6 pb-2">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={tabClickHandlers[tab]}
              className="relative px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer select-none transition-colors"
              style={{ color: activeTab === tab ? 'var(--color-fg)' : 'var(--color-fg-muted)' }}
            >
              {activeTab === tab && (
                <motion.div
                  layoutId="settings-tab-indicator"
                  className="absolute inset-0 bg-white/10 rounded-md"
                  transition={{ type: 'spring', duration: 0.3, bounce: 0.15 }}
                />
              )}
              <span className="relative z-10">{tab}</span>
            </button>
          ))}
        </div>
        <DialogBody className="flex flex-col gap-6 min-h-[400px]">
          {activeTab === 'General' && <SettingsModalGeneralTab />}
          {activeTab === 'Environment' && <SettingsModalEnvironmentTab />}
          {activeTab === 'Models' && <SettingsModalModelsTab />}
          {activeTab === 'MCP' && <SettingsModalMcpTab />}
        </DialogBody>
        {activeTab === 'General' && (
          <DialogFooter className="pt-4">
            <SettingsModalResetButton />
          </DialogFooter>
        )}
      </DialogContent>
    </AnimatedDialog>
  );
});
SettingsModal.displayName = 'SettingsModal';
