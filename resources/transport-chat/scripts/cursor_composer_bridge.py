#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cursor_chat_io_common import (
    activation_dir,
    activation_pending_path,
    activation_result_path,
)

PENDING_PATH = activation_pending_path()
RESULT_PATH = activation_result_path()
MANIFEST_VERSION = 1
CREATE_COMPOSER_COMMAND_ID = "composer.createComposer"


def _log_err(msg: str) -> None:
    print(msg, file=sys.stderr)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_manifest_stdin() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("empty stdin; pass JSON manifest or use --manifest")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("manifest must be a JSON object")
    return data


def _read_manifest(path: Path | None) -> dict[str, Any]:
    if path is None:
        return _read_manifest_stdin()
    text = path.expanduser().read_text(encoding="utf-8")
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("manifest must be a JSON object")
    return data


def _composer_id_from_partial(partial_state: dict[str, Any]) -> str:
    cid = partial_state.get("composerId")
    if not isinstance(cid, str) or not cid.strip():
        raise ValueError("partialState.composerId is required")
    return cid.strip()


def normalize_manifest(raw: dict[str, Any]) -> dict[str, Any]:
    partial = raw.get("partialState")
    if not isinstance(partial, dict):
        raise ValueError("manifest.partialState object is required")

    workspace_folder = raw.get("workspaceFolder")
    if not isinstance(workspace_folder, str) or not workspace_folder.strip():
        raise ValueError("manifest.workspaceFolder (absolute path) is required")
    workspace_folder = str(Path(workspace_folder).expanduser().resolve())

    open_in_new_tab = raw.get("openInNewTab")
    if open_in_new_tab is None:
        open_in_new_tab = True
    if not isinstance(open_in_new_tab, bool):
        raise ValueError("manifest.openInNewTab must be a boolean")

    composer_id = _composer_id_from_partial(partial)
    options = raw.get("createComposerOptions")
    if options is None:
        options = {"openInNewTab": open_in_new_tab, "view": "editor"}
    elif not isinstance(options, dict):
        raise ValueError("manifest.createComposerOptions must be an object when set")
    else:
        options = dict(options)
        options.setdefault("openInNewTab", open_in_new_tab)

    return {
        "version": MANIFEST_VERSION,
        "composerId": composer_id,
        "partialState": partial,
        "workspaceFolder": workspace_folder,
        "openInNewTab": open_in_new_tab,
        "createComposerOptions": options,
        "commandId": CREATE_COMPOSER_COMMAND_ID,
        "stagedAt": _utc_now_iso(),
    }


def stage_manifest(manifest: dict[str, Any]) -> Path:
    activation_dir().mkdir(parents=True, exist_ok=True)
    tmp = PENDING_PATH.with_suffix(".json.tmp")
    payload = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(PENDING_PATH)
    return PENDING_PATH


def _parse_success_stdout(text: str) -> str | None:
    text = text.strip()
    if not text:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    cid = data.get("composerId")
    if isinstance(cid, str) and cid.strip():
        return cid.strip()
    return None


