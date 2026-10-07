"""Shared constants, workspace resolution, verification, discovery (cursor_chat_io split module)."""
from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import sqlite3
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
BUNDLE_TYPE = "chat-persistence"
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.I,
)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def cursor_disk_kv_value_as_text(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, memoryview):
        value = bytes(value)
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return value.decode("utf-8", errors="replace")
    return None


def purge_disk_kv_for_conversation(
    db_path: Path,
    conversation_id: str,
    *,
    dry_run: bool = False,
) -> tuple[int, list[str]]:
    """Remove all cursorDiskKV rows for one composer before import merge (avoids stale bubbles)."""
    warnings: list[str] = []
    if not db_path.is_file():
        return 0, warnings
    conn = sqlite3.connect(db_path, timeout=30)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        keys = list_disk_kv_keys_for_conversation(conn, conversation_id)
        if not keys:
            return 0, warnings
        if dry_run:
            return len(keys), warnings
        conn.execute("BEGIN IMMEDIATE;")
        for key in keys:
            conn.execute("DELETE FROM cursorDiskKV WHERE key = ?;", (key,))
        conn.commit()
        return len(keys), warnings
    except sqlite3.Error as exc:
        conn.rollback()
        warnings.append(f"purge disk kv failed: {exc}")
        return 0, warnings
    finally:
        conn.close()


def probe_disk_kv_session_bindings(
    db_path: Path, conversation_id: str
) -> dict[str, Any]:
    """Post-import probe: workspace on composerData and non-empty bubble requestIds."""
    out: dict[str, Any] = {
        "keyCount": 0,
        "nonEmptyRequestIdCount": 0,
        "composerWorkspaceId": None,
        "sampleBubbleRequestId": None,
    }
    if not db_path.is_file():
        return out
    conn = sqlite3.connect(db_path, timeout=20)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        keys = list_disk_kv_keys_for_conversation(conn, conversation_id)
        out["keyCount"] = len(keys)
        for key in keys:
            try:
                value = read_disk_kv_value(conn, key)
            except sqlite3.DatabaseError:
                continue
            text = cursor_disk_kv_value_as_text(value)
            if not text:
                continue
            try:
                obj = json.loads(text)
            except json.JSONDecodeError:
                continue
            if not isinstance(obj, dict):
                continue
            if key == f"composerData:{conversation_id}":
                wi = obj.get("workspaceIdentifier")
                if isinstance(wi, dict):
                    out["composerWorkspaceId"] = wi.get("id")
            elif key.startswith(f"bubbleId:{conversation_id}:"):
                rid = obj.get("requestId")
                if rid:
                    out["nonEmptyRequestIdCount"] += 1
                    if out["sampleBubbleRequestId"] is None:
                        out["sampleBubbleRequestId"] = rid
    finally:
        conn.close()
    return out


def list_disk_kv_keys_for_conversation(
    conn: sqlite3.Connection, conversation_id: str
) -> list[str]:
    """List keys only; bulk SELECT value on live global state.vscdb can raise DatabaseError."""
    prefix_bubble = f"bubbleId:{conversation_id}:"
    key_composer = f"composerData:{conversation_id}"
    try:
        cur = conn.execute(
            "SELECT key FROM cursorDiskKV WHERE key = ? OR key LIKE ?;",
            (key_composer, prefix_bubble + "%"),
        )
    except sqlite3.Error:
        return []
    return [str(row[0]) for row in cur.fetchall() if row and row[0]]


def read_disk_kv_value(conn: sqlite3.Connection, key: str) -> Any | None:
    row = conn.execute(
        "SELECT value FROM cursorDiskKV WHERE key = ? LIMIT 1;",
        (key,),
    ).fetchone()
    if not row:
        return None
    return row[0]


def item_table_value_as_text(value: Any) -> str | None:
    text = cursor_disk_kv_value_as_text(value)
    if text is not None:
        return text
    if isinstance(value, (dict, list)):
        try:
            return json.dumps(value)
        except (TypeError, ValueError):
            return None
    return None


def escape_sql_literal(value: str) -> str:
    return value.replace("'", "''")


def effective_home() -> Path:
    """Match extension resolveEffectiveUserHome + transportChatSubprocessEnv HOME."""
    for key in ("HOME", "USERPROFILE"):
        raw = os.environ.get(key, "").strip()
        if raw:
            return Path(raw).expanduser()
    return Path.home()


def dot_cursor_dir() -> Path:
    from_env = os.environ.get("CURSOR_DOT_DIR", "").strip()
    if from_env:
        return Path(from_env).expanduser()
    return effective_home() / ".cursor"


