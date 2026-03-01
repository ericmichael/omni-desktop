import { useStore } from '@nanostores/react';
import { memo, useEffect } from 'react';

import { $initialized, persistedStoreApi } from '@/renderer/services/store';

import { CodeTabBar } from './CodeTabBar';
import { CodeTabContent } from './CodeTabContent';
import { codeApi } from './state';

export const Code = memo(() => {
  const initialized = useStore($initialized);
  const store = useStore(persistedStoreApi.$atom);

  const codeTabs = store.codeTabs ?? [];
  const activeCodeTabId = store.activeCodeTabId ?? null;

  // Auto-create first tab if none exist
  useEffect(() => {
    if (!initialized) {
      return;
    }
    if (codeTabs.length === 0) {
      codeApi.addTab();
    }
  }, [initialized, codeTabs.length]);

  if (!initialized) {
    return null;
  }

  return (
    <div className="flex flex-col w-full h-full">
      <CodeTabBar tabs={codeTabs} activeTabId={activeCodeTabId} />
      <div className="flex-1 min-h-0 relative">
        {codeTabs.map((tab) => (
          <CodeTabContent key={tab.id} tab={tab} isActive={tab.id === activeCodeTabId} />
        ))}
      </div>
    </div>
  );
});
Code.displayName = 'Code';
