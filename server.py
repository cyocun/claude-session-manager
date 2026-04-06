import json
import os
import subprocess
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel

app = FastAPI()

CLAUDE_DIR = Path.home() / ".claude"
HISTORY_FILE = CLAUDE_DIR / "history.jsonl"
PROJECTS_DIR = CLAUDE_DIR / "projects"
DATA_DIR = Path(__file__).parent
ARCHIVE_FILE = DATA_DIR / "archive.json"
SETTINGS_FILE = DATA_DIR / "settings.json"


def load_archive() -> set[str]:
    if ARCHIVE_FILE.exists():
        return set(json.loads(ARCHIVE_FILE.read_text()))
    return set()


def save_archive(archived: set[str]):
    ARCHIVE_FILE.write_text(json.dumps(sorted(archived), ensure_ascii=False))


def load_settings() -> dict:
    if SETTINGS_FILE.exists():
        return json.loads(SETTINGS_FILE.read_text())
    return {"terminalApp": "Terminal"}


def save_settings(settings: dict):
    SETTINGS_FILE.write_text(json.dumps(settings, ensure_ascii=False, indent=2))


def find_session_file(session_id: str) -> Path | None:
    target = f"{session_id}.jsonl"
    for dirpath, _, filenames in os.walk(PROJECTS_DIR):
        if target in filenames:
            return Path(dirpath) / target
    return None


@app.get("/api/sessions")
def get_sessions(include_archived: bool = False):
    if not HISTORY_FILE.exists():
        return []

    sessions_by_id: dict[str, dict] = {}

    with open(HISTORY_FILE) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            sid = entry.get("sessionId")
            if not sid:
                continue

            if sid not in sessions_by_id:
                sessions_by_id[sid] = {
                    "sessionId": sid,
                    "project": entry.get("project", ""),
                    "firstDisplay": entry.get("display", ""),
                    "lastDisplay": entry.get("display", ""),
                    "firstTimestamp": entry.get("timestamp", 0),
                    "lastTimestamp": entry.get("timestamp", 0),
                    "messageCount": 1,
                }
            else:
                s = sessions_by_id[sid]
                ts = entry.get("timestamp", 0)
                if ts > s["lastTimestamp"]:
                    s["lastTimestamp"] = ts
                    s["lastDisplay"] = entry.get("display", s["lastDisplay"])
                s["messageCount"] += 1

    archived = load_archive()
    results = []
    for s in sessions_by_id.values():
        s["archived"] = s["sessionId"] in archived
        if not include_archived and s["archived"]:
            continue
        results.append(s)

    results.sort(key=lambda x: x["lastTimestamp"], reverse=True)
    return results


@app.get("/api/sessions/{session_id}")
def get_session_detail(session_id: str):
    if not HISTORY_FILE.exists():
        raise HTTPException(404, "History not found")

    project_path = None
    with open(HISTORY_FILE) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("sessionId") == session_id:
                project_path = entry.get("project", "")
                break

    if project_path is None:
        raise HTTPException(404, "Session not found")

    session_file = find_session_file(session_id)

    messages = []
    if session_file and session_file.exists():
        with open(session_file) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg_type = msg.get("type", "")
                if msg_type in ("user", "assistant"):
                    messages.append(extract_message(msg))

    return {
        "sessionId": session_id,
        "project": project_path,
        "messages": messages,
    }


