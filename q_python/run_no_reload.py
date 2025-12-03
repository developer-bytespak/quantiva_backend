r"""Run helper for the FastAPI app without reload (better Ctrl+C handling on Windows).

Run with:
  python run_no_reload.py

If you activated the venv, that python will be used. Otherwise run:
  .\v312\Scripts\python run_no_reload.py
"""

import sys
import signal


def main() -> int:
    try:
        import uvicorn
    except Exception:
        print("uvicorn is not installed in this environment.")
        print("Install it with: pip install -r requirements\\base.txt")
        return 1

    # Handle Ctrl+C gracefully
    def signal_handler(sig, frame):
        print("\n\nShutting down server...")
        sys.exit(0)
    
    # Register signal handlers
    signal.signal(signal.SIGINT, signal_handler)
    if hasattr(signal, 'SIGTERM'):
        signal.signal(signal.SIGTERM, signal_handler)

    try:
        # Run without reload for better signal handling on Windows
        uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=False, app_dir="src")
    except KeyboardInterrupt:
        print("\n\nShutting down server...")
        return 0
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n\nShutting down server...")
        sys.exit(0)

