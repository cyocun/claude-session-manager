"""
Claude Session Manager — macOS App
Menubar icon + WebView window + FastAPI backend
"""

import threading
import webbrowser

import uvicorn

from server import app as fastapi_app
from menubar import SessionMenuBarApp

PORT = 5533
BASE_URL = f"http://localhost:{PORT}"

# Track webview window
_webview_window = None


def start_server():
    uvicorn.run(fastapi_app, host="0.0.0.0", port=PORT, log_level="warning")


def open_ui(session_id=None):
    global _webview_window

    url = BASE_URL
    if session_id:
        url += f"#session={session_id}"

    try:
        import webview

        if _webview_window is None or _webview_window.gui is None:
            _webview_window = webview.create_window(
                "Claude Sessions",
                url,
                width=1200,
                height=800,
                min_size=(800, 500),
            )
            # Start webview in a new thread (non-blocking)
            threading.Thread(target=webview.start, daemon=True).start()
        else:
            _webview_window.load_url(url)
            _webview_window.show()
    except Exception:
        # Fallback: open in default browser
        webbrowser.open(url)


def main():
    # Start FastAPI server in background thread
    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()

    # Start menubar app (must be on main thread for macOS)
    menubar = SessionMenuBarApp(open_ui_callback=open_ui)
    menubar.run()


if __name__ == "__main__":
    main()
