import type { ChildProcess } from 'child_process';
import { exec, execFile } from 'child_process';
import type { BrowserWindow } from 'electron';
import { app, screen } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

import { checkOmniVersion } from '@/lib/omni-version';
import { withResultAsync } from '@/lib/result';
import type { GpuType, OmniRuntimeInfo, OperatingSystem, WindowProps } from '@/shared/types';

const execAsync = promisify(exec);

//#region Platform

export const getOperatingSystem = (): OperatingSystem => {
  if (process.platform === 'win32') {
    return 'Windows';
  } else if (process.platform === 'darwin') {
    return 'macOS';
  } else {
    return 'Linux';
  }
};

/**
 * Get the path to the bundled bin directory. This directory holds executables that are bundled with the app. These
 * resources are extracted at runtime and deleted when the app is closed - do not store anything important here.
 */
export const getBundledBinPath = (): string => {
  if (isDevelopment() || !app.isPackaged || !process.resourcesPath) {
    // In development, resolve from project root
    return path.resolve(path.join(__dirname, '..', '..', 'assets', 'bin'));
  } else {
    // In production, assets are copied to the resources directory
    return path.resolve(path.join(process.resourcesPath, 'bin'));
  }
};

/**
 * Get the path to the uv executable
 */
export const getUVExecutablePath = (): string => {
  const uvName = process.platform === 'win32' ? 'uv.exe' : 'uv';
  return path.join(getBundledBinPath(), uvName);
};

export const getOmniRuntimeDir = (): string => {
  return path.join(app.getPath('userData'), 'omni');
};

export const getOmniVenvPath = (): string => {
  return path.join(getOmniRuntimeDir(), '.venv');
};

