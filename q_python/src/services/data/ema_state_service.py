"""
EMA State Service
Manages sentiment EMA state storage in PostgreSQL database.
"""
from typing import Optional, Dict, Any
from datetime import datetime
import os
import logging

logger = logging.getLogger(__name__)

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    PSYCOPG2_AVAILABLE = True
except ImportError:
    PSYCOPG2_AVAILABLE = False
    logger.warning("psycopg2 not available. EMA state will not be persisted. Install with: pip install psycopg2-binary")


class EMAStateService:
    """
    Service for storing and retrieving EMA state from PostgreSQL database.
    """
    
    def __init__(self):
        """Initialize EMA state service."""
        self.logger = logging.getLogger(__name__)
        self.db_url = os.getenv("DATABASE_URL")
        
        if not PSYCOPG2_AVAILABLE:
            self.logger.warning("psycopg2 not available. EMA state persistence disabled.")
            self.db_url = None
        elif not self.db_url:
            self.logger.warning("DATABASE_URL not set. EMA state persistence disabled.")
    
    def _get_connection(self):
        """Get database connection."""
        if not self.db_url or not PSYCOPG2_AVAILABLE:
            return None
        
        try:
            return psycopg2.connect(self.db_url)
        except Exception as e:
            self.logger.error(f"Failed to connect to database: {str(e)}")
            return None
    
    def get_ema_state(self, asset_id: str) -> Optional[Dict[str, Any]]:
        """
        Get EMA state for an asset.
        
        Args:
            asset_id: Asset identifier
            
        Returns:
            Dictionary with 'ema_value' and 'last_timestamp', or None if not found
        """
        if not self.db_url or not PSYCOPG2_AVAILABLE:
            return None
        
        conn = self._get_connection()
        if not conn:
            return None
        
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    "SELECT ema_value, last_timestamp FROM sentiment_ema_state WHERE asset_id = %s",
                    (asset_id,)
                )
                row = cur.fetchone()
                
                if row:
                    return {
                        'ema_value': float(row['ema_value']),
                        'last_timestamp': row['last_timestamp']
                    }
                return None
        except Exception as e:
            self.logger.error(f"Error getting EMA state for {asset_id}: {str(e)}")
            return None
        finally:
            conn.close()
    
    def save_ema_state(self, asset_id: str, ema_value: float, timestamp: datetime) -> bool:
        """
        Save EMA state for an asset.
        
        Args:
            asset_id: Asset identifier
            ema_value: Current EMA value
            timestamp: Current timestamp
            
        Returns:
            True if successful, False otherwise
        """
        if not self.db_url or not PSYCOPG2_AVAILABLE:
            return False
        
        conn = self._get_connection()
        if not conn:
            return False
        
        try:
            with conn.cursor() as cur:
                # Use INSERT ... ON CONFLICT to upsert
                cur.execute(
                    """
                    INSERT INTO sentiment_ema_state (asset_id, ema_value, last_timestamp, updated_at)
                    VALUES (%s, %s, %s, NOW())
                    ON CONFLICT (asset_id) 
                    DO UPDATE SET 
                        ema_value = EXCLUDED.ema_value,
                        last_timestamp = EXCLUDED.last_timestamp,
                        updated_at = NOW()
                    """,
                    (asset_id, ema_value, timestamp)
                )
                conn.commit()
                return True
        except Exception as e:
            self.logger.error(f"Error saving EMA state for {asset_id}: {str(e)}")
            conn.rollback()
            return False
        finally:
            conn.close()

