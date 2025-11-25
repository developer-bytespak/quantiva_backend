"""Run helper for the FastAPI app.

Run with:
  python run.py

If you activated the venv, that python will be used. Otherwise run:
  .\.venv\Scripts\python run.py
"""

import sys


def main() -> int:
    try:
        import uvicorn
    except Exception:
        print("uvicorn is not installed in this environment.")
        print("Install it with: pip install -r requirements\\base.txt")
        return 1

    # uvicorn.run accepts the app as a string "module:app" and app_dir to locate it
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True, app_dir="src")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