export const getOmniPythonPath = (): string => {
  const venvPath = getOmniVenvPath();
  return path.join(venvPath, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
};

export const getOmniCliPath = (): string => {
  if (isDevelopment()) {
    const devPath = process.env.OMNI_CODE_DEV_PATH;
    if (devPath) {
      return devPath;
    }
  }
  const venvPath = getOmniVenvPath();
  return path.join(venvPath, process.platform === 'win32' ? 'Scripts/omni.exe' : 'bin/omni');
};

/**
 * Gets the path to the `activate` executable in the given installation location
 */
const getActivateVenvPath = (installLocation: string): string => {
  return process.platform === 'win32'
    ? path.join(installLocation, '.venv', 'Scripts', 'Activate.ps1')
    : path.join(installLocation, '.venv', 'bin', 'activate');
};

export const getActivateVenvCommand = (installLocation: string): string => {
  const activateVenvPath = getActivateVenvPath(installLocation);
  return process.platform === 'win32' ? `& "${activateVenvPath}"` : `source "${activateVenvPath}"`;
};

/**
 * Gets the appropriate platform for a given GPU type.
 *
 * Note: If the system is MacOS, we return 'cpu' regardless of the given GPU type.
 *
 * @param gpuType The GPU type
 * @returns The platform corresponding to the GPU type
 */
export const getTorchPlatform = (gpuType: GpuType): 'cuda' | 'rocm' | 'cpu' => {
  if (process.platform === 'darwin') {
    // macOS uses MPS, but we don't need to provide a separate option for this because pytorch doesn't have a separate index url for MPS
    return 'cpu';
  } else {
    switch (gpuType) {
      case 'amd':
        return 'rocm';
      case 'nvidia<30xx':
      case 'nvidia>=30xx':
        return 'cuda';
      case 'nogpu':
        return 'cpu';
      default:
        // Default to cuda because in reality this is the most common gpu type at the moment
        return 'cuda';
    }
  }
};

//#endregion

//#region Path validation

/**
 * Validates that filePath is within configDir. Throws if not.
 * Protects config:* IPC handlers from path traversal attacks.
 */
export function validateConfigPath(filePath: string, configDir: string): void {
  const resolvedFile = path.resolve(filePath);
  const resolvedConfig = path.resolve(configDir);
  if (!resolvedFile.startsWith(resolvedConfig + path.sep) && resolvedFile !== resolvedConfig) {
    throw new Error('Access denied: path is outside the config directory');
  }
  if (filePath.includes('\0')) {
    throw new Error('Invalid path: contains null byte');
  }
}

/** Maximum number of path segments accepted by `util:ensure-directory`. */
export const MAX_USER_PATH_DEPTH = 32;

/**
 * Light validation for user-controlled paths handed to `util:*` IPC
 * handlers (e.g., `DirectoryBrowserDialog` browses arbitrary filesystem
 * locations to let the user pick a workspace dir).
 *
 * Deliberately weaker than `validateConfigPath` — it has to allow paths
 * outside the config dir because that's the whole point of the directory
 * browser. Catches the cheap, no-false-positive footguns:
 *
 *   - null bytes in the path (truncation attack against C-string APIs)
 *   - resource-abuse depth: rejecting `a/a/a/.../a` chains so a malicious
 *     client can't ask the main process to mkdir thousands of nested
 *     directories. Only relevant for `ensureDirectory` callers.
 *
 * Does not constrain the path to any particular root — picking arbitrary
 * locations is the legitimate use case.
 */
export function validateUserPath(filePath: string, opts: { checkDepth?: boolean } = {}): void {
  if (filePath.includes('\0')) {
    throw new Error('Invalid path: contains null byte');
  }
  if (opts.checkDepth) {
    const resolved = path.resolve(filePath);
    const segments = resolved.split(path.sep).filter(Boolean);
    if (segments.length > MAX_USER_PATH_DEPTH) {
      throw new Error(`Invalid path: exceeds maximum depth of ${MAX_USER_PATH_DEPTH} segments`);
    }
  }
}

//#endregion

//#region Convention defaults

/**
 * Get the omni-code config directory, matching the path logic in omni_code/config.py.
 * Windows: %APPDATA%/OmniCode, Linux: ~/.config/omni_code
 */
export const getOmniConfigDir = (): string => {
  if (process.platform === 'win32') {
    return path.join(app.getPath('appData'), 'OmniCode');
  }
  const xdgConfig = process.env['XDG_CONFIG_HOME'];
  if (xdgConfig) {
    return path.join(xdgConfig, 'omni_code');
  }
  return path.join(app.getPath('home'), '.config', 'omni_code');
};

export const getDefaultWorkspaceDir = (): string => {
  return path.join(app.getPath('home'), 'Omni', 'Workspace');
};

export const getProjectsDir = (): string => {
  return path.join(getDefaultWorkspaceDir(), 'Projects');
};

export const getProjectDir = (slug: string): string => {
  return path.join(getProjectsDir(), slug);
};

/** Generate a filesystem-safe slug from a project label. */
export const slugify = (label: string): string => {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'project'
  );
};

export const getWorktreesDir = (): string => {
  return path.join(app.getPath('home'), 'Omni', 'Worktrees');
};

export const ensureDirectory = async (dirPath: string): Promise<boolean> => {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    return true;
  } catch {
    return false;
  }
};

//#endregion

//#region Filesystem

/**
 * Get the path to the user's home directory
 * @returns The path to the user's home directory
 */
export const getHomeDirectory = (): string => app.getPath('home');

/**
 * Check if a path is a directory
 * @param path The path to check
 * @returns Whether the path is a directory
 */
