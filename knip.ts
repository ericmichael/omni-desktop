import type { KnipConfig } from 'knip';

const config = {
  workspaces: {
    '.': {
      entry: [
        'electron.vite.config.ts',
        'vite.browser.config.ts',
        'vite.server.config.ts',
        'src/main/index.ts',
        'src/preload/index.ts',
        'src/renderer/index.ts',
        'src/server/index.ts',
        'tests/e2e/**/*.ts',
        'scripts/**/*.{js,mjs,ts}',
      ],
      project: ['*.{ts,tsx,js,mjs}', 'src/**/*.{ts,tsx}', 'tests/e2e/**/*.{ts,tsx}', 'scripts/**/*.{js,mjs,ts}'],
    },
    'packages/projects-db': {
      entry: ['src/**/*.test.ts'],
      project: ['src/**/*.ts'],
      ignoreUnresolved: ['tsx'],
    },
    'packages/projects-mcp': {
      project: ['src/**/*.ts', '*.ts'],
    },
  },
  ignoreDependencies: [
    // Optional/runtime provider packages and UI dependencies kept for feature-gated code paths.
    '@azure/storage-blob',
    '@excalidraw/excalidraw',
    '@fastify/http-proxy',
    '@radix-ui/react-collapsible',
    '@radix-ui/react-dropdown-menu',
    '@radix-ui/react-hover-card',
    '@radix-ui/react-scroll-area',
    '@radix-ui/react-select',
    '@radix-ui/react-separator',
    '@radix-ui/react-slot',
    '@renovatebot/pep440',
    // Recognized by Vite/Tailwind CSS plugins or package manager metadata rather than static imports.
    '@tailwindcss/typography',
    'linkify-react',
    'linkifyjs',
    'react-pdf',
    'tailwindcss',
    'typescript-eslint',
    'vite-plugin-eslint',
  ],
  ignoreBinaries: [
    // This is included with @electron/forge
    'electron-rebuild',
    // npm scripts intentionally execute the repo-local helper by path.
    'scripts/build-launcher-image.sh',
  ],
  ignore: [
    'forge.*.ts',
    'electron-builder.config.ts',
    'src/main/constants.ts',
    'src/main/repo-provider-handlers.ts',
    'src/main/util.ts',
    'src/renderer/common/ButtonWithTruncatedLabel.tsx',
    'src/renderer/common/CodeSplitLayout.tsx',
    'src/renderer/common/DiscordButton.tsx',
    'src/renderer/common/EllipsisLoadingText.tsx',
    'src/renderer/common/GitHubButton.tsx',
    'src/renderer/common/SessionStartupShell.tsx',
    'src/renderer/common/Strong.tsx',
    'src/renderer/common/layout.tsx',
    'src/renderer/features/Banner/Banner.tsx',
    'src/renderer/features/Pages/DatabaseView.tsx',
    'src/renderer/features/Pages/ExcalidrawCanvas.tsx',
    'src/renderer/features/SettingsModal/SettingsModalOpenButton.tsx',
    'src/renderer/features/Tickets/MilestoneSection.tsx',
    'src/renderer/features/Tickets/ProjectCardsGrid.tsx',
    'src/renderer/features/Tickets/ProjectFilesStrip.tsx',
    'src/renderer/features/Tickets/TicketForm.tsx',
    'src/renderer/features/Tickets/TicketSidePanel.tsx',
    'src/renderer/features/XTermLogViewer/XTermLogViewer.tsx',
    'src/renderer/features/XTermLogViewer/XTermLogViewerStatusIndicator.tsx',
    'src/renderer/omniagents-ui/components/ImageLightbox.tsx',
    'src/renderer/omniagents-ui/components/TerminalPanel.tsx',
    'src/renderer/omniagents-ui/components/ui/avatar.tsx',
    'src/renderer/omniagents-ui/components/ui/spinner.tsx',
    'src/renderer/omniagents-ui/components/ui/textarea.tsx',
    'src/renderer/omniagents-ui/shared/MarkdownMessage.tsx',
    'src/server/electron-store-shim.ts',
    'src/server/pg-settings-store.ts',
  ],
  paths: {
    'assets/*': ['assets/*'],
  },
  rules: {
    duplicates: 'off',
    exports: 'off',
    types: 'off',
  },
} satisfies KnipConfig;

export default config;
