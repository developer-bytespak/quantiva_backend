"""
Production startup script for Render deployment.
This script ensures proper port binding and fast startup.
"""
import os
import sys

def main():
    """Start the FastAPI app in production mode."""
    try:
        import uvicorn
    except ImportError:
        print("❌ uvicorn is not installed")
        print("Install with: pip install -r requirements/base.txt")
        return 1

    # Get port from environment (Render provides this)
    port = int(os.environ.get("PORT", 8000))
    host = "0.0.0.0"
    
    print(f"🚀 Starting Quantiva Python API on {host}:{port}")
    print(f"📦 Environment: {os.environ.get('RENDER', 'production')}")
    
    # Production settings:
    # - No reload (reload=False)
    # - Bind to 0.0.0.0 to accept external connections
    # - Single worker (TensorFlow loaded once, ~600MB)
    # - Async endpoints handle concurrency within the single process
    try:
        uvicorn.run(
            "src.main:app",
            host=host,
            port=port,
            reload=False,
            log_level="info",
            access_log=True
        )
    except KeyboardInterrupt:
        print("\n✅ Server shutdown complete")
        return 0
    except Exception as e:
        print(f"❌ Server error: {e}")
        import traceback
        traceback.print_exc()
        return 1
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