export const isDirectory = async (path: string): Promise<boolean> => {
  try {
    const stats = await fs.stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
};

/**
 * Check if a path is a file
 * @param path The path to check
 * @returns Whether the path is a file
 */
export const isFile = async (path: string): Promise<boolean> => {
  try {
    const stats = await fs.stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
};

/**
 * Check if a path exists
 * @param path The path to check
 * @returns Whether the path exists
 */
export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Get the version of python at the provided path.
 *
 * @param pythonPath
 * @returns The python version as a string.
 */
const getPythonVersion = async (pythonPath: string): Promise<string> => {
  const cmd = `"${pythonPath}" -c "import sys; print(sys.version.split()[0]);"`;
  const { stdout } = await execAsync(cmd);
  return stdout.replace(/[\r\n]+/g, '');
};

/**
 * Get the version of a Python package installed
 *
 * @param pythonPath Path to python executable to use (probably in a virtualenv)
 * @param packageName Name of the package to check
 * @returns The package version or null if not found
 */
const getPackageVersion = async (pythonPath: string, packageName: string): Promise<string | null> => {
  const result = await withResultAsync(async () => {
    const cmd = `"${pythonPath}" -c "from importlib.metadata import version; print(version('${packageName}'));"`;
    const { stdout } = await execAsync(cmd);
    return stdout;
  });

  if (result.isErr()) {
    console.debug(`Failed to get version for package ${packageName}:`, result.error);
    return null;
  }

  return result.value.replace(/[\r\n]+/g, '');
};

export const getOmniRuntimeInfo = async (): Promise<OmniRuntimeInfo> => {
  const omniPath = getOmniCliPath();
  const pythonPath = getOmniPythonPath();

  if (!(await isFile(omniPath)) || !(await isFile(pythonPath))) {
    return { isInstalled: false };
  }

  const version = await getPackageVersion(pythonPath, 'omni-code');

  if (!version) {
    return { isInstalled: false };
  }

  const pythonVersion = await getPythonVersion(pythonPath);
  const versionCheck = checkOmniVersion(version);

  return {
    isInstalled: true,
    version,
    expectedVersion: versionCheck.expectedVersion,
    isOutdated: versionCheck.isOutdated,
    pythonVersion,
    omniPath,
  };
};

//#endregion

//#region CLI PATH install

/**
 * Get the directory where we install the `omni` CLI command.
 * - Linux/macOS: ~/.local/bin (XDG standard, typically on PATH)
 * - Windows: %LOCALAPPDATA%\omni (added to user PATH via registry)
 */
export const getCliInstallDir = (): string => {
  if (process.platform === 'win32') {
    return path.join(app.getPath('appData'), '..', 'Local', 'omni');
  }
  return path.join(app.getPath('home'), '.local', 'bin');
};

/**
 * Get the full path of the installed `omni` command.
 * - Linux/macOS: ~/.local/bin/omni (symlink)
 * - Windows: %LOCALAPPDATA%\omni\omni.cmd (batch shim)
 */
export const getCliInstalledPath = (): string => {
  if (process.platform === 'win32') {
    return path.join(getCliInstallDir(), 'omni.cmd');
  }
  return path.join(getCliInstallDir(), 'omni');
};

// Keep old names as aliases for backward compatibility with IPC callers
export const getCliSymlinkDir = getCliInstallDir;
export const getCliSymlinkPath = getCliInstalledPath;

/**
 * Check if the `omni` CLI command is currently installed and points to our venv binary.
 */
export const isCliInstalledInPath = async (): Promise<boolean> => {
  const installedPath = getCliInstalledPath();

  if (process.platform === 'win32') {
    // On Windows, check that the .cmd shim exists and contains the correct target path
    try {
      const content = await fs.readFile(installedPath, 'utf-8');
      return content.includes(getOmniCliPath());
    } catch {
      return false;
    }
  }

  // On Unix, check that the symlink points to the correct binary
  try {
    const target = await fs.readlink(installedPath);
    return target === getOmniCliPath();
  } catch {
    return false;
  }
};

/**
 * On macOS/Linux, ensure ~/.local/bin is in the user's shell PATH by appending an export line
 * to the appropriate shell profile if it's not already present.
 */
const ensureUnixPathEntry = async (dir: string): Promise<void> => {
  const home = app.getPath('home');
  const exportLine = `export PATH="${dir}:$PATH"`;

  // Determine which shell profiles to update
  const profiles: string[] = [];
  if (process.platform === 'darwin') {
    // macOS defaults to zsh since Catalina
    profiles.push(path.join(home, '.zshrc'));
    // Also add to .bashrc in case user switches shells
    profiles.push(path.join(home, '.bashrc'));
  } else {
    // Linux: check for both bash and zsh
    profiles.push(path.join(home, '.bashrc'));
    const zshrc = path.join(home, '.zshrc');
    if (await pathExists(zshrc)) {
      profiles.push(zshrc);
    }
  }

  for (const profile of profiles) {
    try {
      let content = '';
      try {
        content = await fs.readFile(profile, 'utf-8');
      } catch {
        // File doesn't exist — we'll create it
      }

      // Skip if the directory is already referenced in PATH setup
      if (content.includes(dir)) {
        continue;
      }

      const addition = `\n# Added by Omni Code\n${exportLine}\n`;
      await fs.appendFile(profile, addition);
    } catch {
      // Best-effort — don't fail the install if we can't modify a profile
    }
  }
};

/**
 * On Windows, add a directory to the user-level PATH via the registry.
 * This does not require admin privileges. Broadcasts WM_SETTINGCHANGE so
 * running shells pick up the change.
 */
const ensureWindowsPathEntry = async (dir: string): Promise<void> => {
  // Read current user PATH from registry
  const { stdout: currentPath } = await execAsync('reg query "HKCU\\Environment" /v Path', { timeout: 5000 }).catch(
    () => ({ stdout: '' })
  );

  // Parse the value from reg query output (format: "    Path    REG_EXPAND_SZ    value")
  const match = currentPath.match(/Path\s+REG_\w+\s+(.*)/i);
  const existingPath = match?.[1]?.trim() ?? '';

  // Check if our directory is already in PATH
  const entries = existingPath.split(';').map((e) => e.trim().toLowerCase());
  if (entries.includes(dir.toLowerCase())) {
    return;
  }

  // Append our directory
  const newPath = existingPath ? `${existingPath};${dir}` : dir;

  // Write back to registry (user-level, no admin needed)
  await execAsync(`reg add "HKCU\\Environment" /v Path /t REG_EXPAND_SZ /d "${newPath}" /f`, { timeout: 5000 });

  // Broadcast WM_SETTINGCHANGE so running Explorer/shells pick up the change
  // We use a small PowerShell snippet since there's no native Node way to do this
  await execAsync(
    "powershell -NoProfile -Command \"[Environment]::SetEnvironmentVariable('__omni_noop', $null, 'User')\"",
    { timeout: 5000 }
  ).catch(() => {
    // Best-effort — the PATH is still updated, new terminals will pick it up
  });
};

/**
 * Install the `omni` CLI command to the user's PATH.
 * - Linux/macOS: creates a symlink at ~/.local/bin/omni + ensures PATH entry in shell profile
 * - Windows: creates a .cmd shim at %LOCALAPPDATA%\omni\omni.cmd + adds to user PATH via registry
 */
export const installCliToPath = async (): Promise<
  { success: true; symlinkPath: string } | { success: false; error: string }
> => {
  const target = getOmniCliPath();
  const installedPath = getCliInstalledPath();
  const installDir = getCliInstallDir();

  // Verify the omni binary actually exists
  if (!(await isFile(target))) {
    return { success: false, error: 'Omni runtime is not installed. Install it first.' };
  }

  // Ensure install directory exists
  try {
    await fs.mkdir(installDir, { recursive: true });
  } catch (e) {
    return { success: false, error: `Failed to create directory ${installDir}: ${String(e)}` };
  }

  if (process.platform === 'win32') {
    // Windows: create a .cmd shim
    const shimContent = `@echo off\r\n"${target}" %*\r\n`;
    try {
      await fs.writeFile(installedPath, shimContent, 'utf-8');
    } catch (e) {
      return { success: false, error: `Failed to create CLI shim: ${String(e)}` };
    }

    // Add install directory to user PATH
    try {
      await ensureWindowsPathEntry(installDir);
    } catch (e) {
      return { success: false, error: `CLI installed but failed to add to PATH: ${String(e)}` };
    }
  } else {
    // Unix: create a symlink
    // Remove existing symlink/file if present
    try {
      const stat = await fs.lstat(installedPath);
      if (stat.isSymbolicLink() || stat.isFile()) {
        await fs.unlink(installedPath);
      }
    } catch {
      // Does not exist — that's fine
    }

    try {
      await fs.symlink(target, installedPath);
    } catch (e) {
      return { success: false, error: `Failed to create symlink: ${String(e)}` };
    }

    // Ensure ~/.local/bin is in the user's shell PATH
    try {
      await ensureUnixPathEntry(installDir);
    } catch {
      // Best-effort — symlink is still created
    }
  }

  return { success: true, symlinkPath: installedPath };
};

//#endregion

//#region Omni CLI commands

/**
 * Check if models are configured by running `omni model check`.
 * Returns true if exit code is 0, false otherwise.
 */
export const checkModelsConfigured = async (): Promise<boolean> => {
  const omniPath = getOmniCliPath();
  try {
    await execAsync(`"${omniPath}" model check`);
    return true;
  } catch {
    return false;
  }
};

/**
 * Test a model connection by running `omni model test [ref]`.
 * Returns success/failure and the command output.
 */
export const testModelConnection = async (modelRef?: string): Promise<{ success: boolean; output: string }> => {
  const omniPath = getOmniCliPath();
  const cmd = modelRef ? `"${omniPath}" model test "${modelRef}"` : `"${omniPath}" model test`;
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 30_000 });
    return { success: true, output: (stdout + stderr).trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const output = ((err.stdout ?? '') + (err.stderr ?? '')).trim() || err.message || 'Unknown error';
    return { success: false, output };
  }
};

