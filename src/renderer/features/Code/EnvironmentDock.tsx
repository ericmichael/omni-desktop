import { memo, useCallback } from 'react';

import { ToggleGroup, ToggleGroupItem } from '@/renderer/ds/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/renderer/ds/ui/tooltip';
import type { AppDescriptor, AppId } from '@/shared/app-registry';

import { AppIcon } from './AppIcon';

export { ICON_MAP } from './AppIcon';
export type { AppId };

type EnvironmentDockProps = {
  apps: AppDescriptor[];
  activeAppId: AppId;
  onSelect: (id: AppId) => void;
  sandboxUrls?: Record<string, string | undefined>;
};

export const EnvironmentDock = memo(({ apps, activeAppId, onSelect, sandboxUrls }: EnvironmentDockProps) => {
  const handleValueChange = useCallback(
    (id: string) => {
      if (id) {
        onSelect(id);
      }
    },
    [onSelect]
  );

  return (
    <TooltipProvider delayDuration={300}>
      <ToggleGroup
        type="single"
        value={activeAppId}
        onValueChange={handleValueChange}
        aria-label="Environment tools"
        className="mx-3 mb-2 mt-1.5 h-11 min-w-0 shrink-0 overflow-x-auto overflow-y-hidden rounded-xl border border-border bg-card p-1 shadow-sm [&::-webkit-scrollbar]:hidden"
      >
        {apps.map((app) => {
          const isAvailable = app.scope === 'sandbox' ? !!sandboxUrls?.[app.sandboxUrlKey!] : true;

          if (app.scope === 'sandbox' && !isAvailable) {
            return null;
          }

          return (
            <Tooltip key={app.id}>
              <TooltipTrigger asChild>
                <ToggleGroupItem
                  value={app.id}
                  className="size-8 min-w-8 shrink-0 p-0 text-muted-foreground hover:text-foreground data-[state=on]:text-primary"
                  aria-label={app.label}
                >
                  <AppIcon icon={app.icon} size={16} className="shrink-0" />
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {app.label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </ToggleGroup>
    </TooltipProvider>
  );
});
EnvironmentDock.displayName = 'EnvironmentDock';