def cursor_config_root() -> Path:
    home = effective_home()
    system = platform.system()
    if system == "Darwin":
        return home / "Library" / "Application Support" / "Cursor" / "User"
    if system == "Windows":
        app_data = os.environ.get("APPDATA", "").strip()
        base = Path(app_data).expanduser() if app_data else home / "AppData" / "Roaming"
        return base / "Cursor" / "User"
    xdg = os.environ.get("XDG_CONFIG_HOME", "").strip()
    config_home = Path(xdg).expanduser() if xdg else home / ".config"
    return config_home / "Cursor" / "User"


def projects_root() -> Path:
    return dot_cursor_dir() / "projects"


def chats_root() -> Path:
    return dot_cursor_dir() / "chats"


def activation_dir() -> Path:
    return dot_cursor_dir() / "import-activation"


def activation_pending_path() -> Path:
    return activation_dir() / "pending.json"


def activation_result_path() -> Path:
    return activation_dir() / "result.json"


def __getattr__(name: str) -> Any:
    if name == "ACTIVATION_DIR":
        return activation_dir()
    if name == "ACTIVATION_PENDING_PATH":
        return activation_pending_path()
    if name == "ACTIVATION_RESULT_PATH":
        return activation_result_path()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
COMPOSER_BRIDGE_SCRIPT = Path(__file__).resolve().parent / "cursor_composer_bridge.py"


@dataclass
class WorkspaceContext:
    workspace_storage_id: str
    folder_fs_path: str
    chats_workspace_key: str
    workspace_identifier: dict[str, Any]


@dataclass
class VerifyCheck:
    name: str
    status: str
    detail: str = ""

    def format_line(self) -> str:
        if self.detail:
            return f"[{self.status}] {self.name}: {self.detail}"
        return f"[{self.status}] {self.name}"

    def to_json(self) -> dict[str, str]:
        return {"check": self.name, "status": self.status, "detail": self.detail}


def md5_folder_key(folder_fs_path: str) -> str:
    return hashlib.md5(folder_fs_path.encode()).hexdigest()


def folder_path_from_workspace_uri(uri: str) -> str:
    if uri.startswith("file://"):
        from urllib.parse import unquote, urlparse

        parsed = urlparse(uri)
        return unquote(parsed.path)
    return uri


def resolve_workspace_context(
    state_db: Path | None = None, workspace_folder: str | None = None
) -> WorkspaceContext | None:
    folder_fs_path: str | None = None
    workspace_storage_id: str | None = None

    if workspace_folder:
        folder_fs_path = str(Path(workspace_folder).expanduser().resolve())

    if state_db is not None:
        parts = state_db.parts
        if "workspaceStorage" in parts:
            idx = parts.index("workspaceStorage")
            if idx + 1 < len(parts):
                workspace_storage_id = parts[idx + 1]
        if folder_fs_path is None and state_db.parent.name != "globalStorage":
            wj = state_db.parent / "workspace.json"
            if wj.is_file():
                try:
                    wdata = json.loads(wj.read_text(encoding="utf-8"))
                    folder = wdata.get("folder")
                    if isinstance(folder, str):
                        folder_fs_path = folder_path_from_workspace_uri(folder)
                except (OSError, json.JSONDecodeError):
                    pass

    if not folder_fs_path:
        return None

    folder_fs_path = str(Path(folder_fs_path).resolve())
    chats_key = md5_folder_key(folder_fs_path)

    if workspace_storage_id is None:
        ws_root = cursor_config_root() / "workspaceStorage"
        if ws_root.is_dir():
            for ent in ws_root.iterdir():
                wj = ent / "workspace.json"
                if not wj.is_file():
                    continue
                try:
                    wdata = json.loads(wj.read_text(encoding="utf-8"))
                    folder = wdata.get("folder")
                    if not isinstance(folder, str):
                        continue
                    if folder_path_from_workspace_uri(folder) == folder_fs_path:
                        workspace_storage_id = ent.name
                        break
                except (OSError, json.JSONDecodeError):
                    continue

    ws_id = workspace_storage_id or chats_key
    sep = 1 if platform.system() == "win32" else 47
    external = Path(folder_fs_path).as_uri()
    return WorkspaceContext(
        workspace_storage_id=ws_id,
        folder_fs_path=folder_fs_path,
        chats_workspace_key=chats_key,
        workspace_identifier={
            "id": ws_id,
            "uri": {
                "$mid": 1,
                "fsPath": folder_fs_path,
                "_sep": sep,
                "external": external,
                "path": folder_fs_path,
                "scheme": "file",
            },
        },
    )