//#endregion

//#region Process

/**
 * Kills a child process using the appropriate method for the platform
 * @param childProcess The child process to kill
 * @returns Promise that resolves when the process has been terminated
 */
export const killProcess = async (childProcess: ChildProcess): Promise<void> => {
  if (childProcess.pid === undefined) {
    // He's dead, Jim
    return;
  }

  const pid = childProcess.pid;

  // Helper to check if process is still running
  const isProcessRunning = (): boolean => {
    // First check if Node.js knows the process is dead
    if (childProcess.killed || childProcess.exitCode !== null) {
      return false;
    }

    try {
      // process.kill(pid, 0) checks if process exists without killing it
      // This can have false positives due to PID reuse, so we check childProcess.killed first
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  // Helper to wait for process exit with timeout
  const waitForExit = (timeoutMs: number): Promise<boolean> => {
    return new Promise((resolve) => {
      // If process has exit handler, use it for more reliable detection
      const exitHandler = () => {
        resolve(true);
      };

      // Try to attach exit handler if process is still alive
      if (!childProcess.killed) {
        childProcess.once('exit', exitHandler);
      }

      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        if (!isProcessRunning()) {
          clearInterval(checkInterval);
          childProcess.removeListener('exit', exitHandler);
          resolve(true);
        } else if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          childProcess.removeListener('exit', exitHandler);
          resolve(false);
        }
      }, 100);
    });
  };

  if (process.platform === 'win32') {
    // Windows: Try graceful shutdown first, then escalate if needed

    // Stage 1: Try graceful shutdown (sends WM_CLOSE)
    try {
      execFile('taskkill', ['/pid', pid.toString(), '/T'], (error) => {
        // Ignore error - process might resist graceful shutdown
        if (error) {
          console.debug(`Graceful shutdown failed for PID ${pid}: ${error.message}`);
        }
      });

      // Wait up to 5 seconds for graceful exit
      const exitedGracefully = await waitForExit(5000);
      if (exitedGracefully) {
        console.debug(`Process ${pid} terminated gracefully`);
        return;
      }
    } catch (error) {
      console.debug(`Failed to send graceful shutdown signal: ${error}`);
    }

    // Stage 2: Try Node's kill (might work for some processes)
    try {
      childProcess.kill('SIGTERM');

      // Wait 2 more seconds
      const exitedWithSigterm = await waitForExit(2000);
      if (exitedWithSigterm) {
        console.debug(`Process ${pid} terminated with SIGTERM`);
        return;
      }
    } catch (error) {
      console.debug(`SIGTERM failed: ${error}`);
    }

    // Stage 3: Force kill as last resort
    try {
      execFile('taskkill', ['/pid', pid.toString(), '/T', '/F'], (error) => {
        if (error) {
          console.error(`Force kill failed for PID ${pid}: ${error.message}`);
        }
      });

      // Wait for force kill to complete
      const exitedForcefully = await waitForExit(2000);
      if (!exitedForcefully) {
        console.error(`Process ${pid} could not be terminated even with force kill`);
      } else {
        console.debug(`Process ${pid} force terminated`);
      }
    } catch (error) {
      console.error(`Critical error killing process ${pid}: ${error}`);
    }
  } else {
    // Unix-like systems: Use SIGTERM
    childProcess.kill('SIGTERM');

    // Wait for process to exit
    const exited = await waitForExit(5000);
    if (!exited) {
      // Try SIGKILL as last resort
      try {
        childProcess.kill('SIGKILL');
        await waitForExit(2000);
      } catch (error) {
        console.error(`Failed to kill process ${pid}: ${error}`);
      }
    }
  }
};

