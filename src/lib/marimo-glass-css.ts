/**
 * CSS shipped to marimo via the per-notebook `css_file` argument.
 *
 * Marimo inlines this file's contents into the notebook HTML on every page
 * load (see `marimo/_server/templates/templates.py:read_css_file`). We control
 * the file from the main process and rewrite it on glass-mode toggle, then
 * reload the marimo webview to pick up the change.
 *
 * Two states:
 *   - `MARIMO_GLASS_CSS_OFF`: empty string, marimo renders normally.
 *   - `MARIMO_GLASS_CSS_ON`:  shadcn variable overrides + transparent body so
 *     the launcher's blurred background shows through.
 */

export const MARIMO_GLASS_CSS_OFF = '';

/*
 * Glass mode for marimo is currently disabled. The plumbing (sidecar CSS
 * file, prepare-notebook IPC, set-notebook-glass IPC, NotebookView reload
 * effect) is left intact so re-enabling is a one-edit change here, but the
 * stylesheet itself is empty — marimo renders with its own default theme
 * regardless of the launcher's glass mode.
 *
 * Reason this approach didn't work: marimo's frontend is a mix of shadcn
 * variables, Radix color palettes, and hardcoded Tailwind utility colors,
 * with CodeMirror running its own light-theme syntax tokens on top. Getting
 * all of those to read against a transparent dark backdrop without breaking
 * legibility somewhere is a moving target — the right fix is for marimo to
 * support a real dark theme upstream, not for us to patch CSS variables.
 */
export const MARIMO_GLASS_CSS_ON = '';

export const MARIMO_GLASS_CSS_FILENAME = 'marimo-glass.css';