def resolve_chats_workspace_key(
    target_workspace: str | None,
    state_db: Path | None,
    workspace_folder: str | None,
    bundle: dict[str, Any],
) -> tuple[str, list[str]]:
    warnings: list[str] = []
    ctx = resolve_workspace_context(state_db, workspace_folder)
    if ctx is not None:
        if target_workspace and target_workspace != ctx.chats_workspace_key:
            if target_workspace == ctx.workspace_storage_id:
                warnings.append(
                    f"--target-workspace {target_workspace} is workspaceStorage id; "
                    f"using chats key md5(folder)={ctx.chats_workspace_key} for store.db."
                )
            else:
                warnings.append(
                    f"--target-workspace {target_workspace} overrides resolved chats key "
                    f"{ctx.chats_workspace_key}."
                )
                return target_workspace, warnings
        return ctx.chats_workspace_key, warnings

    if target_workspace:
        return target_workspace, warnings
    snap = bundle.get("storeSnapshot") or {}
    swk = snap.get("sourceWorkspaceKey")
    if isinstance(swk, str) and swk:
        return swk, warnings
    return "imported", warnings


PARTIAL_STATE_STRIPPED = frozenset(
    {"capabilities", "conversationActionManager", "agentSessionId"}
)

def agent_debug_log(
    hypothesis_id: str,
    location: str,
    message: str,
    data: dict[str, Any],
    run_id: str = "repro",
) -> None:
    log_path = os.environ.get("CURSOR_SYNC_DEBUG_LOG")
    if not log_path:
        return
    try:
        payload = {
            "sessionId": os.environ.get("CURSOR_SYNC_DEBUG_SESSION", "debug"),
            "runId": run_id,
            "hypothesisId": hypothesis_id,
            "location": location,
            "message": message,
            "data": data,
            "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
        }
        with Path(log_path).open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, separators=(",", ":")) + "\n")
    except OSError:
        pass


def clear_session_binding_in_tree(value: Any) -> Any:
    """Remove cloud/session bindings from composer payloads (any nesting depth)."""
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            if k == "requestId":
                out[k] = ""
            elif k == "workspaceUris":
                out[k] = []
            elif k in PARTIAL_STATE_STRIPPED:
                continue
            else:
                out[k] = clear_session_binding_in_tree(v)
        return out
    if isinstance(value, list):
        return [clear_session_binding_in_tree(item) for item in value]
    return value


def stamp_workspace_identifier_on_headers(
    headers: dict[str, Any], conversation_id: str, workspace_identifier: dict[str, Any]
) -> dict[str, Any]:
    composers = headers.get("allComposers")
    if not isinstance(composers, list):
        return headers
    updated: list[Any] = []
    for entry in composers:
        if not isinstance(entry, dict):
            updated.append(entry)
            continue
        if entry.get("composerId") != conversation_id:
            updated.append(entry)
            continue
        row = rebind_composer_record(entry, workspace_identifier)
        updated.append(row)
    return {**headers, "allComposers": updated}


def rebind_composer_record(
    record: dict[str, Any], workspace_identifier: dict[str, Any]
) -> dict[str, Any]:
    """Re-attach a composer row/blob to the destination workspace; drop source-session fields."""
    cleared = clear_session_binding_in_tree(record)
    if not isinstance(cleared, dict):
        cleared = {}
    row = dict(cleared)
    row["workspaceIdentifier"] = workspace_identifier
    return row


def rebind_existing_conversation_disk_kv_keys(
    db_path: Path,
    conversation_id: str,
    workspace_identifier: dict[str, Any] | None,
    *,
    dry_run: bool = False,
) -> tuple[int, list[str]]:
    """Rebind every cursorDiskKV row for this conversation in place (no DELETE)."""
    warnings: list[str] = []
    if not db_path.is_file():
        return 0, warnings
    conn = sqlite3.connect(db_path, timeout=30)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        keys = list_disk_kv_keys_for_conversation(conn, conversation_id)
        if not keys:
            return 0, warnings
        if dry_run:
            return len(keys), warnings
        conn.execute("BEGIN IMMEDIATE;")
        updated = 0
        for key in keys:
            try:
                value = read_disk_kv_value(conn, key)
            except sqlite3.DatabaseError as exc:
                warnings.append(f"skip disk kv rebind {key}: {exc}")
                continue
            text = cursor_disk_kv_value_as_text(value)
            if text is None:
                continue
            new_text = rebind_disk_kv_row_value(
                key, text, conversation_id, workspace_identifier
            )
            conn.execute(
                "INSERT OR REPLACE INTO cursorDiskKV(key, value) VALUES (?, ?);",
                (key, new_text),
            )
            updated += 1
        conn.commit()
        return updated, warnings
    except sqlite3.Error:
        conn.rollback()
        raise
    finally:
        conn.close()