def extract_message(msg: dict) -> dict:
    msg_type = msg.get("type", "")
    content = msg.get("message", {}).get("content", "")

    text_parts = []
    tools = []

    if isinstance(content, list):
        for block in content:
            if isinstance(block, str):
                text_parts.append(block)
            elif isinstance(block, dict):
                btype = block.get("type", "")
                if btype == "text":
                    text_parts.append(block.get("text", ""))
                elif btype == "tool_use":
                    tool_name = block.get("name", "unknown")
                    tool_input = block.get("input", {})
                    tool_id = block.get("id", "")
                    tool_info = {"name": tool_name, "id": tool_id}
                    if tool_name == "Bash":
                        tool_info["command"] = tool_input.get("command", "")
                        tool_info["description"] = tool_input.get("description", "")
                    elif tool_name == "Edit":
                        tool_info["file"] = tool_input.get("file_path", "")
                        tool_info["old"] = (tool_input.get("old_string", "") or "")[:500]
                        tool_info["new"] = (tool_input.get("new_string", "") or "")[:500]
                    elif tool_name == "Write":
                        tool_info["file"] = tool_input.get("file_path", "")
                        tool_info["content"] = (tool_input.get("content", "") or "")[:500]
                    elif tool_name == "Read":
                        tool_info["file"] = tool_input.get("file_path", "")
                    elif tool_name in ("Glob", "Grep"):
                        tool_info["pattern"] = tool_input.get("pattern", "")
                        tool_info["path"] = tool_input.get("path", "")
                    else:
                        tool_info["input"] = {
                            k: str(v)[:300] for k, v in tool_input.items()
                        }
                    tools.append(tool_info)
                elif btype == "tool_result":
                    tool_id = block.get("tool_use_id", "")
                    result_content = block.get("content", "")
                    if isinstance(result_content, list):
                        result_text = "\n".join(
                            b.get("text", "") if isinstance(b, dict) else str(b)
                            for b in result_content
                        )
                    else:
                        result_text = str(result_content)
                    tools.append({
                        "name": "_result",
                        "id": tool_id,
                        "output": result_text[:2000],
                    })
        content = "\n".join(text_parts)
    elif not isinstance(content, str):
        content = str(content)

    result = {
        "type": msg_type,
        "content": content[:2000],
        "timestamp": msg.get("timestamp", 0),
    }
    if tools:
        result["tools"] = tools
    return result


class ArchiveRequest(BaseModel):
    session_ids: list[str]
    archive: bool = True


@app.post("/api/archive")
def archive_sessions(req: ArchiveRequest):
    archived = load_archive()
    if req.archive:
        archived.update(req.session_ids)
    else:
        archived -= set(req.session_ids)
    save_archive(archived)
    return {"ok": True, "archived_count": len(archived)}


@app.get("/api/resume-command/{session_id}")
def get_resume_command(session_id: str):
    project_path = None
    with open(HISTORY_FILE) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("sessionId") == session_id:
                project_path = entry.get("project", "")
                break

    if project_path is None:
        raise HTTPException(404, "Session not found")

    cmd = f"cd {project_path} && claude --resume {session_id}"
    return {"command": cmd, "project": project_path, "sessionId": session_id}


def find_running_session(session_id: str) -> dict | None:
    """claude --resume <session_id> が実行中かチェック"""
    try:
        result = subprocess.run(
            ["pgrep", "-af", f"claude.*--resume.*{session_id}"],
            capture_output=True, text=True, timeout=3,
        )
        if result.returncode == 0 and result.stdout.strip():
            return {"pid": result.stdout.strip().split()[0]}
    except Exception:
        pass
    return None


def activate_terminal_window(session_id: str, terminal_app: str) -> bool:
    """セッションIDを含むターミナルウィンドウをアクティブにする"""
    if terminal_app == "iTerm":
        script = f'''
        tell application "iTerm"
            repeat with w in windows
                repeat with t in tabs of w
                    repeat with s in sessions of t
                        if tty of s is not "" then
                            set sessionName to name of s
                            if sessionName contains "{session_id}" then
                                select t
                                set index of w to 1
                                activate
                                return true
                            end if
                        end if
                    end repeat
                end repeat
            end repeat
        end tell
        return false
        '''
    elif terminal_app == "Terminal":
        script = f'''
        tell application "Terminal"
            repeat with w in windows
                repeat with t in tabs of w
                    if processes of t contains "claude" then
                        set customTitle to custom title of t
                        if customTitle contains "{session_id}" then
                            set selected tab of w to t
                            set index of w to 1
                            activate
                            return true
                        end if
                    end if
                end repeat
            end repeat
        end tell
        return false
        '''
    else:
        return False

    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=5,
        )
        return "true" in result.stdout.strip().lower()
    except Exception:
        return False


@app.get("/api/session-status/{session_id}")
def get_session_status(session_id: str):
    running = find_running_session(session_id)
    return {"running": running is not None, "pid": running["pid"] if running else None}


