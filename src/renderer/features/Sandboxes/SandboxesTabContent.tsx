import { useStore } from '@nanostores/react';
import { memo } from 'react';

import { useIsDesktop } from '@/renderer/common/use-is-desktop';
import { PageHeader } from '@/renderer/ds/PageHeader';
import { PageTabsList, PageTabsTrigger } from '@/renderer/ds/PageTabs';
import { TopAppBar } from '@/renderer/ds/TopAppBar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/renderer/ds/ui/tabs';
import { HealthPane } from '@/renderer/features/Sandboxes/HealthPane';
import { ProfilesPane } from '@/renderer/features/Sandboxes/ProfilesPane';
import { RunningPane } from '@/renderer/features/Sandboxes/RunningPane';
import { SnapshotsPane } from '@/renderer/features/Sandboxes/SnapshotsPane';
import { $sandboxesSelectedPane, type SandboxesPane } from '@/renderer/features/Sandboxes/state';

/**
 * The tab's fixed master list — four nodes mapping to detail panes
 * (docs/sandboxes-tab-plan.md, Decision 2). Fixed, not data-driven: the
 * data lives in the panes.
 */
const PANES: { id: SandboxesPane; title: string; meta: string }[] = [
  { id: 'health', title: 'Health', meta: 'Substrate status and machines' },
  { id: 'profiles', title: 'Profiles', meta: 'Discovered sandbox profiles' },
  { id: 'running', title: 'Running', meta: 'Containers and cleanup' },
  { id: 'snapshots', title: 'Snapshots', meta: 'Workspace rehydration tars' },
];

const selectPane = (pane: SandboxesPane): void => {
  $sandboxesSelectedPane.set(pane);
};
const clearPane = (): void => {
  $sandboxesSelectedPane.set(null);
};

export const SandboxesTabContent = memo(() => {
  const selectedPane = useStore($sandboxesSelectedPane);
  const isDesktop = useIsDesktop();

  // Desktop always has an active section; mobile starts at the section list.
  const tabsValue = selectedPane ?? (isDesktop ? 'health' : '');

  const list = (
    <TabsList variant="line" className="w-full flex-1 items-stretch justify-start rounded-none bg-transparent p-0">
      {PANES.map((pane) => (
        <TabsTrigger
          key={pane.id}
          value={pane.id}
          className={`${'flex flex-col items-stretch gap-0.5 pl-5 pr-2 pt-2 pb-2 cursor-pointer border-0 bg-transparent w-full text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-primary focus-visible:-outline-offset-2'} h-auto flex-none flex-col items-stretch justify-start rounded-none after:hidden ${tabsValue === pane.id ? 'bg-accent' : ''}`}
        >
          <span className="font-normal text-sm">{pane.title}</span>
          <span className="text-muted-foreground text-xs">{pane.meta}</span>
        </TabsTrigger>
      ))}
    </TabsList>
  );

  const detail = (
    <>
      <TabsContent value="health" className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4">
        <div className="w-full max-w-5xl ml-auto mr-auto">
          <HealthPane />
        </div>
      </TabsContent>
      <TabsContent value="profiles" className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4">
        <div className="w-full max-w-5xl ml-auto mr-auto">
          <ProfilesPane />
        </div>
      </TabsContent>
      <TabsContent value="running" className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4">
        <div className="w-full max-w-5xl ml-auto mr-auto">
          <RunningPane />
        </div>
      </TabsContent>
      <TabsContent value="snapshots" className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4">
        <div className="w-full max-w-5xl ml-auto mr-auto">
          <SnapshotsPane />
        </div>
      </TabsContent>
    </>
  );

  // Mobile: one master per tab — the list fills the plane and a drilled-in
  // pane replaces it, same as Routines and the agent roster. Side-by-side
  // here would squeeze the detail to zero width (it did).
  if (!isDesktop) {
    return (
      <Tabs
        value={tabsValue}
        onValueChange={(value) => selectPane(value as SandboxesPane)}
        orientation="vertical"
        className="flex w-full h-full gap-0"
      >
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col">
          {selectedPane ? (
            <TopAppBar title={PANES.find((p) => p.id === selectedPane)?.title ?? 'Sandboxes'} onBack={clearPane} />
          ) : (
            <TopAppBar title="Sandboxes" showMenu />
          )}
          {selectedPane ? detail : list}
        </div>
      </Tabs>
    );
  }

  return (
    <Tabs
      value={tabsValue}
      onValueChange={(value) => selectPane(value as SandboxesPane)}
      orientation="horizontal"
      className="flex flex-col w-full h-full min-h-0 gap-0"
    >
      <PageHeader title="Sandboxes" />
      <div className="px-5">
        <PageTabsList>
          {PANES.map((pane) => (
            <PageTabsTrigger key={pane.id} value={pane.id}>
              {pane.title}
            </PageTabsTrigger>
          ))}
        </PageTabsList>
      </div>
      <div className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col">{detail}</div>
    </Tabs>
  );
});
SandboxesTabContent.displayName = 'SandboxesTabContent';
