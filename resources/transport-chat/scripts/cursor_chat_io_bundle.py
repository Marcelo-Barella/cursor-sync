"""Bundle build, merge, and store synthesis (cursor_chat_io split module)."""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import re
import sqlite3
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cursor_chat_io_common import *
def filter_composer_headers_for_conversation(
    headers: dict[str, Any], conversation_id: str
) -> dict[str, Any]:
    """Keep only sidebar rows for this chat (matches transcripts.ts export filter)."""
    composers = headers.get("allComposers")
    if not isinstance(composers, list):
        return {"allComposers": []}
    kept = [
        c
        for c in composers
        if isinstance(c, dict) and c.get("composerId") == conversation_id
    ]
    return {"allComposers": kept}


def filter_composer_data_for_conversation(
    data: dict[str, Any], conversation_id: str
) -> dict[str, Any]:
    if not data:
        return {}
    out: dict[str, Any] = {}
    for key, value in data.items():
        if key == "allComposers" and isinstance(value, list):
            out[key] = [
                e
                for e in value
                if isinstance(e, dict) and e.get("composerId") == conversation_id
            ]
        elif key == conversation_id:
            out[key] = value
        elif not re.match(
            r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            key,
            re.I,
        ):
            out[key] = value
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


def pin_composer_as_most_recent(headers: dict[str, Any], conversation_id: str) -> dict[str, Any]:
    """Set imported chat timestamps above every other sidebar row."""
    composers = headers.get("allComposers")
    if not isinstance(composers, list):
        return headers
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    pin_ms = max(max_composer_timestamp_ms(headers), now_ms) + 1
    updated: list[Any] = []
    found = False
    for entry in composers:
        if not isinstance(entry, dict):
            updated.append(entry)
            continue
        if entry.get("composerId") != conversation_id:
            updated.append(entry)
            continue
        found = True
        bumped = dict(entry)
        bumped["lastUpdatedAt"] = pin_ms
        bumped["lastOpenedAt"] = pin_ms
        if not bumped.get("type"):
            bumped["type"] = "head"
        bumped["hasUnreadMessages"] = False
        bumped["isArchived"] = False
        bumped["isDraft"] = False
        updated.append(bumped)
    if not found:
        derived = derive_headers_from_bundle({"conversationId": conversation_id, "title": conversation_id})
        if derived and derived.get("allComposers"):
            row = dict(derived["allComposers"][0])
            row["lastUpdatedAt"] = pin_ms
            row["lastOpenedAt"] = pin_ms
            updated.insert(0, row)
        return {**headers, "allComposers": updated}
    pinned_row: dict[str, Any] | None = None
    rest: list[Any] = []
    for entry in updated:
        if isinstance(entry, dict) and entry.get("composerId") == conversation_id:
            pinned_row = entry
        else:
            rest.append(entry)
    if pinned_row is not None:
        return {**headers, "allComposers": [pinned_row, *rest]}
    return {**headers, "allComposers": updated}


def headers_payload_for_import(bundle: dict[str, Any]) -> dict[str, Any]:
    """
    Build the composerHeaders payload to merge on import.
    Always includes the bundle conversationId (derived entry if missing from snapshot).
    """
    snap = bundle.get("sidebarSnapshot")
    cid = bundle.get("conversationId")
    if not isinstance(cid, str) or not cid.strip():
        return derive_headers_from_bundle(bundle) or {"allComposers": []}

    payloads: list[dict[str, Any]] = []
    if isinstance(snap, dict):
        raw_headers = snap.get("composerHeaders")
        if isinstance(raw_headers, dict):
            filtered = filter_composer_headers_for_conversation(raw_headers, cid)
            if filtered.get("allComposers"):
                payloads.append(filtered)
    payloads.append(derive_headers_from_bundle(bundle) or {"allComposers": []})
    return merge_headers_chain(None, payloads)


def parse_headers_blob(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {"allComposers": []}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {"allComposers": []}
    if isinstance(parsed, dict) and isinstance(parsed.get("allComposers"), list):
        return parsed
    return {"allComposers": []}


def composer_id(record: dict[str, Any]) -> str:
    cid = record.get("composerId")
    return cid if isinstance(cid, str) and cid else ""


def merge_headers_additive(
    existing: dict[str, Any], imported: dict[str, Any]
) -> dict[str, Any]:
    by_id: dict[str, dict[str, Any]] = {}
    for c in existing.get("allComposers") or []:
        if isinstance(c, dict):
            i = composer_id(c)
            if i:
                by_id[i] = dict(c)
    for c in imported.get("allComposers") or []:
        if not isinstance(c, dict):
            continue
        i = composer_id(c)
        if not i:
            continue
        if i in by_id:
            merged = dict(by_id[i])
            merged.update(c)
            by_id[i] = merged
        else:
            by_id[i] = dict(c)
    result = []
    for entry in by_id.values():
        if not entry.get("type"):
            entry = {**entry, "type": "head"}
        result.append(entry)
    return {"allComposers": result}


def merge_headers_chain(existing_raw: str | None, payloads: list[dict[str, Any]]) -> dict[str, Any]:
    acc = parse_headers_blob(existing_raw)
    for p in payloads:
        acc = merge_headers_additive(acc, p)
    return acc


def merge_data_additive(existing_raw: str | None, payloads: list[dict[str, Any]]) -> dict[str, Any]:
    def parse_blob(raw: str | None) -> dict[str, Any]:
        if not raw or not raw.strip():
            return {}
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}

    def merge_array(base: Any, imp: Any) -> list[dict[str, Any]] | None:
        if not isinstance(base, list) or not isinstance(imp, list):
            return None
        by_id: dict[str, dict[str, Any]] = {}
        for entry in base:
            if isinstance(entry, dict):
                i = composer_id(entry)
                if i:
                    by_id[i] = dict(entry)
        for entry in imp:
            if isinstance(entry, dict):
                i = composer_id(entry)
                if i:
                    if i in by_id:
                        m = dict(by_id[i])
                        m.update(entry)
                        by_id[i] = m
                    else:
                        by_id[i] = dict(entry)
        return list(by_id.values())

    merged = parse_blob(existing_raw)
    for imported in payloads:
        nxt = dict(merged)
        for key, value in imported.items():
            if key not in nxt:
                nxt[key] = value
                continue
            arr = merge_array(nxt[key], value)
            if arr is not None:
                nxt[key] = arr
        merged = nxt
    return merged


