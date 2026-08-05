import { Navigation, PanelRight } from 'lucide-react';

import { Button } from '@/renderer/ds/ui/button';

export function Header({
  agentName: _agentName,
  onMenu,
  onArtifactsToggle,
  showArtifactsButton = false,
}: {
  agentName: string;
  onMenu?: () => void;
  onArtifactsToggle?: () => void;
  showArtifactsButton?: boolean;
}) {
  return (
    <div className="flex items-center justify-between bg-background px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {onMenu ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Toggle sidebar"
            onClick={onMenu}
            title="Toggle sidebar"
          >
            <Navigation />
          </Button>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        {showArtifactsButton && onArtifactsToggle ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Toggle artifacts"
            onClick={onArtifactsToggle}
            title="Toggle artifacts"
          >
            <PanelRight />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