@app.post("/api/resume/{session_id}")
def resume_session(session_id: str):
    project_path = None
    with open(HISTORY_FILE) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("sessionId") == session_id:
                project_path = entry.get("project", "")
                break

    if project_path is None:
        raise HTTPException(404, "Session not found")

    settings = load_settings()
    terminal_app = settings.get("terminalApp", "Terminal")

    # Check if already running - try to activate existing window
    running = find_running_session(session_id)
    if running:
        activated = activate_terminal_window(session_id, terminal_app)
        if activated:
            return {"ok": True, "method": "activated", "pid": running["pid"]}
        # Process exists but couldn't find window - just activate the terminal app
        try:
            subprocess.Popen(["osascript", "-e",
                f'tell application "{terminal_app}" to activate'])
            return {"ok": True, "method": "activated-app", "pid": running["pid"]}
        except Exception:
            pass

    cmd = f"cd {project_path} && claude --resume {session_id}"

    if terminal_app == "iTerm":
        apple_script = f'''
        tell application "iTerm"
            activate
            tell current window
                create tab with default profile
                tell current session
                    write text "{cmd}"
                end tell
            end tell
        end tell
        '''
    elif terminal_app == "Warp":
        apple_script = f'''
        tell application "Warp"
            activate
        end tell
        delay 0.3
        tell application "System Events"
            tell process "Warp"
                keystroke "t" using command down
                delay 0.2
                keystroke "{cmd}"
                key code 36
            end tell
        end tell
        '''
    elif terminal_app == "Ghostty":
        apple_script = f'''
        tell application "Ghostty"
            activate
        end tell
        delay 0.3
        tell application "System Events"
            tell process "Ghostty"
                keystroke "t" using command down
                delay 0.2
                keystroke "{cmd}"
                key code 36
            end tell
        end tell
        '''
    elif terminal_app == "tmux":
        try:
            subprocess.Popen(
                ["tmux", "new-window", "-n", "claude", cmd],
            )
            return {"ok": True, "method": "tmux"}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    else:
        apple_script = f'''
        tell application "Terminal"
            activate
            do script "{cmd}"
        end tell
        '''

    try:
        subprocess.Popen(["osascript", "-e", apple_script])
        return {"ok": True, "method": terminal_app}
    except Exception as e:
        return {"ok": False, "error": str(e)}


_project_name_cache: dict[str, str | None] = {}


def resolve_project_name(project_path: str) -> str | None:
    """package.json の name や git remote から表示名を解決する"""
    if project_path in _project_name_cache:
        return _project_name_cache[project_path]

    name = None
    p = Path(project_path)

    # 1. package.json
    pkg = p / "package.json"
    if pkg.exists():
        try:
            data = json.loads(pkg.read_text())
            n = data.get("name", "")
            if n and n != "undefined":
                name = n
        except Exception:
            pass

    # 2. git remote origin
    if not name:
        try:
            result = subprocess.run(
                ["git", "-C", str(p), "remote", "get-url", "origin"],
                capture_output=True, text=True, timeout=3,
            )
            url = result.stdout.strip()
            if url:
                # git@github.com:user/repo.git or https://github.com/user/repo.git
                repo = url.rstrip("/").removesuffix(".git").split("/")[-1]
                owner = url.rstrip("/").removesuffix(".git").split("/")[-2]
                if ":" in owner:
                    owner = owner.split(":")[-1]
                name = f"{owner}/{repo}"
        except Exception:
            pass

    # 3. pyproject.toml
    if not name:
        pyproj = p / "pyproject.toml"
        if pyproj.exists():
            try:
                text = pyproj.read_text()
                for line in text.split("\n"):
                    if line.strip().startswith("name"):
                        n = line.split("=", 1)[1].strip().strip('"').strip("'")
                        if n:
                            name = n
                            break
            except Exception:
                pass

    _project_name_cache[project_path] = name
    return name


@app.get("/api/projects")
def get_projects():
    if not HISTORY_FILE.exists():
        return []

    projects: dict[str, dict] = {}
    with open(HISTORY_FILE) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            proj = entry.get("project", "")
            if proj not in projects:
                projects[proj] = {
                    "path": proj,
                    "name": resolve_project_name(proj),
                    "sessionCount": 0,
                    "lastTimestamp": 0,
                }
            projects[proj]["sessionCount"] += 1
            projects[proj]["lastTimestamp"] = max(
                projects[proj]["lastTimestamp"], entry.get("timestamp", 0)
            )

    results = sorted(projects.values(), key=lambda x: x["lastTimestamp"], reverse=True)
    return results


@app.get("/api/settings")
def get_settings():
    return load_settings()


class SettingsUpdate(BaseModel):
    terminalApp: str | None = None


@app.post("/api/settings")
def update_settings(req: SettingsUpdate):
    settings = load_settings()
    if req.terminalApp is not None:
        settings["terminalApp"] = req.terminalApp
    save_settings(settings)
    return settings


@app.get("/", response_class=HTMLResponse)
def index():
    return FileResponse(Path(__file__).parent / "static" / "index.html")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=5533)
