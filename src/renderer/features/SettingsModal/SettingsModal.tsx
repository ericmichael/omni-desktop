import { makeStyles, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useState } from 'react';

import { AnimatedDialog, DialogBody, DialogContent, DialogFooter, DialogHeader, Tab, TabList } from '@/renderer/ds';
import { SettingsModalAccountTab } from '@/renderer/features/SettingsModal/SettingsModalAccountTab';
import { SettingsModalAppsTab } from '@/renderer/features/SettingsModal/SettingsModalAppsTab';
import { SettingsModalEnvironmentTab } from '@/renderer/features/SettingsModal/SettingsModalEnvironmentTab';
import { SettingsModalExtensionsTab } from '@/renderer/features/SettingsModal/SettingsModalExtensionsTab';
import { SettingsModalGeneralTab } from '@/renderer/features/SettingsModal/SettingsModalGeneralTab';
import { SettingsModalMcpTab } from '@/renderer/features/SettingsModal/SettingsModalMcpTab';
import { SettingsModalModelsTab } from '@/renderer/features/SettingsModal/SettingsModalModelsTab';
import { SettingsModalNetworkTab } from '@/renderer/features/SettingsModal/SettingsModalNetworkTab';
import { SettingsModalResetButton } from '@/renderer/features/SettingsModal/SettingsModalResetButton';
import { $isSettingsOpen } from '@/renderer/features/SettingsModal/state';

const TABS = ['General', 'Environment', 'Models', 'MCP', 'Apps', 'Network', 'Extensions', 'Account'] as const;
type SettingsTab = (typeof TABS)[number];

const useStyles = makeStyles({
  content: {
    '@media (min-width: 640px)': { maxWidth: '672px' },
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXL,
    minHeight: 0,
    '@media (min-width: 640px)': { minHeight: '400px' },
  },
  footer: {
    paddingTop: tokens.spacingVerticalL,
  },
});

export const SettingsModal = memo(() => {
  const styles = useStyles();
  const isOpen = useStore($isSettingsOpen);
  const [activeTab, switchTab] = useState<SettingsTab>('General');

  const onClose = useCallback(() => {
    $isSettingsOpen.set(false);
  }, []);

  const handleTabSelect = useCallback(
    (_event: unknown, data: { value: unknown }) => {
      switchTab(data.value as SettingsTab);
    },
    []
  );

  return (
    <AnimatedDialog open={isOpen} onClose={onClose}>
      <DialogContent className={styles.content}>
        <DialogHeader>Settings</DialogHeader>
        <TabList
          selectedValue={activeTab}
          onTabSelect={handleTabSelect}
          size="small"
          appearance="subtle"
          style={{ paddingLeft: 24, paddingRight: 24, paddingBottom: 8 }}
        >
          {TABS.map((tab) => (
            <Tab key={tab} value={tab}>
              {tab}
            </Tab>
          ))}
        </TabList>
        <DialogBody className={styles.body}>
          {activeTab === 'General' && <SettingsModalGeneralTab />}
          {activeTab === 'Environment' && <SettingsModalEnvironmentTab />}
          {activeTab === 'Models' && <SettingsModalModelsTab />}
          {activeTab === 'MCP' && <SettingsModalMcpTab />}
          {activeTab === 'Apps' && <SettingsModalAppsTab />}
          {activeTab === 'Network' && <SettingsModalNetworkTab />}
          {activeTab === 'Extensions' && <SettingsModalExtensionsTab />}
          {activeTab === 'Account' && <SettingsModalAccountTab />}
        </DialogBody>
        {activeTab === 'General' && (
          <DialogFooter className={styles.footer}>
            <SettingsModalResetButton />
          </DialogFooter>
        )}
      </DialogContent>
    </AnimatedDialog>
  );
});
SettingsModal.displayName = 'SettingsModal';