def rebind_disk_kv_row_value(
    key: str,
    value: str,
    conversation_id: str,
    workspace_identifier: dict[str, Any] | None,
) -> str:
    try:
        obj = json.loads(value)
    except json.JSONDecodeError:
        return value
    if not isinstance(obj, dict):
        return value
    if key != f"composerData:{conversation_id}" and not key.startswith(
        f"bubbleId:{conversation_id}:"
    ):
        return value
    obj = clear_session_binding_in_tree(obj)
    if not isinstance(obj, dict):
        return value
    if key == f"composerData:{conversation_id}" and workspace_identifier:
        obj = rebind_composer_record(obj, workspace_identifier)
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def stamp_workspace_on_item_table_composer_data(
    data: dict[str, Any],
    conversation_id: str,
    workspace_identifier: dict[str, Any],
) -> dict[str, Any]:
    """Rebind ItemTable composer.composerData payloads for the imported conversation."""
    out = dict(data)
    blob = out.get(conversation_id)
    if isinstance(blob, dict):
        out[conversation_id] = rebind_composer_record(blob, workspace_identifier)
    composers = out.get("allComposers")
    if isinstance(composers, list):
        out["allComposers"] = [
            rebind_composer_record(entry, workspace_identifier)
            if isinstance(entry, dict) and entry.get("composerId") == conversation_id
            else entry
            for entry in composers
        ]
    return out


def composer_data_for_focus(conversation_id: str, existing_raw: str | None) -> dict[str, Any]:
    base: dict[str, Any] = {}
    if existing_raw and existing_raw.strip():
        try:
            parsed = json.loads(existing_raw)
            if isinstance(parsed, dict):
                base = parsed
        except json.JSONDecodeError:
            pass
    merged = dict(base)
    merged["selectedComposerIds"] = [conversation_id]
    merged["lastFocusedComposerIds"] = [conversation_id]
    merged.setdefault("hasMigratedComposerData", True)
    merged.setdefault("hasMigratedMultipleComposers", True)
    return merged


def global_state_db_path() -> Path:
    return cursor_config_root() / "globalStorage" / "state.vscdb"


def sqlite_integrity_ok(db_path: Path) -> bool:
    if not db_path.is_file():
        return False
    try:
        conn = sqlite3.connect(db_path, timeout=5)
        conn.execute("PRAGMA busy_timeout=3000")
        row = conn.execute("PRAGMA integrity_check").fetchone()
        conn.close()
        return bool(row and row[0] == "ok")
    except sqlite3.Error:
        return False


def list_state_db_candidates() -> list[Path]:
    root = cursor_config_root()
    out: list[Path] = []
    global_db = root / "globalStorage" / "state.vscdb"
    if global_db.is_file():
        out.append(global_db)
    ws_root = root / "workspaceStorage"
    if ws_root.is_dir():
        for ent in sorted(ws_root.iterdir()):
            if ent.is_dir():
                p = ent / "state.vscdb"
                if p.is_file():
                    out.append(p)
    return out


def find_store_db(conversation_id: str) -> tuple[Path, str] | None:
    root = chats_root()
    if not root.is_dir():
        return None
    for ws in sorted(root.iterdir()):
        if not ws.is_dir():
            continue
        candidate = ws / conversation_id / "store.db"
        if candidate.is_file():
            return candidate, ws.name
    return None


def human_label(folder_name: str) -> str:
    parts = folder_name.split("-")
    if len(parts) <= 1:
        return folder_name
    last = parts[-1]
    trimmed = parts[:-1] if len(last) in (8, 40) else parts
    return "-".join(trimmed)
def merge_targets_for_import(
    state_db: Path | None, sync_global: bool
) -> list[Path]:
    targets: list[Path] = []
    seen: set[str] = set()
    if state_db is not None and state_db.is_file():
        p = state_db.resolve()
        targets.append(p)
        seen.add(str(p))
    if sync_global:
        g = global_state_db_path()
        if g.is_file():
            gp = g.resolve()
            if str(gp) not in seen:
                targets.append(gp)
                seen.add(str(gp))
    if not targets:
        for c in list_state_db_candidates():
            cp = c.resolve()
            if str(cp) not in seen:
                targets.append(cp)
                seen.add(str(cp))
                break
    return targets
def read_composer_rows(db_path: Path) -> dict[str, Any]:
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT key, value FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData')"
        )
        out: dict[str, Any] = {}
        for key, value in cur.fetchall():
            short = key.replace("composer.", "", 1)
            if isinstance(value, bytes):
                value = value.decode("utf-8", errors="replace")
            if isinstance(value, str):
                try:
                    out[short] = json.loads(value)
                except json.JSONDecodeError:
                    out[short] = value
            else:
                out[short] = value
        return out
    finally:
        conn.close()