def derive_headers_from_bundle(bundle: dict[str, Any]) -> dict[str, Any] | None:
    cid = bundle.get("conversationId")
    if not isinstance(cid, str) or not cid.strip():
        return None
    title = bundle.get("title") if isinstance(bundle.get("title"), str) else cid
    raw_ts = bundle.get("createdAt")
    if isinstance(raw_ts, str):
        try:
            ts = int(datetime.fromisoformat(raw_ts.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            ts = int(datetime.now(timezone.utc).timestamp() * 1000)
    else:
        ts = int(datetime.now(timezone.utc).timestamp() * 1000)
    return {
        "allComposers": [
            {
                "type": "head",
                "composerId": cid,
                "name": title,
                "subtitle": bundle.get("subtitle") or "",
                "lastUpdatedAt": ts,
                "lastOpenedAt": ts,
                "createdAt": ts,
                "hasUnreadMessages": False,
                "isArchived": False,
                "isDraft": False,
                "unifiedMode": "agent",
                "forceMode": "edit",
            }
        ]
    }


def iter_conversation_jsonl_files(conversation_dir: Path) -> list[Path]:
    if not conversation_dir.is_dir():
        return []
    return sorted(conversation_dir.rglob("*.jsonl"))


def is_disk_kv_key_in_conversation_scope(key: str, conversation_id: str) -> bool:
    if key == f"composerData:{conversation_id}":
        return True
    return key.startswith(f"bubbleId:{conversation_id}:")


def export_disk_kv_snapshot(global_db: Path, conversation_id: str) -> dict[str, Any] | None:
    if not global_db.is_file():
        return None
    conn = sqlite3.connect(global_db, timeout=20)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        keys = list_disk_kv_keys_for_conversation(conn, conversation_id)
        rows: list[dict[str, Any]] = []
        tool_count = 0
        for key in keys:
            try:
                value = read_disk_kv_value(conn, key)
            except sqlite3.DatabaseError:
                continue
            text = cursor_disk_kv_value_as_text(value)
            if text is None:
                continue
            rows.append(
                {
                    "key": key,
                    "value": text,
                    "checksum": sha256_hex(text.encode("utf-8")),
                }
            )
            try:
                obj = json.loads(text)
                if obj.get("toolFormerData"):
                    tool_count += 1
            except json.JSONDecodeError:
                pass
        if not rows:
            return None
        return {
            "sourceStateDbPath": str(global_db),
            "rows": rows,
            "rowCount": len(rows),
            "toolBubbleCount": tool_count,
        }
    finally:
        conn.close()


AGENT_KV_BLOB_PREFIX = "agentKv:blob:"
AGENT_KV_CHECKPOINT_PREFIX = "agentKv:checkpoint:"
AGENT_KV_BUBBLE_CHECKPOINT_PREFIX = "agentKv:bubbleCheckpoint:"
_HEX_HASH_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_DETECTIVE_DECODE_TOOL = "cursor-detective/decode_conversation_state.py"


def _load_agentkv_decode_helpers() -> dict[str, Any] | None:
    script = (
        dot_cursor_dir()
        / "skills"
        / "cursor-detective"
        / "scripts"
        / "decode_conversation_state.py"
    )
    if not script.is_file():
        return None
    module_name = "cursor_detective_decode_conversation_state"
    spec = importlib.util.spec_from_file_location(module_name, script)
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return {
        "classify_conversation_state": mod.classify_conversation_state,
        "decode_tilde_envelope": mod.decode_tilde_envelope,
        "extract_blob_refs": mod.extract_blob_refs,
        "find_hex_hashes_in_json": mod.find_hex_hashes_in_json,
        "blob_prefix": getattr(mod, "BLOB_PREFIX", AGENT_KV_BLOB_PREFIX),
    }


def _read_varint(data: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while pos < len(data):
        b = data[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if (b & 0x80) == 0:
            return result, pos
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")
    raise ValueError("truncated varint")


def _extract_blob_refs_tilde(data: bytes) -> list[str]:
    refs: list[str] = []
    pos = 0
    while pos < len(data):
        try:
            tag, pos = _read_varint(data, pos)
        except ValueError:
            break
        wire = tag & 7
        if wire == 0:
            try:
                _, pos = _read_varint(data, pos)
            except ValueError:
                break
        elif wire == 1:
            pos += 8
        elif wire == 2:
            try:
                length, pos = _read_varint(data, pos)
            except ValueError:
                break
            if pos + length > len(data):
                break
            chunk = data[pos : pos + length]
            pos += length
            if length == 32:
                refs.append(chunk.hex().lower())
        elif wire == 5:
            pos += 4
        else:
            break
    return refs


def _find_hex_hashes_in_json(obj: Any) -> list[str]:
    found: list[str] = []

    def walk(x: Any) -> None:
        if isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
        elif isinstance(x, str) and _HEX_HASH_RE.match(x):
            found.append(x.lower())

    walk(obj)
    return sorted(set(found))


def _classify_conversation_state(value: Any) -> str:
    helpers = _load_agentkv_decode_helpers()
    if helpers is not None:
        return helpers["classify_conversation_state"](value)
    if value is None:
        return "absent"
    if isinstance(value, dict):
        return "inline_json"
    if not isinstance(value, str):
        return "other"
    if len(value) == 0:
        return "empty"
    if value == "~":
        return "placeholder"
    if value.startswith("~"):
        return "tilde_base64_protobuf"
    if value.startswith("{"):
        return "inline_json_string"
    return "opaque_string"


def _blob_refs_from_conversation_state(cs: Any) -> tuple[list[str], list[str]]:
    warnings: list[str] = []
    kind = _classify_conversation_state(cs)
    refs: list[str] = []
    helpers = _load_agentkv_decode_helpers()
    if kind == "tilde_base64_protobuf" and isinstance(cs, str):
        inner = None
        if helpers is not None:
            inner = helpers["decode_tilde_envelope"](cs)
        else:
            try:
                inner = base64.b64decode(cs[1:] + "==", validate=False)
            except Exception:
                inner = None
        if inner is None:
            warnings.append("conversationState ~ envelope failed base64 decode")
        else:
            if helpers is not None:
                refs = [h for _f, h in helpers["extract_blob_refs"](inner)]
            else:
                refs = _extract_blob_refs_tilde(inner)
    elif kind in ("inline_json",) and isinstance(cs, dict):
        if helpers is not None:
            refs = helpers["find_hex_hashes_in_json"](cs)
        else:
            refs = _find_hex_hashes_in_json(cs)
    elif kind == "inline_json_string" and isinstance(cs, str):
        try:
            parsed = json.loads(cs)
            if helpers is not None:
                refs = helpers["find_hex_hashes_in_json"](parsed)
            else:
                refs = _find_hex_hashes_in_json(parsed)
        except json.JSONDecodeError:
            warnings.append("conversationState inline JSON parse failed")
    return sorted(set(refs)), warnings


def _fetch_agentkv_row(conn: sqlite3.Connection, key: str) -> bytes | None:
    row = conn.execute(
        "SELECT value FROM cursorDiskKV WHERE key = ?;", (key,)
    ).fetchone()
    if not row or row[0] is None:
        return None
    val = row[0]
    if isinstance(val, memoryview):
        return bytes(val)
    if isinstance(val, bytes):
        return val
    return val.encode("latin-1", errors="surrogateescape")


def export_agent_kv_snapshot(
    global_db: Path, conversation_id: str
) -> dict[str, Any] | None:
    if not global_db.is_file():
        return None
    key_composer = f"composerData:{conversation_id}"
    conn = sqlite3.connect(global_db)
    try:
        row = conn.execute(
            "SELECT value FROM cursorDiskKV WHERE key = ?;", (key_composer,)
        ).fetchone()
        if not row or not row[0]:
            return None
        raw = row[0]
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        try:
            composer = json.loads(raw)
        except json.JSONDecodeError:
            return None
        if not isinstance(composer, dict):
            return None

        cs = composer.get("conversationState")
        kind = _classify_conversation_state(cs)
        blob_refs, ref_warnings = _blob_refs_from_conversation_state(cs)
        embedded = _find_hex_hashes_in_json(composer)
        for h in embedded:
            if h not in blob_refs:
                blob_refs.append(h)

        rows: list[dict[str, Any]] = []
        blob_count = 0
        checkpoint_count = 0
        seen_keys: set[str] = set()

        def add_row(
            key: str,
            payload: bytes,
            ref_source: str,
        ) -> None:
            nonlocal blob_count, checkpoint_count
            if key in seen_keys:
                return
            seen_keys.add(key)
            if key.startswith(AGENT_KV_BLOB_PREFIX):
                blob_count += 1
            elif key.startswith(AGENT_KV_CHECKPOINT_PREFIX) or key.startswith(
                AGENT_KV_BUBBLE_CHECKPOINT_PREFIX
            ):
                checkpoint_count += 1
            rows.append(
                {
                    "key": key,
                    "value": base64.b64encode(payload).decode("ascii"),
                    "encoding": "base64",
                    "checksum": sha256_hex(payload),
                    "refSource": ref_source,
                }
            )

        for blob_hash in blob_refs:
            key = f"{AGENT_KV_BLOB_PREFIX}{blob_hash}"
            payload = _fetch_agentkv_row(conn, key)
            if payload is None:
                ref_warnings.append(f"missing_agentKv_blob:{blob_hash}")
                continue
            add_row(key, payload, "conversationState")

        cp_key = f"{AGENT_KV_CHECKPOINT_PREFIX}{conversation_id}"
        cp_val = _fetch_agentkv_row(conn, cp_key)
        if cp_val is not None:
            add_row(cp_key, cp_val, "checkpoint")

        prefix_bc = f"{AGENT_KV_BUBBLE_CHECKPOINT_PREFIX}{conversation_id}:"
        for bc_key, _ in conn.execute(
            "SELECT key, value FROM cursorDiskKV WHERE key LIKE ?;",
            (prefix_bc + "%",),
        ):
            if not isinstance(bc_key, str):
                continue
            payload = _fetch_agentkv_row(conn, bc_key)
            if payload is not None:
                add_row(bc_key, payload, "bubble_checkpoint")

        if not rows:
            return None
        return {
            "sourceStateDbPath": str(global_db),
            "conversationId": conversation_id,
            "rows": rows,
            "rowCount": len(rows),
            "blobCount": blob_count,
            "checkpointCount": checkpoint_count,
            "blobRefCount": len(blob_refs),
            "conversationStateKind": kind,
            "decodeTool": _DETECTIVE_DECODE_TOOL,
            "warnings": ref_warnings,
        }
    finally:
        conn.close()


def remap_agent_kv_snapshot_for_destination(
    snapshot: dict[str, Any],
    source_conversation_id: str,
    destination_conversation_id: str,
) -> dict[str, bytes]:
    rows_out: dict[str, bytes] = {}
    for row in snapshot.get("rows") or []:
        if not isinstance(row, dict):
            continue
        key = str(row.get("key", ""))
        if not key:
            continue
        enc = row.get("encoding")
        raw_b64 = row.get("value", "")
        if enc != "base64" or not isinstance(raw_b64, str):
            continue
        try:
            payload = base64.b64decode(raw_b64)
        except (ValueError, TypeError):
            continue
        if key.startswith(AGENT_KV_BLOB_PREFIX):
            rows_out[key] = payload
            continue
        if key == f"{AGENT_KV_CHECKPOINT_PREFIX}{source_conversation_id}":
            key = f"{AGENT_KV_CHECKPOINT_PREFIX}{destination_conversation_id}"
        elif key.startswith(f"{AGENT_KV_BUBBLE_CHECKPOINT_PREFIX}{source_conversation_id}:"):
            suffix = key[len(f"{AGENT_KV_BUBBLE_CHECKPOINT_PREFIX}{source_conversation_id}") :]
            key = f"{AGENT_KV_BUBBLE_CHECKPOINT_PREFIX}{destination_conversation_id}{suffix}"
        rows_out[key] = payload
    return rows_out


def merge_agent_kv_snapshot(
    db_path: Path,
    rows: dict[str, bytes],
    dry_run: bool,
) -> tuple[bool, list[str]]:
    warnings: list[str] = []
    if not rows:
        warnings.append("No agentKv rows to write.")
        return False, warnings
    if dry_run:
        return True, warnings
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE;")
        for key, value in rows.items():
            conn.execute(
                "INSERT OR REPLACE INTO cursorDiskKV(key, value) VALUES (?, ?);",
                (key, sqlite3.Binary(value)),
            )
        conn.commit()
    finally:
        conn.close()
    return True, warnings


def remap_disk_kv_snapshot_for_destination(
    snapshot: dict[str, Any],
    conversation_id: str,
    workspace_identifier: dict[str, Any] | None,
) -> dict[str, str]:
    from cursor_chat_io_common import rebind_disk_kv_row_value

    rows_out: dict[str, str] = {}
    for row in snapshot.get("rows") or []:
        if not isinstance(row, dict):
            continue
        key = str(row.get("key", ""))
        value = str(row.get("value", ""))
        if not key:
            continue
        if not is_disk_kv_key_in_conversation_scope(key, conversation_id):
            continue
        value = rebind_disk_kv_row_value(key, value, conversation_id, workspace_identifier)
        rows_out[key] = value
    return rows_out


def build_bundle(conversation_id: str, state_db: Path | None) -> tuple[dict[str, Any], list[str]]:
    warnings: list[str] = []
    store_snapshot = None
    store_info = find_store_db(conversation_id)
    if store_info:
        store_path, ws_key = store_info
        raw = store_path.read_bytes()
        store_snapshot = {
            "content": base64.b64encode(raw).decode("ascii"),
            "encoding": "base64",
            "checksum": sha256_hex(raw),
            "sizeBytes": len(raw),
            "sourceWorkspaceKey": ws_key,
        }
    else:
        warnings.append(
            f"store.db not found for {conversation_id}; only transcripts will be exported."
        )

    sidebar_snapshot = None
    db_candidates = [state_db] if state_db else list_state_db_candidates()
    for db in db_candidates:
        if db is None or not db.is_file():
            continue
        try:
            rows = read_composer_rows(db)
            if rows:
                sidebar_snapshot = {"conversationId": conversation_id, "stateDbPath": str(db)}
                if isinstance(rows.get("composerHeaders"), dict):
                    sidebar_snapshot["composerHeaders"] = filter_composer_headers_for_conversation(
                        rows["composerHeaders"], conversation_id
                    )
                if isinstance(rows.get("composerData"), dict):
                    sidebar_snapshot["composerData"] = filter_composer_data_for_conversation(
                        rows["composerData"], conversation_id
                    )
                if not (sidebar_snapshot.get("composerHeaders") or {}).get("allComposers"):
                    warnings.append(
                        f"{conversation_id} not in composer.composerHeaders at {db}; "
                        "import will synthesize a sidebar row from the bundle title."
                    )
                break
        except sqlite3.Error as e:
            warnings.append(f"state read failed ({db}): {e}")
    if sidebar_snapshot is None and db_candidates:
        warnings.append("composer.* not found in state.vscdb; sidebar metadata skipped.")

    disk_kv_snapshot = None
    global_db = global_state_db_path()
    try:
        disk_kv_snapshot = export_disk_kv_snapshot(global_db, conversation_id)
    except sqlite3.Error as e:
        warnings.append(f"diskKv export failed: {e}")
    if disk_kv_snapshot is None:
        warnings.append(
            f"No cursorDiskKV rows for {conversation_id}; "
            "import will synthesize text-only composer bubbles."
        )

    transcript_files: list[dict[str, Any]] = []
    proot = projects_root()
    if proot.is_dir():
        for proj in sorted(proot.iterdir()):
            if not proj.is_dir():
                continue
            tdir = proj / "agent-transcripts" / conversation_id
            if not tdir.is_dir():
                continue
            for jf in iter_conversation_jsonl_files(tdir):
                rel_suffix = jf.relative_to(tdir).as_posix()
                raw = jf.read_bytes()
                transcript_files.append(
                    {
                        "relativePath": f"{proj.name}/agent-transcripts/{conversation_id}/{rel_suffix}",
                        "content": base64.b64encode(raw).decode("ascii"),
                        "encoding": "base64",
                        "checksum": sha256_hex(raw),
                        "sizeBytes": len(raw),
                    }
                )

    if not transcript_files and not store_snapshot:
        raise SystemExit(
            f"No data for conversation {conversation_id}. Check ID under agent-transcripts or chats."
        )

    title = conversation_id
    if transcript_files:
        first = base64.b64decode(transcript_files[0]["content"])
        hint = first_user_text_from_bytes(first)
        if hint:
            title = hint[:120]

    schema_version = SCHEMA_VERSION if disk_kv_snapshot is None else 2
    bundle: dict[str, Any] = {
        "schemaVersion": schema_version,
        "type": BUNDLE_TYPE,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "conversationId": conversation_id,
        "title": title,
        "subtitle": f"{len(transcript_files)} file(s)",
        "previewText": title,
        "sidebarSnapshot": sidebar_snapshot,
        "storeSnapshot": store_snapshot,
        "transcriptFiles": transcript_files,
    }
    if disk_kv_snapshot is not None:
        bundle["diskKvSnapshot"] = disk_kv_snapshot

    agent_kv_snapshot = None
    try:
        agent_kv_snapshot = export_agent_kv_snapshot(global_db, conversation_id)
    except sqlite3.Error as e:
        warnings.append(f"agentKv export failed: {e}")
    if agent_kv_snapshot is not None:
        bundle["agentKvSnapshot"] = agent_kv_snapshot
        for w in agent_kv_snapshot.get("warnings") or []:
            warnings.append(w)

    return bundle, warnings


def first_user_text_from_bytes(raw: bytes) -> str:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return ""
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("role") != "user":
            continue
        msg = obj.get("message") or {}
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    t = block.get("text", "")
                    if isinstance(t, str) and t.strip():
                        return t.strip()[:80]
    return ""


def decode_artifact(content: str, encoding: str | None) -> bytes:
    if encoding == "base64":
        return base64.b64decode(content)
    return content.encode("utf-8")


GOLDEN_STORE_TEMPLATE_VERSION = 2


def skill_resources_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "resources"


def resolve_golden_store_template_path() -> Path | None:
    candidates = [
        skill_resources_dir() / "golden-chat-store.template.db",
        Path(os.environ.get("CURSOR_SYNC_GOLDEN_STORE", "")),
        Path.home() / "dev/private/cursor-sync/resources/golden-chat-store.template.db",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def read_template_user_version(db_path: Path) -> int | None:
    try:
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute("PRAGMA user_version;").fetchone()
            if row and row[0] is not None:
                return int(row[0])
        finally:
            conn.close()
    except sqlite3.Error:
        return None
    return None


def assert_golden_template_layout(db_path: Path) -> None:
    ver = read_template_user_version(db_path)
    if ver != GOLDEN_STORE_TEMPLATE_VERSION:
        raise RuntimeError(
            f"Golden store template user_version mismatch: expected "
            f"{GOLDEN_STORE_TEMPLATE_VERSION}, got {ver!r}. "
            "Regenerate resources/golden-chat-store.template.db."
        )
    conn = sqlite3.connect(db_path)
    try:
        blob_cols = {row[1] for row in conn.execute("PRAGMA table_info(blobs);").fetchall()}
        meta_cols = {row[1] for row in conn.execute("PRAGMA table_info(meta);").fetchall()}
    finally:
        conn.close()
    if "data" not in blob_cols or "value" not in meta_cols:
        raise RuntimeError(
            "Golden store template missing expected columns blobs(id,data) and meta(key,value). "
            "Regenerate resources/golden-chat-store.template.db."
        )


def bundle_created_at_ms(bundle: dict[str, Any]) -> int:
    raw = bundle.get("createdAt")
    if isinstance(raw, str) and raw.strip():
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return int(dt.timestamp() * 1000)
        except ValueError:
            pass
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def messages_from_chat_bundle(bundle: dict[str, Any]) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    for tf in bundle.get("transcriptFiles") or []:
        if not isinstance(tf, dict):
            continue
        try:
            raw = decode_artifact(tf.get("content", ""), tf.get("encoding"))
            text = raw.decode("utf-8", errors="replace")
        except (ValueError, TypeError):
            continue
        for line in text.splitlines():
            row = line.strip()
            if not row:
                continue
            try:
                parsed = json.loads(row)
            except json.JSONDecodeError:
                continue
            if not isinstance(parsed, dict):
                continue
            role = parsed.get("role") or "user"
            if role not in ("user", "assistant", "tool"):
                role = "user"
            parts = (parsed.get("message") or {}).get("content") or []
            content = ""
            if isinstance(parts, list):
                content = "\n".join(
                    str(p.get("text", ""))
                    for p in parts
                    if isinstance(p, dict) and p.get("type") == "text"
                )
            if content.strip():
                messages.append({"role": role, "content": content})
    return messages


def chat_manifest_from_bundle(bundle: dict[str, Any]) -> dict[str, Any]:
    cid = str(bundle.get("conversationId", ""))
    title = str(bundle.get("title") or cid).strip() or cid
    content = messages_from_chat_bundle(bundle)
    if not content:
        preview = str(bundle.get("previewText") or title)
        content = [{"role": "user", "content": preview}]
    return {
        "chat_id": cid,
        "title": title[:120],
        "content": content,
        "timestamp": bundle_created_at_ms(bundle),
    }


def build_cursor_message_blob_bytes(chat: dict[str, Any]) -> list[bytes]:
    blobs: list[bytes] = []
    for m in chat.get("content") or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role") or "user"
        if role not in ("user", "assistant", "tool"):
            role = "user"
        text = str(m.get("content", ""))
        payload = json.dumps(
            {"role": role, "content": [{"type": "text", "text": text}]},
            separators=(",", ":"),
            ensure_ascii=False,
        )
        blobs.append(payload.encode("utf-8"))
    return blobs


def build_cursor_tree_blob(ref_hashes_hex: list[str]) -> bytes:
    parts: list[bytes] = []
    for hex_hash in ref_hashes_hex:
        parts.append(b"\x0a\x20")
        parts.append(bytes.fromhex(hex_hash))
    parts.append(b"\x2a\x00")
    return b"".join(parts)


def chat_timestamp_ms(chat: dict[str, Any]) -> int:
    ts = chat.get("timestamp")
    if isinstance(ts, (int, float)):
        v = int(ts)
        return v if v >= 1_000_000_000_000 else v * 1000
    if isinstance(ts, str) and ts.strip().isdigit():
        v = int(ts.strip())
        return v if v >= 1_000_000_000_000 else v * 1000
    return bundle_created_at_ms({"createdAt": ""})


def hydrate_golden_store_template(
    template_path: Path,
    output_path: Path,
    chat: dict[str, Any],
) -> list[str]:
    warnings: list[str] = []
    assert_golden_template_layout(template_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(template_path.read_bytes())

    message_blobs = build_cursor_message_blob_bytes(chat)
    if not message_blobs:
        fallback = json.dumps(
            {"role": "user", "content": [{"type": "text", "text": chat.get("title", "")}]},
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        message_blobs = [fallback]
    message_hashes = [hashlib.sha256(b).hexdigest() for b in message_blobs]
    tree_blob = build_cursor_tree_blob(message_hashes)
    tree_hash = hashlib.sha256(tree_blob).hexdigest()

    meta_obj = {
        "agentId": chat["chat_id"],
        "latestRootBlobId": tree_hash,
        "name": chat["title"],
        "mode": "default",
        "isRunEverything": True,
        "createdAt": chat_timestamp_ms(chat),
    }
    meta_json = json.dumps(meta_obj, separators=(",", ":"), ensure_ascii=False)

    conn = sqlite3.connect(output_path)
    try:
        conn.execute("BEGIN IMMEDIATE;")
        conn.execute("INSERT INTO meta(key, value) VALUES (?, ?);", ("0", meta_json))
        seen: set[str] = set()
        for hex_id, blob_bytes in zip(message_hashes, message_blobs):
            if hex_id in seen:
                continue
            seen.add(hex_id)
            conn.execute(
                "INSERT INTO blobs(id, data) VALUES (?, ?);",
                (hex_id, sqlite3.Binary(blob_bytes)),
            )
        if tree_hash not in seen:
            conn.execute(
                "INSERT INTO blobs(id, data) VALUES (?, ?);",
                (tree_hash, sqlite3.Binary(tree_blob)),
            )
        conn.commit()
    finally:
        conn.close()
    warnings.append(
        "Synthesized store.db from golden template (bundle had no store.db snapshot)."
    )
    warnings.append(
        "Golden template hydration is best-effort; Cursor upgrades may change store.db layout."
    )
    return warnings


def _uuid4_hex() -> str:
    return str(uuid.uuid4())


def _random_b64_key(num_bytes: int = 32) -> str:
    return base64.b64encode(os.urandom(num_bytes)).decode("ascii")


def _iso_from_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _bubble_type_for_role(role: str) -> int:
    return 2 if role in ("assistant", "tool") else 1


def build_bubble_row(
    bubble_id: str,
    role: str,
    text: str,
    created_at_ms: int,
) -> dict[str, Any]:
    return {
        "_v": 3,
        "bubbleId": bubble_id,
        "type": _bubble_type_for_role(role),
        "unifiedMode": 2,
        "createdAt": _iso_from_ms(created_at_ms),
        "text": text,
        "richText": "",
        "requestId": "",
        "conversationState": "~",
        "isAgentic": False,
        "isRefunded": False,
        "existedPreviousTerminalCommand": False,
        "existedSubsequentTerminalCommand": False,
        "attachedHumanChanges": False,
        "cursorCommandsExplicitlySet": False,
        "pastChatsExplicitlySet": False,
        "tokenCount": {"inputTokens": 0, "outputTokens": 0},
        "codeBlocks": [],
        "approximateLintErrors": [],
        "lints": [],
        "codebaseContextChunks": [],
        "commits": [],
        "pullRequests": [],
        "attachedCodeChunks": [],
        "assistantSuggestedDiffs": [],
        "gitDiffs": [],
        "interpreterResults": [],
        "images": [],
        "attachedFolders": [],
        "attachedFoldersNew": [],
        "attachedFoldersListDirResults": [],
        "attachedFileCodeChunksMetadataOnly": [],
        "userResponsesToSuggestedCodeBlocks": [],
        "suggestedCodeBlocks": [],
        "diffsForCompressingFiles": [],
        "relevantFiles": [],
        "toolResults": [],
        "notepads": [],
        "capabilities": [],
        "multiFileLinterErrors": [],
        "diffHistories": [],
        "recentLocationsHistory": [],
        "recentlyViewedFiles": [],
        "fileDiffTrajectories": [],
        "docsReferences": [],
        "webReferences": [],
        "aiWebSearchResults": [],
        "humanChanges": [],
        "summarizedComposers": [],
        "cursorRules": [],
        "cursorCommands": [],
        "pastChats": [],
        "contextPieces": [],
        "editTrailContexts": [],
        "allThinkingBlocks": [],
        "diffsSinceLastApply": [],
        "deletedFiles": [],
        "supportedTools": [],
        "consoleLogs": [],
        "uiElementPicked": [],
        "knowledgeItems": [],
        "documentationSelections": [],
        "externalLinks": [],
        "projectLayouts": [],
        "capabilityContexts": [],
        "todos": [],
        "mcpDescriptors": [],
        "workspaceUris": [],
    }


def build_composer_data_row(
    cid: str,
    title: str,
    created_at_ms: int,
    headers: list[dict[str, Any]],
    workspace_identifier: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        "_v": 16,
        "composerId": cid,
        "name": title,
        "richText": "",
        "text": "",
        "hasLoaded": True,
        "fullConversationHeadersOnly": headers,
        "conversationMap": {},
        "status": "completed",
        "context": {
            "composers": [],
            "selectedCommits": [],
            "selectedPullRequests": [],
            "selectedImages": [],
            "folderSelections": [],
            "fileSelections": [],
            "selections": [],
            "terminalSelections": [],
            "selectedDocs": [],
            "externalLinks": [],
            "cursorRules": [],
            "cursorCommands": [],
            "gitPRDiffSelections": [],
            "subagentSelections": [],
            "browserSelections": [],
            "mentions": {
                "composers": {},
                "selectedCommits": {},
                "selectedPullRequests": {},
                "gitDiff": [],
                "gitDiffFromBranchToMain": [],
                "selectedImages": {},
                "folderSelections": {},
                "fileSelections": {},
                "terminalFiles": {},
                "selections": {},
                "terminalSelections": {},
                "selectedDocs": {},
                "externalLinks": {},
                "diffHistory": [],
                "cursorRules": {},
                "cursorCommands": {},
                "uiElementSelections": [],
                "consoleLogs": [],
                "ideEditorsState": [],
                "gitPRDiffSelections": {},
                "subagentSelections": {},
                "browserSelections": {},
            },
        },
        "generatingBubbleIds": [],
        "isReadingLongFile": False,
        "codeBlockData": {},
        "originalFileStates": {},
        "newlyCreatedFiles": [],
        "newlyCreatedFolders": [],
        "createdAt": created_at_ms,
        "hasChangedContext": False,
        "activeTabsShouldBeReactive": True,
        "capabilities": [],
        "isFileListExpanded": False,
        "browserChipManuallyDisabled": False,
        "browserChipManuallyEnabled": False,
        "unifiedMode": "agent",
        "forceMode": "agent",
        "usageData": {},
        "allAttachedFileCodeChunksUris": [],
        "modelConfig": {"modelName": "default", "maxMode": False},
        "subComposerIds": [],
        "subagentComposerIds": [],
        "capabilityContexts": [],
        "todos": [],
        "isQueueExpanded": True,
        "hasUnreadMessages": False,
        "gitHubPromptDismissed": False,
        "totalLinesAdded": 0,
        "totalLinesRemoved": 0,
        "addedFiles": 0,
        "removedFiles": 0,
        "isDraft": False,
        "isCreatingWorktree": False,
        "isApplyingWorktree": False,
        "isUndoingWorktree": False,
        "applied": False,
        "pendingCreateWorktree": False,
        "worktreeStartedReadOnly": False,
        "isBestOfNSubcomposer": False,
        "isBestOfNParent": False,
        "bestOfNJudgeWinner": False,
        "isSpec": False,
        "isProject": False,
        "isSpecSubagentDone": False,
        "isContinuationInProgress": False,
        "stopHookLoopCount": 0,
        "speculativeSummarizationEncryptionKey": _random_b64_key(),
        "blobEncryptionKey": _random_b64_key(),
        "isNAL": True,
        "planModeSuggestionUsed": False,
        "debugModeSuggestionUsed": False,
        "conversationState": "~",
        "queueItems": [],
        "isAgentic": True,
        "workspaceIdentifier": workspace_identifier,
    }


def build_cursor_disk_kv_rows_from_bundle(
    bundle: dict[str, Any],
    cid: str,
    workspace_identifier: dict[str, Any] | None,
) -> dict[str, str]:
    chat = chat_manifest_from_bundle(bundle)
    base_ms = chat_timestamp_ms(chat)
    headers: list[dict[str, Any]] = []
    rows: dict[str, str] = {}
    for i, m in enumerate(chat.get("content") or []):
        if not isinstance(m, dict):
            continue
        bid = _uuid4_hex()
        role = m.get("role") or "user"
        text = str(m.get("content", ""))
        msg_ms = base_ms + i
        bubble = build_bubble_row(bid, role, text, msg_ms)
        rows[f"bubbleId:{cid}:{bid}"] = json.dumps(bubble, separators=(",", ":"), ensure_ascii=False)
        headers.append(
            {
                "bubbleId": bid,
                "type": _bubble_type_for_role(role),
                "grouping": {"isRenderable": True, "hasText": bool(text)},
            }
        )
    composer_data = build_composer_data_row(
        cid=cid,
        title=chat["title"],
        created_at_ms=base_ms,
        headers=headers,
        workspace_identifier=workspace_identifier,
    )
    rows[f"composerData:{cid}"] = json.dumps(composer_data, separators=(",", ":"), ensure_ascii=False)
    return rows


def merge_cursor_disk_kv(
    db_path: Path,
    rows: dict[str, str],
    dry_run: bool,
    conversation_id: str | None = None,
) -> tuple[bool, list[str]]:
    warnings: list[str] = []
    if conversation_id:
        scoped: dict[str, str] = {}
        for key, value in rows.items():
            if is_disk_kv_key_in_conversation_scope(key, conversation_id):
                scoped[key] = value
        rows = scoped
    if not rows:
        warnings.append("No cursorDiskKV rows to write.")
        return False, warnings
    if dry_run:
        return True, warnings
    conn = sqlite3.connect(db_path, timeout=30)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("BEGIN IMMEDIATE;")
        for key, value in rows.items():
            conn.execute(
                "INSERT OR REPLACE INTO cursorDiskKV(key, value) VALUES (?, ?);",
                (key, value),
            )
        conn.commit()
    except sqlite3.Error:
        conn.rollback()
        raise
    finally:
        conn.close()
    return True, warnings


def synthesize_store_db_from_bundle(
    bundle: dict[str, Any],
    chats_workspace_key: str,
    conversation_id: str,
    *,
    dry_run: bool,
) -> tuple[bool, list[str]]:
    warnings: list[str] = []
    template = resolve_golden_store_template_path()
    if template is None:
        warnings.append(
            "Golden store template missing; cannot synthesize store.db "
            f"(expected {skill_resources_dir() / 'golden-chat-store.template.db'})."
        )
        return False, warnings
    target = chats_root() / chats_workspace_key / conversation_id / "store.db"
    if dry_run:
        print(
            f"[dry-run] would synthesize store {target} from golden template ({template})",
            file=sys.stderr,
        )
        return True, warnings
    try:
        chat = chat_manifest_from_bundle(bundle)
        warnings.extend(hydrate_golden_store_template(template, target, chat))
        print(f"Wrote synthesized store {target} ({target.stat().st_size} bytes)")
        return True, warnings
    except (RuntimeError, sqlite3.Error, OSError) as e:
        warnings.append(f"Golden store synthesis failed: {e}")
        return False, warnings


def merge_state_db(
    db_path: Path,
    bundle: dict[str, Any],
    dry_run: bool,
    pin_recent: bool = True,
    workspace_ctx: WorkspaceContext | None = None,
) -> tuple[bool, list[str]]:
    warnings: list[str] = []
    snap = bundle.get("sidebarSnapshot")
    if not isinstance(snap, dict):
        warnings.append("No sidebarSnapshot in bundle; state merge skipped.")
        return False, warnings

    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT key, value FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData')"
        )
        existing_headers: str | None = None
        existing_data: str | None = None
        for key, value in cur.fetchall():
            if key == "composer.composerHeaders":
                existing_headers = item_table_value_as_text(value)
            if key == "composer.composerData":
                existing_data = item_table_value_as_text(value)

        headers_payload = headers_payload_for_import(bundle)
        cid = bundle.get("conversationId")
        if not isinstance(cid, str) or not cid.strip():
            warnings.append("Bundle missing conversationId; state merge skipped.")
            return False, warnings
        cid = cid.strip()

        scripts: list[str] = ["BEGIN IMMEDIATE;"]
        if headers_payload:
            merged = merge_headers_chain(existing_headers, [headers_payload])
            if pin_recent:
                merged = pin_composer_as_most_recent(merged, cid)
            if workspace_ctx is not None:
                merged = stamp_workspace_identifier_on_headers(
                    merged, cid, workspace_ctx.workspace_identifier
                )
            escaped = escape_sql_literal(json.dumps(merged, separators=(",", ":")))
            scripts.append(
                f"UPDATE ItemTable SET value = '{escaped}' WHERE key = 'composer.composerHeaders';"
            )
            scripts.append(
                f"INSERT INTO ItemTable (key, value) SELECT 'composer.composerHeaders', '{escaped}' "
                "WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerHeaders');"
            )

        merged_data = composer_data_for_focus(cid, existing_data)
        if isinstance(snap, dict) and isinstance(snap.get("composerData"), dict):
            extra = filter_composer_data_for_conversation(snap["composerData"], cid)
            if extra:
                merged_data = merge_data_additive(
                    json.dumps(merged_data, separators=(",", ":")), [extra]
                )
        if workspace_ctx is not None:
            from cursor_chat_io_common import stamp_workspace_on_item_table_composer_data

            merged_data = stamp_workspace_on_item_table_composer_data(
                merged_data, cid, workspace_ctx.workspace_identifier
            )
        escaped_d = escape_sql_literal(json.dumps(merged_data, separators=(",", ":")))
        scripts.append(
            f"UPDATE ItemTable SET value = '{escaped_d}' WHERE key = 'composer.composerData';"
        )
        scripts.append(
            f"INSERT INTO ItemTable (key, value) SELECT 'composer.composerData', '{escaped_d}' "
            "WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerData');"
        )
        scripts.append("COMMIT;")
        if len(scripts) <= 2:
            warnings.append("Nothing to merge into state.vscdb.")
            return False, warnings
        if dry_run:
            return True, warnings
        cur.executescript("\n".join(scripts))
        conn.commit()
        row = cur.execute(
            "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders' LIMIT 1"
        ).fetchone()
        merged_headers = parse_headers_blob(
            item_table_value_as_text(row[0]) if row else None
        )
        composers = merged_headers.get("allComposers")
        in_list = isinstance(composers, list) and any(
            isinstance(e, dict) and e.get("composerId") == cid for e in composers
        )
        agent_debug_log(
            "H",
            "cursor_chat_io_bundle.py:merge_state_db",
            "sidebar headers merged",
            {
                "conversationId": cid,
                "dbPath": str(db_path),
                "allComposersCount": len(composers) if isinstance(composers, list) else 0,
                "conversationInHeaders": in_list,
                "hadHeadersPayload": bool(headers_payload),
            },
        )
        return True, warnings
    finally:
        conn.close()

