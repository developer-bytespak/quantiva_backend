"""Market data services."""
# Lazy import to avoid pandas dependency when not needed
try:
    from .market_data_service import MarketDataService
    __all__ = ['MarketDataService']
except ImportError:
    # If pandas not available, don't export MarketDataService
    __all__ = []

