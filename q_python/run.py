r"""Run helper for the FastAPI app.

Run with:
  python run.py

If you activated the venv, that python will be used. Otherwise run:
  .\.venv\Scripts\python run.py
"""

import sys
import signal
import os


def main() -> int:
    try:
        import uvicorn
    except Exception:
        print("uvicorn is not installed in this environment.")
        print("Install it with: pip install -r requirements\\base.txt")
        return 1

    # Handle Ctrl+C gracefully on Windows
    def signal_handler(sig, frame):
        print("\n\nShutting down server...")
        # Force exit to ensure cleanup
        os._exit(0)
    
    # Register signal handlers for graceful shutdown
    if sys.platform == "win32":
        # On Windows, use a simpler approach
        try:
            signal.signal(signal.SIGINT, signal_handler)
        except (ValueError, OSError):
            pass  # Signal handling may not work in all contexts
    else:
        signal.signal(signal.SIGINT, signal_handler)
        if hasattr(signal, 'SIGTERM'):
            signal.signal(signal.SIGTERM, signal_handler)

    try:
        # uvicorn.run accepts the app as a string "module:app" and app_dir to locate it
        # Note: On Windows, reload=True can sometimes interfere with Ctrl+C
        # Use reload=False for better signal handling, or use run_no_reload.py
        use_reload = os.environ.get("NO_RELOAD", "").lower() != "true"
        if sys.platform == "win32" and use_reload:
            print("Note: Using reload mode. If Ctrl+C doesn't work, use:")
            print("  set NO_RELOAD=true && python run.py")
            print("  or use: python run_no_reload.py")
        
        uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=use_reload, app_dir="src")
    except KeyboardInterrupt:
        print("\n\nShutting down server...")
        return 0
    except Exception as e:
        print(f"\nError: {e}")
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n\nShutting down server...")
        sys.exit(0)
