import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Document, Page as PdfPage, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import { Markdown } from './promptkit/markdown'
import { ImageLightbox } from './ImageLightbox'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

export type ArtifactItem = {
  title: string
  content: string
  mode?: string
  artifact_id?: string
  session_id?: string
  updated_at?: number
}

function HtmlPreview({ content }: { content: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(200)

  const script = `<script>
    function sendHeight(){window.parent.postMessage({type:'iframe-resize',height:document.body.scrollHeight},'*')}
    window.addEventListener('load',sendHeight);
    new ResizeObserver(sendHeight).observe(document.body);
  <\/script>`
  const srcDoc = content + script

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'iframe-resize' && typeof e.data.height === 'number') {
        setHeight(Math.min(e.data.height + 16, 800))
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      style={{ width: '100%', height, border: 'none', borderRadius: 6, background: '#fff' }}
    />
  )
}

function PdfViewer({ content }: { content: string }) {
  const [numPages, setNumPages] = useState(0)
  const [pageNumber, setPageNumber] = useState(1)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined)

  // Decode base64 content once and keep a stable reference.
  // pdf.js transfers the ArrayBuffer to a worker which empties the original
  // Uint8Array, so we must give Document a fresh copy on every render.
  const pdfData = useMemo(() => {
    let raw = content
    const prefix = 'data:application/pdf;base64,'
    if (raw.startsWith(prefix)) raw = raw.slice(prefix.length)
    try {
      const bytes = atob(raw)
      const arr = new Uint8Array(bytes.length)
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
      return arr
    } catch {
      return null
    }
  }, [content])

  // Return a fresh copy so pdf.js can transfer without destroying our source.
  const file = useMemo(() => (pdfData ? { data: pdfData.slice() } : null), [pdfData])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onDocumentLoadSuccess = useCallback(({ numPages: n }: { numPages: number }) => {
    setNumPages(n)
    setPageNumber(1)
  }, [])

  if (!pdfData) return <pre className="whitespace-pre-wrap break-words text-red-400">Invalid PDF data</pre>

  return (
    <div ref={containerRef}>
      <div className="flex items-center justify-center gap-3 py-2 border-b border-bgCardAlt mb-2">
        <button
          className="px-2 py-1 rounded text-sm hover:bg-bgCardAlt text-textPrimary disabled:opacity-30 disabled:cursor-not-allowed"
          disabled={pageNumber <= 1}
          onClick={() => setPageNumber(p => p - 1)}
        >
          Prev
        </button>
        <span className="text-sm text-textSecondary">
          Page {pageNumber} of {numPages || '...'}
        </span>
        <button
          className="px-2 py-1 rounded text-sm hover:bg-bgCardAlt text-textPrimary disabled:opacity-30 disabled:cursor-not-allowed"
          disabled={pageNumber >= numPages}
          onClick={() => setPageNumber(p => p + 1)}
        >
          Next
        </button>
      </div>
      <Document
        file={file}
        onLoadSuccess={onDocumentLoadSuccess}
        loading={<div className="text-sm text-textSecondary py-4 text-center">Loading PDF...</div>}
        error={<pre className="whitespace-pre-wrap break-words text-red-400">Failed to load PDF</pre>}
      >
        <PdfPage
          pageNumber={pageNumber}
          width={containerWidth}
          renderTextLayer={true}
          renderAnnotationLayer={true}
        />
      </Document>
    </div>
  )
}

function ImageArtifact({ src, alt }: { src: string; alt: string }) {
  const [lightbox, setLightbox] = useState(false)

  return (
    <>
      <div className="relative group cursor-pointer inline-block" onClick={() => setLightbox(true)}>
        <img src={src} alt={alt} className="max-w-full rounded" />
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 rounded px-1.5 py-0.5 text-xs text-white pointer-events-none">
          ⤢ Expand
        </div>
      </div>
      {lightbox && <ImageLightbox src={src} alt={alt} onClose={() => setLightbox(false)} />}
    </>
  )
}

function ArtifactContent({ artifact }: { artifact: ArtifactItem }) {
  const mode = String(artifact.mode || 'markdown')

  switch (mode) {
    case 'image':
      return <ImageArtifact src={artifact.content} alt={artifact.title || 'artifact'} />
    case 'markdown':
      return (
        <Markdown className="prose-sm" highlight={true} inheritTextColor>
          {artifact.content}
        </Markdown>
      )
    case 'html':
      return <HtmlPreview content={artifact.content} />
    case 'pdf':
      return <PdfViewer content={artifact.content} />
    default:
      return <pre className="whitespace-pre-wrap break-words">{artifact.content}</pre>
  }
}

function ArtifactList({ items }: { items: ArtifactItem[] }) {
  return (
    <>
      {items.map((a, idx) => (
        <details key={a.artifact_id || idx} className="rounded-lg border border-bgCardAlt bg-bgCardAlt" open>
          <summary className="cursor-pointer select-none px-3 py-2 text-sm text-textHeading">
            {a.title || 'Artifact'}
          </summary>
          <div className="px-3 pb-3 text-sm text-textPrimary">
            <ArtifactContent artifact={a} />
          </div>
        </details>
      ))}
    </>
  )
}

export function ArtifactsPanel({
  artifacts,
  onClose,
  asOverlay = false,
}: {
  artifacts: ArtifactItem[]
  onClose?: () => void
  asOverlay?: boolean
}) {
  const items = useMemo(() => {
    const copy = artifacts.slice()
    copy.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    return copy
  }, [artifacts])

  if (!items.length) return null

  if (asOverlay) {
    return (
      <div className="fixed inset-0 z-40">
        <div className="absolute inset-0 bg-black/40" onClick={onClose} />
        <div className="absolute right-0 top-0 bottom-0 w-full max-w-[90vw] sm:max-w-lg bg-bgColumn border-l border-bgCardAlt flex flex-col">
          <div className="px-4 py-3 border-b border-bgCardAlt flex items-center justify-between flex-shrink-0">
            <div className="text-base font-semibold text-textHeading">Artifacts</div>
            <button
              className="w-8 h-8 rounded hover:bg-bgCardAlt text-textPrimary"
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            <ArtifactList items={items} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-bgColumn">
      <div className="px-4 py-3 border-b border-bgCardAlt flex items-center justify-between flex-shrink-0">
        <div className="text-base font-semibold text-textHeading">Artifacts</div>
        <button
          className="w-8 h-8 rounded hover:bg-bgCardAlt text-textPrimary"
          onClick={onClose}
          aria-label="Close panel"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <ArtifactList items={items} />
      </div>
    </div>
  )
}