def _read_result_file() -> str | None:
    if not RESULT_PATH.is_file():
        return None
    try:
        data = json.loads(RESULT_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    if data.get("ok") is False:
        return None
    cid = data.get("composerId")
    if isinstance(cid, str) and cid.strip():
        return cid.strip()
    return None


def _clear_stale_result() -> None:
    if RESULT_PATH.is_file():
        try:
            RESULT_PATH.unlink()
        except OSError:
            pass


def find_cursor_binary() -> str | None:
    env = os.environ.get("CURSOR_CLI")
    if env:
        p = Path(env).expanduser()
        if p.is_file():
            return str(p)
    for name in ("cursor", "code"):
        found = shutil.which(name)
        if found:
            return found
    return None


def _cursor_cli_supports_command(cursor_bin: str) -> str | None:
    try:
        proc = subprocess.run(
            [cursor_bin, "--help"],
            capture_output=True,
            text=True,
            timeout=12,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    help_text = (proc.stdout or "") + (proc.stderr or "")
    for flag in ("--execute-command", "--command"):
        if flag in help_text:
            return flag
    return None


def try_cursor_cli_activate(manifest: dict[str, Any], cursor_bin: str) -> str | None:
    flag = _cursor_cli_supports_command(cursor_bin)
    if not flag:
        return None

    payload = json.dumps(
        {
            "command": manifest["commandId"],
            "args": {
                "partialState": manifest["partialState"],
                **manifest["createComposerOptions"],
            },
        },
        separators=(",", ":"),
    )
    cmd = [
        cursor_bin,
        flag,
        manifest["commandId"],
        payload,
        "-r",
        manifest["workspaceFolder"],
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        _log_err(f"cursor CLI activation failed: {exc}")
        return None

    if proc.stderr:
        _log_err(proc.stderr.strip())
    cid = _parse_success_stdout(proc.stdout or "")
    if cid:
        return cid
    if proc.returncode == 0:
        return manifest["composerId"]
    _log_err(
        f"cursor CLI exited {proc.returncode}; no composerId on stdout "
        f"(tried {flag})"
    )
    return None


def try_custom_hook(manifest: dict[str, Any], pending_path: Path) -> str | None:
    hook = os.environ.get("CURSOR_COMPOSER_BRIDGE_COMMAND", "").strip()
    if not hook:
        return None

    env = os.environ.copy()
    env["CURSOR_IMPORT_MANIFEST"] = str(pending_path)
    env["CURSOR_IMPORT_COMPOSER_ID"] = manifest["composerId"]
    env["CURSOR_IMPORT_WORKSPACE"] = manifest["workspaceFolder"]
    try:
        proc = subprocess.run(
            hook,
            shell=True,
            capture_output=True,
            text=True,
            timeout=120,
            env=env,
            cwd=manifest["workspaceFolder"],
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        _log_err(f"CURSOR_COMPOSER_BRIDGE_COMMAND failed: {exc}")
        return None

    if proc.stderr:
        _log_err(proc.stderr.strip())
    cid = _parse_success_stdout(proc.stdout or "")
    if cid:
        return cid
    if proc.returncode == 0:
        return manifest["composerId"]
    _log_err(f"bridge hook exited {proc.returncode} without composerId JSON on stdout")
    return None


def wait_for_result_file(timeout_s: float) -> str | None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        cid = _read_result_file()
        if cid:
            return cid
        time.sleep(0.25)
    return None


def emit_success(composer_id: str) -> None:
    sys.stdout.write(json.dumps({"composerId": composer_id}, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def activate(
    raw_manifest: dict[str, Any],
    *,
    wait_result_s: float = 0.0,
    focus_workspace: bool = True,
) -> int:
    try:
        manifest = normalize_manifest(raw_manifest)
    except ValueError as exc:
        _log_err(f"invalid manifest: {exc}")
        return 1

    _clear_stale_result()
    pending_path = stage_manifest(manifest)

    cursor_bin = find_cursor_binary()
    if focus_workspace and cursor_bin:
        try:
            subprocess.run(
                [cursor_bin, "-r", manifest["workspaceFolder"]],
                capture_output=True,
                text=True,
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass

    cid = try_custom_hook(manifest, pending_path)
    if cid:
        emit_success(cid)
        return 0

    if cursor_bin:
        cid = try_cursor_cli_activate(manifest, cursor_bin)
        if cid:
            emit_success(cid)
            return 0
    else:
        _log_err("cursor/code CLI not found in PATH (set CURSOR_CLI to override)")

    if wait_result_s > 0:
        _log_err(f"waiting up to {wait_result_s:.0f}s for {RESULT_PATH} ...")
        cid = wait_for_result_file(wait_result_s)
        if cid:
            emit_success(cid)
            return 0

    _log_err(
        "IDE activation not available: Cursor has no public CLI to run "
        f"{CREATE_COMPOSER_COMMAND_ID}."
    )
    _log_err(f"Staged manifest: {pending_path}")
    _log_err(
        "Prerequisite: Cursor must be open on the target workspace. Then either:\n"
        "  - set CURSOR_COMPOSER_BRIDGE_COMMAND to a hook that prints "
        '{"composerId":"..."} on stdout, or\n'
        f"  - write {RESULT_PATH} with "
        '{"ok":true,"composerId":"<uuid>"} (extension / manual), or\n'
        "  - run bridge with --wait-result SECONDS after triggering activation."
    )
    _log_err(
        "See docs/chat-import-activate.md for manifest schema and 3-4 orchestration."
    )
    return 2


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Stage a composer activation manifest and invoke IDE createComposer "
            "when a hook or CLI is available."
        )
    )
    parser.add_argument(
        "--manifest",
        help="Path to JSON manifest; otherwise read JSON from stdin",
    )
    parser.add_argument(
        "--wait-result",
        type=float,
        default=0.0,
        metavar="SECONDS",
        help=(
            "After staging, poll ~/.cursor/import-activation/result.json "
            "for composerId (extension hook)"
        ),
    )
    parser.add_argument(
        "--no-focus",
        action="store_true",
        help="Do not run cursor -r <workspaceFolder> before activation attempts",
    )
    args = parser.parse_args()

    manifest_path = Path(args.manifest).expanduser() if args.manifest else None
    try:
        raw = _read_manifest(manifest_path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        _log_err(f"failed to read manifest: {exc}")
        raise SystemExit(1) from exc

    code = activate(
        raw,
        wait_result_s=max(0.0, float(args.wait_result)),
        focus_workspace=not args.no_focus,
    )
    raise SystemExit(code)


if __name__ == "__main__":
    main()