/**
 * Gets the shell to use for running commands. If the COMSPEC (Windows) or SHELL (Linux/macOS) environment variables
 * are set, they will be used. Otherwise, Windows will default to Powershell and Linux/macOS will default to sh.
 * @returns The shell to use for running commands
 */
export const getShell = () => {
  if (process.platform === 'win32') {
    return 'Powershell.exe';
  } else if (process.platform === 'darwin') {
    return '/bin/zsh';
  } else {
    // Linux
    return '/bin/bash';
  }
};

//#endregion

//#region Environment

/**
 * Check if the current environment is development
 * @returns Whether the current environment is development
 */
export const isDevelopment = (): boolean => process.env.NODE_ENV === 'development';

//#endregion

//#region Window mgmt

/**
 * Checks if the given rect exceeds the screen bounds
 */
const exceedsScreenBounds = (bounds: Electron.Rectangle): boolean => {
  const screenArea = screen.getDisplayMatching(bounds).workArea;
  return (
    bounds.x > screenArea.x + screenArea.width ||
    bounds.x < screenArea.x ||
    bounds.y < screenArea.y ||
    bounds.y > screenArea.y + screenArea.height
  );
};

/**
 * Manages a window's size:
 * - Restores the window to its previous size and position, maximizing or fullscreening it if necessary
 * - Saves the window's size and position when it is closed
 * - If provided, uses the initialProps to set the window's size and position
 *
 * The window will not be set to the stored/initial bounds if it exceeds the current screen bounds.
 *
 * @param window The window to manage
 * @param windowProps The stored window properties
 * @param setWindowProps The function to call to save the window properties
 * @param initialProps The initial window properties to use if there are no stored properties
 */
export const manageWindowSize = (
  window: BrowserWindow,
  windowProps: WindowProps | undefined,
  setWindowProps: (windowProps: WindowProps) => void,
  initialProps?: Partial<WindowProps>
): void => {
  if (windowProps) {
    // Restore window size and position
    const { bounds, isMaximized, isFullScreen } = windowProps;
    if (!exceedsScreenBounds(bounds)) {
      window.setBounds(bounds);
    }
    if (isMaximized) {
      window.maximize();
    }
    if (isFullScreen) {
      window.setFullScreen(true);
    }
  } else if (initialProps) {
    // No stored properties, use initial properties if they exist
    const { bounds, isMaximized, isFullScreen } = initialProps;
    if (bounds && !exceedsScreenBounds(bounds)) {
      window.setBounds(bounds);
    }
    if (isMaximized) {
      window.maximize();
    }
    if (isFullScreen) {
      window.setFullScreen(true);
    }
  }

  // Save window size and position when it is closed and clear the event listener
  const handleClose = () => {
    setWindowProps({
      bounds: window.getBounds(),
      isMaximized: window.isMaximized(),
      isFullScreen: window.isFullScreen(),
    });
    window.off('close', handleClose);
  };

  window.on('close', handleClose);
};
