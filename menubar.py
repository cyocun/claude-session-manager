import json
import subprocess
from pathlib import Path

import rumps

CLAUDE_DIR = Path.home() / ".claude"
HISTORY_FILE = CLAUDE_DIR / "history.jsonl"
ICON_PATH = Path(__file__).parent / "assets" / "icon.png"
SETTINGS_FILE = Path(__file__).parent / "settings.json"


def load_settings() -> dict:
    if SETTINGS_FILE.exists():
        try:
            return json.loads(SETTINGS_FILE.read_text())
        except Exception:
            pass
    return {"terminalApp": "Terminal"}


def get_recent_sessions(n: int = 5) -> list[dict]:
    if not HISTORY_FILE.exists():
        return []

    sessions: dict[str, dict] = {}
    with open(HISTORY_FILE) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue

            sid = entry.get("sessionId")
            if not sid:
                continue

            if sid not in sessions:
                sessions[sid] = {
                    "sessionId": sid,
                    "project": entry.get("project", ""),
                    "display": entry.get("display", ""),
                    "lastTimestamp": entry.get("timestamp", 0),
                }
            else:
                ts = entry.get("timestamp", 0)
                if ts > sessions[sid]["lastTimestamp"]:
                    sessions[sid]["lastTimestamp"] = ts
                    sessions[sid]["display"] = entry.get("display", sessions[sid]["display"])

    sorted_sessions = sorted(sessions.values(), key=lambda x: x["lastTimestamp"], reverse=True)
    return sorted_sessions[:n]


def short_path(p: str) -> str:
    home = str(Path.home())
    if p.startswith(home):
        p = "~" + p[len(home):]
    p = p.replace("~/Dropbox/__WORKS/", "")
    return p.split("/")[-1] if "/" in p else p


def resume_in_terminal(session_id: str, project_path: str):
    settings = load_settings()
    terminal_app = settings.get("terminalApp", "Terminal")
    cmd = f"cd {project_path} && claude --resume {session_id}"

    if terminal_app == "iTerm":
        script = f'''
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
    elif terminal_app == "tmux":
        subprocess.Popen(["tmux", "new-window", "-n", "claude", cmd])
        return
    else:
        script = f'''
        tell application "{terminal_app}"
            activate
            do script "{cmd}"
        end tell
        '''

    subprocess.Popen(["osascript", "-e", script])


class SessionMenuBarApp(rumps.App):
    def __init__(self, open_ui_callback=None):
        icon = str(ICON_PATH) if ICON_PATH.exists() else None
        super().__init__("Claude Sessions", icon=icon, template=True, quit_button=None)
        self.open_ui_callback = open_ui_callback
        self._build_menu()

    def _build_menu(self):
        sessions = get_recent_sessions(5)

        menu_items = []
        for s in sessions:
            proj = short_path(s["project"])
            display = s["display"][:50]
            title = f"{proj}: {display}"
            item = rumps.MenuItem(title)
            item._session_data = s
            item.add(rumps.MenuItem(
                "Resume (Terminal)",
                callback=lambda sender, sd=s: resume_in_terminal(sd["sessionId"], sd["project"]),
            ))
            item.add(rumps.MenuItem(
                "Open in UI",
                callback=lambda sender, sd=s: self._open_session_in_ui(sd["sessionId"]),
            ))
            menu_items.append(item)

        menu_items.append(rumps.separator)
        menu_items.append(rumps.MenuItem("Open UI", callback=self._on_open_ui))
        menu_items.append(rumps.separator)
        menu_items.append(rumps.MenuItem("Quit", callback=rumps.quit_application))

        self.menu.clear()
        for item in menu_items:
            self.menu.add(item)

    def _on_open_ui(self, _):
        if self.open_ui_callback:
            self.open_ui_callback()

    def _open_session_in_ui(self, session_id):
        if self.open_ui_callback:
            self.open_ui_callback(session_id)

    @rumps.timer(30)
    def refresh_sessions(self, _):
        self._build_menu()
