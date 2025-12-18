"""
CoinGecko Service
Fetches cryptocurrency data including developer activity metrics from CoinGecko API.
"""
import logging
import requests
from typing import Dict, Any, Optional
from src.config import COINGECKO_API_KEY

logger = logging.getLogger(__name__)


class CoinGeckoService:
    """
    Service for fetching cryptocurrency data from CoinGecko API.
    Provides developer activity metrics, token supply data, and other fundamental metrics.
    """
    
    BASE_URL = "https://api.coingecko.com/api/v3"
    PRO_BASE_URL = "https://pro-api.coingecko.com/api/v3"
    
    def __init__(self):
        """Initialize CoinGeckoService."""
        self.logger = logging.getLogger(__name__)
        self.api_key = COINGECKO_API_KEY
        
        # Determine if Pro API key (starts with "CG-")
        self.is_pro_api = self.api_key and self.api_key.startswith("CG-")
        self.base_url = self.PRO_BASE_URL if self.is_pro_api else self.BASE_URL
        
        if not self.api_key:
            self.logger.warning(
                "COINGECKO_API_KEY not set. CoinGecko fetching will have rate limits. "
                "Set COINGECKO_API_KEY environment variable for better access."
            )
    
    def _get_headers(self) -> Dict[str, str]:
        """Get request headers with API key if available."""
        headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
        
        if self.api_key and self.is_pro_api:
            headers['x-cg-pro-api-key'] = self.api_key
        
        return headers
    
    def _symbol_to_coin_id(self, symbol: str) -> Optional[str]:
        """
        Convert cryptocurrency symbol to CoinGecko coin ID.
        
        Args:
            symbol: Cryptocurrency symbol (e.g., 'BTC', 'ETH', 'SOL')
        
        Returns:
            CoinGecko coin ID (e.g., 'bitcoin', 'ethereum', 'solana') or None if not found
        """
        if not symbol:
            return None
        
        symbol_upper = symbol.upper()
        
        # Common symbol to ID mappings (most popular coins)
        symbol_to_id_map = {
            'BTC': 'bitcoin',
            'ETH': 'ethereum',
            'BNB': 'binancecoin',
            'SOL': 'solana',
            'XRP': 'ripple',
            'ADA': 'cardano',
            'DOGE': 'dogecoin',
            'DOT': 'polkadot',
            'MATIC': 'matic-network',
            'AVAX': 'avalanche-2',
            'LINK': 'chainlink',
            'UNI': 'uniswap',
            'ATOM': 'cosmos',
            'LTC': 'litecoin',
            'ETC': 'ethereum-classic',
            'XLM': 'stellar',
            'ALGO': 'algorand',
            'VET': 'vechain',
            'ICP': 'internet-computer',
            'FIL': 'filecoin',
            'TRX': 'tron',
            'EOS': 'eos',
            'AAVE': 'aave',
            'MKR': 'maker',
            'COMP': 'compound-governance-token',
            'SUSHI': 'sushi',
            'YFI': 'yearn-finance',
            'SNX': 'havven',
            'CRV': 'curve-dao-token',
            '1INCH': '1inch',
        }
        
        # Check mapping first
        if symbol_upper in symbol_to_id_map:
            return symbol_to_id_map[symbol_upper]
        
        # Try to search via API
        try:
            url = f"{self.base_url}/search"
            params = {'query': symbol}
            headers = self._get_headers()
            
            response = requests.get(url, params=params, headers=headers, timeout=10)
            if response.status_code == 200:
                data = response.json()
                coins = data.get('coins', [])
                if coins:
                    # Return the first match (usually most relevant)
                    return coins[0].get('id')
        except Exception as e:
            self.logger.warning(f"Error searching for coin ID: {str(e)}")
        
        # Fallback: try lowercase symbol as ID (works for some coins)
        return symbol.lower()
    
    def fetch_coin_details(
        self,
        symbol: str,
        include_developer_data: bool = True
    ) -> Dict[str, Any]:
        """
        Fetch detailed coin information including developer activity.
        
        Args:
            symbol: Cryptocurrency symbol (e.g., 'BTC', 'ETH')
            include_developer_data: Whether to include developer metrics (default: True)
        
        Returns:
            Dictionary with coin data including:
            - 'id': CoinGecko coin ID
            - 'symbol': Symbol
            - 'name': Full name
            - 'developer_data': Dict with GitHub metrics (if available)
            - 'market_data': Dict with supply, price, etc.
        """
        if not symbol:
            self.logger.error("Symbol is required")
            return {}
        
        coin_id = self._symbol_to_coin_id(symbol)
        if not coin_id:
            self.logger.error(f"Could not find coin ID for symbol: {symbol}")
            return {}
        
        try:
            # Build URL with parameters
            url = f"{self.base_url}/coins/{coin_id}"
            params = {
                'localization': 'false',
                'tickers': 'false',
                'market_data': 'true',
                'community_data': 'true',
                'developer_data': 'true' if include_developer_data else 'false',
                'sparkline': 'false'
            }
            
            headers = self._get_headers()
            
            self.logger.info(f"Fetching coin details for {symbol} (ID: {coin_id}) from CoinGecko...")
            response = requests.get(url, params=params, headers=headers, timeout=30)
            response.raise_for_status()
            
            data = response.json()
            
            # Extract relevant data
            result = {
                'id': data.get('id'),
                'symbol': data.get('symbol', '').upper(),
                'name': data.get('name', ''),
                'developer_data': data.get('developer_data', {}),
                'market_data': data.get('market_data', {}),
                'community_data': data.get('community_data', {})
            }
            
            self.logger.info(f"Fetched coin details for {symbol}")
            return result
            
        except requests.exceptions.RequestException as e:
            self.logger.error(f"Error fetching coin details from CoinGecko: {str(e)}")
            if hasattr(e, 'response') and e.response is not None:
                self.logger.error(f"Response status: {e.response.status_code}")
                self.logger.error(f"Response body: {e.response.text[:500]}")
            return {}
        except Exception as e:
            self.logger.error(f"Unexpected error fetching coin details: {str(e)}", exc_info=True)
            return {}
    
    def get_developer_activity_score(
        self,
        symbol: str
    ) -> Dict[str, Any]:
        """
        Get developer activity metrics for a cryptocurrency.
        
        Args:
            symbol: Cryptocurrency symbol (e.g., 'BTC', 'ETH')
        
        Returns:
            Dictionary with developer activity metrics:
            - 'code_additions_deletions_4_weeks': Dict with additions/deletions
            - 'forks': int - GitHub forks
            - 'stars': int - GitHub stars
            - 'subscribers': int - GitHub watchers
            - 'total_issues': int - Total GitHub issues
            - 'closed_issues': int - Closed GitHub issues
            - 'pull_requests_merged': int - Merged PRs
            - 'pull_requests_open': int - Open PRs
            - 'activity_score': float - Calculated activity score (0-100)
        """
        coin_data = self.fetch_coin_details(symbol, include_developer_data=True)
        
        if not coin_data or not coin_data.get('developer_data'):
            self.logger.warning(f"No developer data available for {symbol}")
            return {
                'code_additions_deletions_4_weeks': {},
                'forks': 0,
                'stars': 0,
                'subscribers': 0,
                'total_issues': 0,
                'closed_issues': 0,
                'pull_requests_merged': 0,
                'pull_requests_open': 0,
                'activity_score': 0.0
            }
        
        dev_data = coin_data['developer_data']
        
        # Extract metrics
        code_changes = dev_data.get('code_additions_deletions_4_weeks', {})
        additions = code_changes.get('additions') if isinstance(code_changes, dict) else None
        deletions = code_changes.get('deletions') if isinstance(code_changes, dict) else None
        # Handle None values (CoinGecko may return None instead of 0)
        additions = additions if additions is not None else 0
        deletions = deletions if deletions is not None else 0
        net_changes = additions - deletions
        
        forks = dev_data.get('forks', 0)
        stars = dev_data.get('stars', 0)
        subscribers = dev_data.get('subscribers', 0)
        total_issues = dev_data.get('total_issues', 0)
        closed_issues = dev_data.get('closed_issues', 0)
        pr_merged = dev_data.get('pull_requests_merged', 0)
        pr_open = dev_data.get('pull_requests_open', 0)
        
        # Calculate activity score (0-100 scale)
        # Weighted combination of different metrics
        activity_score = 0.0
        
        # Code changes (40% weight) - normalize to 0-100
        # Typical active project: 500-2000 changes/month
        if net_changes > 0:
            code_score = min(100, (net_changes / 2000) * 100)
            activity_score += code_score * 0.4
        
        # GitHub engagement (30% weight)
        # Stars + forks + subscribers
        engagement = stars + (forks * 10) + (subscribers * 5)
        engagement_score = min(100, (engagement / 50000) * 100)  # Normalize
        activity_score += engagement_score * 0.3
        
        # Issue resolution (20% weight)
        if total_issues > 0:
            resolution_rate = (closed_issues / total_issues) * 100
            activity_score += resolution_rate * 0.2
        elif pr_merged > 0:
            # If no issues but has PRs, use PR merge rate
            activity_score += min(100, (pr_merged / 100) * 100) * 0.2
        
        # PR activity (10% weight)
        pr_activity = pr_merged + (pr_open * 0.5)
        pr_score = min(100, (pr_activity / 50) * 100)
        activity_score += pr_score * 0.1
        
        return {
            'code_additions_deletions_4_weeks': {
                'additions': additions,
                'deletions': deletions,
                'net': net_changes
            },
            'forks': forks,
            'stars': stars,
            'subscribers': subscribers,
            'total_issues': total_issues,
            'closed_issues': closed_issues,
            'pull_requests_merged': pr_merged,
            'pull_requests_open': pr_open,
            'activity_score': min(100, max(0, activity_score))  # Clamp to 0-100
        }
    
    def get_tokenomics_score(
        self,
        symbol: str
    ) -> Dict[str, Any]:
        """
        Get tokenomics score for a cryptocurrency.
        
        Calculates dilution risk and supply health from CoinGecko market data.
        
        Args:
            symbol: Cryptocurrency symbol (e.g., 'BTC', 'ETH')
        
        Returns:
            Dictionary with tokenomics metrics:
            - 'circulating_supply': float
            - 'total_supply': float or None
            - 'max_supply': float or None
            - 'dilution_risk': float (0-100, lower is better)
            - 'fdv_mc_ratio': float (FDV / Market Cap ratio)
            - 'tokenomics_score': float (0-100, higher is better)
        """
        coin_data = self.fetch_coin_details(symbol, include_developer_data=False)
        
        if not coin_data or not coin_data.get('market_data'):
            self.logger.warning(f"No market data available for {symbol}")
            return {
                'circulating_supply': 0,
                'total_supply': None,
                'max_supply': None,
                'dilution_risk': 100.0,
                'fdv_mc_ratio': None,
                'tokenomics_score': 0.0
            }
        
        market_data = coin_data['market_data']
        
        # Extract supply data
        circulating = market_data.get('circulating_supply', 0) or 0
        total = market_data.get('total_supply', None)
        max_supply = market_data.get('max_supply', None)
        
        # Extract market cap and FDV
        market_cap = market_data.get('market_cap', {}).get('usd', 0) if isinstance(market_data.get('market_cap'), dict) else 0
        fdv = market_data.get('fully_diluted_valuation', {}).get('usd', 0) if isinstance(market_data.get('fully_diluted_valuation'), dict) else 0
        
        # Calculate dilution risk (0-100, lower is better)
        dilution_risk = 0.0
        
        if max_supply and max_supply > 0 and circulating > 0:
            # Dilution = (max - circulating) / max
            dilution_percentage = ((max_supply - circulating) / max_supply) * 100
            dilution_risk = min(100, max(0, dilution_percentage))
        elif total and total > 0 and circulating > 0:
            # Use total supply if max not available
            dilution_percentage = ((total - circulating) / total) * 100
            dilution_risk = min(100, max(0, dilution_percentage))
        else:
            # No supply data = high risk (unknown dilution)
            dilution_risk = 50.0
        
        # Calculate FDV/MC ratio (higher = more dilution risk)
        fdv_mc_ratio = None
        if market_cap > 0 and fdv > 0:
            fdv_mc_ratio = fdv / market_cap
        
        # Calculate tokenomics score (0-100, higher is better)
        # Lower dilution risk = higher score
        # Lower FDV/MC ratio = higher score
        tokenomics_score = 0.0
        
        # Dilution component (60% weight)
        # 0% dilution = 100 points, 100% dilution = 0 points
        dilution_score = 100 - dilution_risk
        tokenomics_score += dilution_score * 0.6
        
        # FDV/MC ratio component (40% weight)
        if fdv_mc_ratio is not None:
            # Ratio of 1.0 = perfect (no dilution), higher = worse
            # Normalize: 1.0 = 100, 3.0 = 0, 5.0+ = 0
            if fdv_mc_ratio <= 1.0:
                fdv_score = 100
            elif fdv_mc_ratio <= 3.0:
                # Linear interpolation: 1.0 -> 100, 3.0 -> 0
                fdv_score = 100 - ((fdv_mc_ratio - 1.0) / 2.0) * 100
            else:
                fdv_score = 0
            tokenomics_score += fdv_score * 0.4
        else:
            # If no FDV data, give neutral score for this component
            tokenomics_score += 50 * 0.4
        
        return {
            'circulating_supply': float(circulating) if circulating else 0,
            'total_supply': float(total) if total else None,
            'max_supply': float(max_supply) if max_supply else None,
            'dilution_risk': float(dilution_risk),
            'fdv_mc_ratio': float(fdv_mc_ratio) if fdv_mc_ratio else None,
            'tokenomics_score': min(100, max(0, tokenomics_score))
        }

