/**
 * Reader-mode stylesheet. Keeps the injected CSS narrow on purpose — it's a
 * best-effort reformat, not a real Reader View (no DOM surgery, no parsed
 * article extraction). For most blog-style pages this is enough to make
 * text readable at a glance; for heavily-designed sites the user can just
 * toggle it off.
 */
export const READER_MODE_CSS = `
  /* Typography */
  html, body {
    background: #faf8f4 !important;
    color: #1f1f1f !important;
    font-family: Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', serif !important;
    font-size: 18px !important;
    line-height: 1.7 !important;
  }

  /* Center the main content column */
  body {
    max-width: 720px !important;
    margin: 0 auto !important;
    padding: 48px 24px !important;
  }

  /* Demote common non-article chrome without fully hiding it (some sites put
   * article body inside <nav>, so we stop short of display: none). */
  nav, aside, header > nav, footer, [role="navigation"], [role="complementary"],
  [role="banner"], [role="contentinfo"], .ad, .ads, .advertisement, [aria-label="advertisement"] {
    display: none !important;
  }

  /* Readability-friendly defaults */
  a { color: #1455b8 !important; text-decoration: underline !important; }
  p, li, blockquote { font-size: 18px !important; }
  blockquote { border-left: 3px solid #d0c8b8 !important; padding-left: 16px !important; margin-left: 0 !important; color: #3a3a3a !important; }
  h1, h2, h3, h4 { color: #111 !important; font-family: inherit !important; }
  img, video, figure { max-width: 100% !important; height: auto !important; }
  pre, code { font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace !important; font-size: 14px !important; background: #efe9dd !important; border-radius: 4px !important; padding: 2px 6px !important; }
  pre { padding: 12px 14px !important; overflow: auto !important; }
  hr { border: none !important; border-top: 1px solid #d0c8b8 !important; margin: 32px 0 !important; }

  @media (prefers-color-scheme: dark) {
    html, body { background: #1a1a1a !important; color: #e8e5df !important; }
    a { color: #6aa8ff !important; }
    h1, h2, h3, h4 { color: #f4f2ed !important; }
    blockquote { border-color: #3a3a3a !important; color: #bfbaaf !important; }
    pre, code { background: #2a2a2a !important; }
    hr { border-color: #3a3a3a !important; }
  }
`;
