import React from 'react'

export function Header({
  agentName,
  onMenu,
  onArtifactsToggle,
  showArtifactsButton = false,
}: {
  agentName: string
  onMenu?: () => void
  onArtifactsToggle?: () => void
  showArtifactsButton?: boolean
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2 bg-surface">
      <div className="flex items-center gap-2 min-w-0">
        {onMenu ? (
          <button
            className="inline-flex size-8 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-white/5 hover:text-fg"
            onClick={onMenu}
            aria-label="Menu"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        {showArtifactsButton && onArtifactsToggle ? (
          <button
            className="inline-flex size-8 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-white/5 hover:text-fg"
            onClick={onArtifactsToggle}
            aria-label="Toggle artifacts"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18" />
            </svg>
          </button>
        ) : null}
      </div>
    </div>
  )
}
