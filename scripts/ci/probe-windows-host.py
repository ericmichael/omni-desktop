"""Probe the agent's real tools in native Windows ``host`` mode.

Runs against the installed runtime (omni-code + omniagents from the index),
binds a HostWorkspace the way a host-profile session does, and invokes the
actual tools. Prints a Markdown report (and appends it to the GitHub step
summary when available).

``--strict`` exits non-zero when any enforced check fails. Areas listed in
``REPORT_ONLY`` are reported but not enforced yet (known gaps).
"""

from __future__ import annotations

import asyncio
import json
import os
import platform
import shutil
import sys
import tempfile
import traceback

from agents.tool import ToolContext
from agents.usage import Usage

import omniagents
import omniagents.builtin.tools.bash_tool as bash_tool
import omniagents.builtin.tools.file_tools as file_tools
from omniagents.workspace import reset_workspace, set_workspace
from omniagents.workspace.host import HostWorkspace

ROWS: list[tuple[str, str, str, str]] = []
FAILURES: list[str] = []
# Interactive host terminals on Windows need a ConPTY backend (not built yet).
REPORT_ONLY = {"terminal"}


def record(area: str, case: str, ok: bool | None, detail: str) -> None:
    status = "✅" if ok else ("❌" if ok is False else "⚠️")
    if ok is False and area not in REPORT_ONLY:
        FAILURES.append(f"{area}: {case}")
    detail = " ".join(detail.split())[:220].replace("|", "\\|")
    ROWS.append((area, case, status, detail))


async def invoke(tool, root: str, **params):
    payload = {k: v for k, v in params.items() if v is not None}
    ctx = ToolContext(
        context={"workspace_root": root},
        usage=Usage(),
        tool_name=tool.name,
        tool_call_id="probe",
        tool_arguments=payload,
    )
    return await tool.on_invoke_tool(ctx, json.dumps(payload))


def text_of(result) -> str:
    for attr in ("llm_output",):
        value = getattr(result, attr, None)
        if value is not None:
            return str(value)
    return str(result)


async def main() -> None:
    root = tempfile.mkdtemp(prefix="omni probe ")
    ws = HostWorkspace(root=root)
    token = set_workspace(ws)
    try:
        # --- environment facts -------------------------------------------
        record("env", "platform", None, f"{platform.platform()} / Python {sys.version.split()[0]}")
        record("env", "omniagents", None, omniagents.__version__ if hasattr(omniagents, "__version__") else "?")
        for prog in ("bash", "sh", "git", "ls", "grep", "rg"):
            record("env", f"which {prog}", None, shutil.which(prog) or "(not found)")
        record("env", "SHELL / COMSPEC", None, f"SHELL={os.environ.get('SHELL')} COMSPEC={os.environ.get('COMSPEC')}")

        # --- file tools ----------------------------------------------------
        try:
            r = await invoke(file_tools.write_file, root, file_path="probe.txt", content="hello probe\nsecond line\n", append=False)
            exists = os.path.exists(os.path.join(root, "probe.txt"))
            record("file", "write_file relative", exists, text_of(r))
        except Exception as e:
            record("file", "write_file relative", False, repr(e))
        for label, path in (
            ("read_file relative", "probe.txt"),
            ("read_file absolute (\\)", os.path.join(root, "probe.txt")),
            ("read_file absolute (/)", os.path.join(root, "probe.txt").replace("\\", "/")),
        ):
            try:
                r = await invoke(file_tools.read_file, root, file_path=path)
                record("file", label, "hello probe" in text_of(r), text_of(r))
            except Exception as e:
                record("file", label, False, repr(e))
        try:
            r = await invoke(file_tools.list_directory, root, path=".")
            record("file", "list_directory", "probe.txt" in text_of(r), text_of(r))
        except Exception as e:
            record("file", "list_directory", False, repr(e))

        # --- execute_bash (foreground) -------------------------------------
        cases = [
            ("echo", "echo hello", "hello"),
            ("ls", "ls", "probe.txt"),
            ("pwd", "pwd", "probe"),
            ("pipe + grep", "echo abc | grep b", "abc"),
            ("env var", "export X=42 && echo $X", "42"),
            ("cat", "cat probe.txt", "hello probe"),
            ("single quotes", "echo 'a b'", "a b"),
            ("git", "git --version", "git version"),
            ("python", "python --version", "Python"),
            ("shell is bash", "echo $BASH_VERSION", "."),
            ("sed", "echo hello | sed s/hello/bye/", "bye"),
        ]
        for label, command, expect in cases:
            try:
                r = await invoke(bash_tool.execute_bash, root, command=command, timeout=30)
                out = text_of(r)
                ok = (expect in out) if expect else None
                if label == "single quotes":
                    # cmd.exe would print the quotes literally.
                    ok = ok and "'a b'" not in out
                record("bash", f"{label}: `{command}`", ok, out)
            except Exception as e:
                record("bash", f"{label}: `{command}`", False, repr(e))

        # --- execute_bash (background) -------------------------------------
        try:
            r = await invoke(bash_tool.execute_bash, root, command="echo bg-done", background=True)
            meta = (getattr(r, "ui_metadata", {}) or {}).get("metadata", {})
            log_path = meta.get("log_path")
            await asyncio.sleep(3)
            content = ""
            if log_path and os.path.exists(log_path):
                with open(log_path, encoding="utf-8", errors="replace") as fh:
                    content = fh.read()
            record("bash-bg", "background echo → log", "bg-done" in content, f"log={log_path} content={content!r} | {text_of(r)}")
        except Exception as e:
            record("bash-bg", "background echo → log", False, repr(e))

        # --- terminal ---------------------------------------------------------
        try:
            from omniagents.rpc.terminal import TerminalManager

            tm = TerminalManager(default_cwd=root)
            shell = tm._resolve_shell(None)
            record("terminal", "default shell", bool(shutil.which(shell) or os.path.exists(shell)), shell)
            try:
                info = await asyncio.wait_for(tm.create_terminal("probe-session", cwd=root), timeout=20)
                record("terminal", "create default terminal", True, json.dumps({k: str(v) for k, v in info.items()})[:200])
            except Exception as e:
                record("terminal", "create default terminal", False, repr(e))
        except Exception as e:
            record("terminal", "setup", False, traceback.format_exc(limit=2))
    finally:
        reset_workspace(token)

    lines = ["| area | case | ok | detail |", "|---|---|---|---|"]
    lines += [f"| {a} | {c} | {s} | {d} |" for a, c, s, d in ROWS]
    report = "## Native Windows host-mode probe\n\n" + "\n".join(lines) + "\n"
    print(report)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(report)
    if FAILURES:
        print("FAILED: " + "; ".join(FAILURES))
    sys.stdout.flush()
    # The probe terminal's shell and background jobs are still alive; skip
    # asyncio's task-cancellation teardown, which would wait on them.
    os._exit(1 if FAILURES and "--strict" in sys.argv else 0)


if __name__ == "__main__":
    asyncio.run(main())