def read_composer_header_entry(db_path: Path, conversation_id: str) -> dict[str, Any] | None:
    if not db_path.is_file():
        return None
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT value FROM ItemTable WHERE key='composer.composerHeaders'"
        ).fetchone()
    finally:
        conn.close()
    if not row or not row[0]:
        return None
    raw = item_table_value_as_text(row[0])
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    for c in data.get("allComposers") or []:
        if isinstance(c, dict) and c.get("composerId") == conversation_id:
            return c
    return None


def count_store_db_blobs(store_path: Path) -> int | None:
    if not store_path.is_file():
        return None
    conn = sqlite3.connect(f"file:{store_path.resolve()}?mode=ro", uri=True)
    try:
        tables = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        if "blobs" not in tables:
            return 0
        row = conn.execute("SELECT COUNT(*) FROM blobs").fetchone()
        return int(row[0]) if row else 0
    except sqlite3.Error:
        return None
    finally:
        conn.close()

def decode_store_db_index(store_bytes: bytes) -> dict[str, Any]:
    """Read meta key/value rows and blob count from store.db bytes (index only, no blob decode)."""
    out: dict[str, Any] = {"meta": {}, "blobCount": 0}
    if not store_bytes:
        return out

    try:
        with tempfile.NamedTemporaryFile(suffix=".db") as tmp:
            tmp.write(store_bytes)
            tmp.flush()
            conn = sqlite3.connect(f"file:{Path(tmp.name).resolve()}?mode=ro", uri=True)
            try:
                tables = {
                    r[0]
                    for r in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
                if "meta" in tables:
                    meta_out: dict[str, Any] = {}
                    for key, value in conn.execute("SELECT key, value FROM meta"):
                        parsed: Any = value
                        if isinstance(value, str):
                            try:
                                parsed = json.loads(value)
                            except json.JSONDecodeError:
                                pass
                        meta_out[str(key)] = parsed
                    out["meta"] = meta_out
                if "blobs" in tables:
                    row = conn.execute("SELECT COUNT(*) FROM blobs").fetchone()
                    out["blobCount"] = int(row[0]) if row else 0
            finally:
                conn.close()
    except (sqlite3.Error, OSError):
        out["error"] = "unreadable"
    return out

def composer_timestamp_ms(record: dict[str, Any]) -> int:
    """Parse Cursor sidebar timestamps (epoch ms as number or string)."""
    best = 0
    for field in ("lastUpdatedAt", "lastOpenedAt", "createdAt"):
        raw = record.get(field)
        if isinstance(raw, (int, float)) and raw > 0:
            v = int(raw)
            best = max(best, v if v >= 1_000_000_000_000 else v * 1000)
        elif isinstance(raw, str) and raw.strip():
            if raw.strip().isdigit():
                v = int(raw.strip())
                best = max(best, v if v >= 1_000_000_000_000 else v * 1000)
            else:
                try:
                    d = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                    best = max(best, int(d.timestamp() * 1000))
                except ValueError:
                    pass
    return best


def max_composer_timestamp_ms(headers: dict[str, Any]) -> int:
    composers = headers.get("allComposers")
    if not isinstance(composers, list):
        return 0
    return max((composer_timestamp_ms(c) for c in composers if isinstance(c, dict)), default=0)
def _bundle_created_at_ms(bundle: dict[str, Any]) -> int:
    raw_ts = bundle.get("createdAt")
    if isinstance(raw_ts, str):
        try:
            return int(
                datetime.fromisoformat(raw_ts.replace("Z", "+00:00")).timestamp() * 1000
            )
        except ValueError:
            pass
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _sidebar_header_row(
    sidebar_snapshot: dict[str, Any] | None, conversation_id: str
) -> dict[str, Any] | None:
    if not isinstance(sidebar_snapshot, dict):
        return None
    headers = sidebar_snapshot.get("composerHeaders")
    if not isinstance(headers, dict):
        return None
    for entry in headers.get("allComposers") or []:
        if isinstance(entry, dict) and entry.get("composerId") == conversation_id:
            return entry
    return None


def _sidebar_rich_composer_blob(
    sidebar_snapshot: dict[str, Any] | None, conversation_id: str
) -> dict[str, Any] | None:
    if not isinstance(sidebar_snapshot, dict):
        return None
    data = sidebar_snapshot.get("composerData")
    if not isinstance(data, dict):
        return None
    keyed = data.get(conversation_id)
    if isinstance(keyed, dict) and keyed:
        return keyed
    composers = data.get("allComposers")
    if isinstance(composers, list):
        for entry in composers:
            if isinstance(entry, dict) and entry.get("composerId") == conversation_id:
                return entry
    return None


def _merge_rich_composer_into_partial(
    partial: dict[str, Any], rich: dict[str, Any], conversation_id: str
) -> None:
    for key, value in rich.items():
        if key in PARTIAL_STATE_STRIPPED:
            continue
        if key == "composerId":
            continue
        partial[key] = value
    partial["composerId"] = conversation_id


def bundle_to_partial_state(
    bundle: dict[str, Any],
    conversation_id: str,
    *,
    workspace_identifier: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Build createComposer-style partialState from a ChatBundle (v1: preserve conversationId).
    Decodes storeSnapshot index only; does not rewrite store.db blobs.
    """
    cid = conversation_id.strip()
    snap = bundle.get("sidebarSnapshot")
    snap_dict = snap if isinstance(snap, dict) else None
    header = _sidebar_header_row(snap_dict, cid)

    title = bundle.get("title") if isinstance(bundle.get("title"), str) else None
    name = title or (header.get("name") if header else None) or cid

    ts = _bundle_created_at_ms(bundle)
    if header:
        ts = composer_timestamp_ms(header) or ts

    partial: dict[str, Any] = {
        "composerId": cid,
        "name": name,
        "type": (header.get("type") if header else None) or "head",
        "unifiedMode": (header.get("unifiedMode") if header else None) or "agent",
        "forceMode": (header.get("forceMode") if header else None) or "edit",
        "createdAt": header.get("createdAt") if header and header.get("createdAt") is not None else ts,
        "lastUpdatedAt": header.get("lastUpdatedAt")
        if header and header.get("lastUpdatedAt") is not None
        else ts,
        "lastOpenedAt": header.get("lastOpenedAt")
        if header and header.get("lastOpenedAt") is not None
        else ts,
    }

    wi = workspace_identifier
    if wi is None and isinstance(bundle.get("workspaceIdentifier"), dict):
        wi = bundle["workspaceIdentifier"]
    if wi is None and header and isinstance(header.get("workspaceIdentifier"), dict):
        wi = header["workspaceIdentifier"]
    if wi is not None:
        partial["workspaceIdentifier"] = wi

    if header:
        for field in (
            "subtitle",
            "hasUnreadMessages",
            "isArchived",
            "isDraft",
            "contextUsagePercent",
            "filesChangedCount",
            "conversationCheckpointLastUpdatedAt",
        ):
            if field in header:
                partial[field] = header[field]

    rich = _sidebar_rich_composer_blob(snap_dict, cid)
    if rich:
        _merge_rich_composer_into_partial(partial, rich, cid)

    wi_final = partial.get("workspaceIdentifier")
    if not isinstance(wi_final, dict):
        wi_final = workspace_identifier
    cleared = clear_session_binding_in_tree(partial)
    if isinstance(cleared, dict):
        partial = cleared
    if isinstance(wi_final, dict):
        partial = rebind_composer_record(partial, wi_final)
    return partial

def sidebar_snapshot_has_composer_data(bundle: dict[str, Any], conversation_id: str) -> bool:
    snap = bundle.get("sidebarSnapshot")
    if not isinstance(snap, dict):
        return False
    cd = snap.get("composerData")
    if not isinstance(cd, dict):
        return False
    val = cd.get(conversation_id)
    return val is not None and val != {}

def composer_data_has_conversation_key(db_path: Path, conversation_id: str) -> bool | None:
    if not db_path.is_file():
        return None
    rows = read_composer_rows(db_path)
    data = rows.get("composerData")
    if not isinstance(data, dict):
        return False
    if conversation_id not in data:
        return False
    val = data[conversation_id]
    return val is not None and val != {}


def count_tool_bubbles_in_global_db(
    conversation_id: str,
    global_db: Path | None = None,
) -> int | None:
    db = global_db if global_db is not None else global_state_db_path()
    if not db.is_file():
        return None
    prefix = f"bubbleId:{conversation_id}:"
    conn = sqlite3.connect(db, timeout=20)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        try:
            keys = list_disk_kv_keys_for_conversation(conn, conversation_id)
        except sqlite3.Error:
            return None
        count = 0
        for key in keys:
            if not key.startswith(prefix):
                continue
            try:
                value = read_disk_kv_value(conn, key)
            except sqlite3.DatabaseError:
                continue
            text = cursor_disk_kv_value_as_text(value)
            if text is None:
                continue
            try:
                if json.loads(text).get("toolFormerData"):
                    count += 1
            except json.JSONDecodeError:
                pass
        return count
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def expected_tool_bubble_count_from_bundle(bundle: dict[str, Any] | None) -> int | None:
    if bundle is None:
        return None
    disk_kv = bundle.get("diskKvSnapshot")
    if not isinstance(disk_kv, dict):
        return None
    tbc = disk_kv.get("toolBubbleCount")
    if isinstance(tbc, int) and tbc > 0:
        return tbc
    return None


def verify_import_visibility(
    conversation_id: str,
    workspace_ctx: WorkspaceContext | None,
    *,
    expect_rich_composer_data: bool = False,
    expect_store: bool = False,
    expected_tool_bubble_count: int | None = None,
    tool_bubble_global_db: Path | None = None,
) -> list[VerifyCheck]:
    checks: list[VerifyCheck] = []
    chats_key = workspace_ctx.chats_workspace_key if workspace_ctx else None
    store_path: Path | None = None
    if chats_key:
        store_path = chats_root() / chats_key / conversation_id / "store.db"
        if store_path.is_file():
            blob_n = count_store_db_blobs(store_path)
            if blob_n is None:
                checks.append(
                    VerifyCheck(
                        "store.db",
                        "WARN",
                        f"{store_path} exists but blob count unreadable",
                    )
                )
            elif blob_n > 0:
                checks.append(
                    VerifyCheck(
                        "store.db",
                        "OK",
                        f"{chats_key}/{conversation_id} ({blob_n} blobs)",
                    )
                )
            else:
                checks.append(
                    VerifyCheck(
                        "store.db",
                        "FAIL",
                        f"{store_path} has 0 blobs",
                    )
                )
        elif expect_store:
            checks.append(
                VerifyCheck(
                    "store.db",
                    "FAIL",
                    f"missing at ~/.cursor/chats/{chats_key}/{conversation_id}/",
                )
            )
        else:
            checks.append(
                VerifyCheck(
                    "store.db",
                    "SKIP",
                    f"no file at ~/.cursor/chats/{chats_key}/{conversation_id}/",
                )
            )
    elif expect_store:
        checks.append(VerifyCheck("store.db", "FAIL", "workspace context missing"))

    g = global_state_db_path()
    ent = read_composer_header_entry(g, conversation_id)
    if ent is None:
        checks.append(
            VerifyCheck(
                "global.composerHeaders",
                "FAIL",
                "sidebar row missing in globalStorage/state.vscdb",
            )
        )
    else:
        wi = (
            ent.get("workspaceIdentifier")
            if isinstance(ent.get("workspaceIdentifier"), dict)
            else {}
        )
        wi_id = wi.get("id")
        fp = (wi.get("uri") or {}).get("fsPath") if isinstance(wi.get("uri"), dict) else None
        expected = workspace_ctx.folder_fs_path if workspace_ctx else None
        expected_id = workspace_ctx.workspace_storage_id if workspace_ctx else None
        if not wi_id:
            checks.append(
                VerifyCheck("global.workspaceIdentifier", "FAIL", "id not stamped on header")
            )
        elif expected_id and wi_id != expected_id:
            checks.append(
                VerifyCheck(
                    "global.workspaceIdentifier",
                    "FAIL",
                    f"id={wi_id} expected workspaceStorage id {expected_id}",
                )
            )
        else:
            checks.append(
                VerifyCheck(
                    "global.workspaceIdentifier",
                    "OK",
                    f"id={wi_id}",
                )
            )
        if expected and fp != expected:
            checks.append(
                VerifyCheck(
                    "global.workspaceIdentifier.fsPath",
                    "FAIL",
                    f"uri.fsPath={fp!r} expected {expected!r}",
                )
            )
        elif expected and fp == expected:
            checks.append(
                VerifyCheck(
                    "global.workspaceIdentifier.fsPath",
                    "OK",
                    fp or "",
                )
            )
        elif expected:
            checks.append(
                VerifyCheck(
                    "global.workspaceIdentifier.fsPath",
                    "FAIL",
                    "uri.fsPath missing on header",
                )
            )
        checks.append(VerifyCheck("global.composerHeaders", "OK", conversation_id))

    if workspace_ctx:
        ws_db = (
            cursor_config_root()
            / "workspaceStorage"
            / workspace_ctx.workspace_storage_id
            / "state.vscdb"
        )
        ent_w = read_composer_header_entry(ws_db, conversation_id)
        if ent_w is None:
            checks.append(
                VerifyCheck(
                    f"workspace.composerHeaders({workspace_ctx.workspace_storage_id})",
                    "WARN",
                    "missing (global row may still be enough)",
                )
            )
        else:
            checks.append(
                VerifyCheck(
                    f"workspace.composerHeaders({workspace_ctx.workspace_storage_id})",
                    "OK",
                    conversation_id,
                )
            )

        for label, db in (("global", g), ("workspace", ws_db)):
            has_key = composer_data_has_conversation_key(db, conversation_id)
            if expect_rich_composer_data:
                if has_key:
                    checks.append(
                        VerifyCheck(
                            f"{label}.composerData[{conversation_id}]",
                            "OK",
                            "per-composer payload present",
                        )
                    )
                else:
                    checks.append(
                        VerifyCheck(
                            f"{label}.composerData[{conversation_id}]",
                            "FAIL",
                            "bundle sidebar had composerData but disk key missing",
                        )
                    )
            elif has_key:
                checks.append(
                    VerifyCheck(
                        f"{label}.composerData[{conversation_id}]",
                        "OK",
                        "per-composer payload present",
                    )
                )

    if expected_tool_bubble_count is not None and expected_tool_bubble_count > 0:
        db_for_tools = tool_bubble_global_db if tool_bubble_global_db is not None else g
        tool_count = count_tool_bubbles_in_global_db(conversation_id, db_for_tools)
        detail = (
            f"toolFormerData bubbles={tool_count} "
            f"expected>={expected_tool_bubble_count}"
        )
        if tool_count is None:
            checks.append(
                VerifyCheck(
                    "global.diskKv.toolBubbles",
                    "FAIL",
                    "global state DB unreadable or cursorDiskKV missing",
                )
            )
        elif tool_count >= expected_tool_bubble_count:
            checks.append(
                VerifyCheck("global.diskKv.toolBubbles", "OK", detail)
            )
        else:
            checks.append(
                VerifyCheck("global.diskKv.toolBubbles", "FAIL", detail)
            )

    return checks


def verify_checks_all_ok(checks: list[VerifyCheck]) -> bool:
    return all(c.status != "FAIL" for c in checks)
def print_verify_report(checks: list[VerifyCheck], *, json_lines: bool = False) -> None:
    for c in checks:
        if json_lines:
            print(json.dumps(c.to_json(), separators=(",", ":")))
        else:
            print(c.format_line())
@dataclass
class ConversationRef:
    conversation_id: str
    project_key: str | None
    has_transcript: bool
    has_store: bool
    store_workspace_key: str | None
    title_hint: str


def first_user_text(jsonl_path: Path) -> str:
    try:
        with jsonl_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                if obj.get("role") != "user":
                    continue
                msg = obj.get("message") or {}
                content = msg.get("content")
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            text = block.get("text", "")
                            if isinstance(text, str) and text.strip():
                                return text.strip()[:80]
                if isinstance(content, str) and content.strip():
                    return content.strip()[:80]
    except (OSError, json.JSONDecodeError):
        pass
    return ""


def discover_conversations() -> list[ConversationRef]:
    by_id: dict[str, ConversationRef] = {}
    proot = projects_root()
    if proot.is_dir():
        for proj in sorted(proot.iterdir()):
            if not proj.is_dir():
                continue
            at = proj / "agent-transcripts"
            if not at.is_dir():
                continue
            for conv in sorted(at.iterdir()):
                if not conv.is_dir():
                    continue
                cid = conv.name
                if not UUID_RE.match(cid):
                    continue
                jsonls = list(conv.glob("*.jsonl"))
                if not jsonls:
                    continue
                hint = first_user_text(jsonls[0]) or cid
                ref = by_id.get(cid)
                if ref is None:
                    by_id[cid] = ConversationRef(
                        conversation_id=cid,
                        project_key=proj.name,
                        has_transcript=True,
                        has_store=False,
                        store_workspace_key=None,
                        title_hint=hint,
                    )
                else:
                    ref.has_transcript = True
                    if ref.project_key is None:
                        ref.project_key = proj.name
    croot = chats_root()
    if croot.is_dir():
        for ws in sorted(croot.iterdir()):
            if not ws.is_dir():
                continue
            for conv in sorted(ws.iterdir()):
                if not conv.is_dir():
                    continue
                cid = conv.name
                if not (conv / "store.db").is_file():
                    continue
                ref = by_id.get(cid)
                if ref is None:
                    by_id[cid] = ConversationRef(
                        conversation_id=cid,
                        project_key=None,
                        has_transcript=False,
                        has_store=True,
                        store_workspace_key=ws.name,
                        title_hint=cid,
                    )
                else:
                    ref.has_store = True
                    ref.store_workspace_key = ws.name
    return sorted(by_id.values(), key=lambda r: r.conversation_id)
