import { CodeIcon, FileTextIcon, GlobeIcon,ImageIcon } from 'lucide-react'
import React, { useMemo } from 'react'

import type { ArtifactItem } from '@/shared/chat-types'
export type { ArtifactItem } from '@/shared/chat-types'

const MODE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  markdown: FileTextIcon,
  html: GlobeIcon,
  image: ImageIcon,
  pdf: FileTextIcon,
  code: CodeIcon,
}

function ArtifactRow({ item, onScrollTo }: { item: ArtifactItem; onScrollTo?: (artifactId: string) => void }) {
  const Icon = MODE_ICON[item.mode || 'markdown'] || FileTextIcon
  return (
    <button
      className="w-full text-left flex items-center gap-2.5 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors group"
      onClick={() => item.artifact_id && onScrollTo?.(item.artifact_id)}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
      <span className="truncate text-foreground">{item.title || 'Artifact'}</span>
    </button>
  )
}

export function ArtifactsPanel({
  artifacts,
  onClose,
  onScrollTo,
  asOverlay = false,
}: {
  artifacts: ArtifactItem[]
  onClose?: () => void
  onScrollTo?: (artifactId: string) => void
  asOverlay?: boolean
}) {
  const items = useMemo(() => {
    const copy = artifacts.slice()
    copy.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    return copy
  }, [artifacts])

  if (!items.length) {
return null
}

  const list = (
    <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
      {items.map((a, idx) => (
        <ArtifactRow key={a.artifact_id || idx} item={a} onScrollTo={onScrollTo} />
      ))}
    </div>
  )

  if (asOverlay) {
    return (
      <div className="fixed inset-0 z-40">
        <div className="absolute inset-0 bg-black/40" onClick={onClose} />
        <div className="absolute right-0 top-0 bottom-0 w-full max-w-[90vw] sm:max-w-xs bg-background border-l border-border flex flex-col">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
            <div className="text-sm font-semibold text-foreground">Artifacts</div>
            <button
              className="w-7 h-7 rounded hover:bg-accent text-muted-foreground hover:text-foreground text-xs"
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          {list}
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
        <div className="text-sm font-semibold text-foreground">Artifacts</div>
        <button
          className="w-7 h-7 rounded hover:bg-accent text-muted-foreground hover:text-foreground text-xs"
          onClick={onClose}
          aria-label="Close panel"
        >
          ✕
        </button>
      </div>
      {list}
    </div>
  )
}
