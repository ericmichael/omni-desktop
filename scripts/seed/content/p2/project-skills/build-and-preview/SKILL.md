---
name: build-and-preview
description: Build the production bundle and start the preview server on localhost so the user can click through the v0.1 experience.
version: 0.1.0
author: Omni Seed
---

# Build and Preview

Produce a production build and serve it locally.

## Commands

```
npm run build
npm run preview
```

`preview` binds to http://localhost:4173 by default.

## Reporting

- If build fails, surface the first compile/type error — don't read past it.
- If build succeeds, report bundle size (the `dist/assets/*.js` total in KB) — this project is supposed to stay under 200KB gzipped, and drift is a signal.
- Once `preview` is live, tell the user the URL and stop. Don't try to open the browser for them; they'll click it.

## Scope

Specific to `habit-tracker`. Knows:
- Build output goes to `dist/`.
- Preview is the command that matters for "does v0.1 actually run end-to-end" — dev mode can hide build-time bugs.
