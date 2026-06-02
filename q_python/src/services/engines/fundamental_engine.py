"""
Fundamental Engine
Analyzes fundamental metrics for stocks and crypto assets.
"""
from typing import Dict, Any, Optional, List
import logging

from .base_engine import BaseEngine
from src.services.data.lunarcrush_service import get_lunarcrush_service
from src.services.data.coingecko_service import get_coingecko_service
from src.services.data.stock_news_service import get_stock_news_service
from src.services.data.finnhub_service import FinnhubService
from src.models.finbert import get_finbert_inference

logger = logging.getLogger(__name__)


class FundamentalEngine(BaseEngine):
    """
    Fundamental analysis engine.
    
    For Stocks:
    - Analyzes earnings, revenue, and financial performance news using FinBERT
    
    For Crypto:
    - Analyzes Galaxy Score, developer activity, and social metrics
    - Combines LunarCrush and CoinGecko data
    """
    
    def __init__(self):
        super().__init__("FundamentalEngine")
        self.lunarcrush_service = get_lunarcrush_service()
        self.coingecko_service = get_coingecko_service()
        self.stock_news_service = get_stock_news_service()
        self.finnhub_service = FinnhubService()
        self.finbert_inference = None  # Lazy initialization
    
    def calculate(
        self,
        asset_id: str,
        asset_type: str,
        timeframe: Optional[str] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Calculate fundamental score.
        
        Args:
            asset_id: Asset identifier
            asset_type: 'crypto' or 'stock'
            timeframe: Optional timeframe
            **kwargs: Additional parameters
        
        Returns:
            Dictionary with score, confidence, and metadata
        """
        try:
            if not self.validate_inputs(asset_id, asset_type):
                return self.handle_error(ValueError("Invalid inputs"), "validation")
            
            if asset_type == 'crypto':
                return self._calculate_crypto_fundamental(asset_id, **kwargs)
            elif asset_type == 'stock':
                return self._calculate_stock_fundamental(asset_id, **kwargs)
            else:
                return self.handle_error(ValueError(f"Unsupported asset_type: {asset_type}"), "validation")
                
        except Exception as e:
            return self.handle_error(e, f"calculation for {asset_id}")
    
    def _calculate_crypto_fundamental(
        self,
        asset_id: str,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Calculate fundamental score for crypto assets.
        
        Combines data from LunarCrush (Galaxy Score, Alt Rank) and CoinGecko (Developer Activity).
        
        Formula:
        fundamental_score = 0.50 * galaxy_score + 0.30 * dev_activity + 0.20 * alt_rank
        
        Args:
            asset_id: Crypto asset identifier (UUID or symbol)
            **kwargs: Additional parameters (asset_symbol for external API calls)
        
        Returns:
            Dictionary with score, confidence, and metadata
        """
        try:
            # Use asset_symbol if provided (for external API calls), otherwise use asset_id
            asset_symbol = kwargs.get('asset_symbol', asset_id)
            
            # Fetch data from LunarCrush (needs symbol, not UUID)
            lunarcrush_metrics = self.lunarcrush_service.fetch_social_metrics(asset_symbol)
            
            # Fetch developer activity from CoinGecko (needs symbol, not UUID)
            try:
                dev_activity_data = self.coingecko_service.get_developer_activity_score(asset_symbol)
            except Exception as e:
                self.logger.warning(f"Error fetching developer activity for {asset_symbol}: {str(e)}")
                dev_activity_data = {'activity_score': 0}
            
            # Fetch tokenomics data from CoinGecko (needs symbol, not UUID)
            try:
                tokenomics_data = self.coingecko_service.get_tokenomics_score(asset_symbol)
            except Exception as e:
                self.logger.warning(f"Error fetching tokenomics for {asset_symbol}: {str(e)}")
                tokenomics_data = {'tokenomics_score': 0}
            
            # Extract metrics
            galaxy_score = lunarcrush_metrics.get('galaxy_score', 0)  # 0-100 scale
            alt_rank = lunarcrush_metrics.get('alt_rank', 999999)  # Lower is better
            social_volume = lunarcrush_metrics.get('social_volume', 0)
            
            # Developer activity score from CoinGecko (0-100 scale)
            dev_activity = dev_activity_data.get('activity_score', 0)
            
            # Tokenomics score from CoinGecko (0-100 scale)
            tokenomics_score = tokenomics_data.get('tokenomics_score', 0)
            
            # Check if we have sufficient data
            has_lunarcrush = galaxy_score > 0 or alt_rank < 999999
            has_coingecko = dev_activity > 0
            has_tokenomics = tokenomics_score > 0
            
            if not has_lunarcrush and not has_coingecko and not has_tokenomics:
                self.logger.warning(f"No data available for {asset_id}")
                return self.create_result(
                    0.0,
                    0.0,
                    {
                        'note': 'No data available from APIs',
                        'asset_id': asset_id
                    }
                )
            
            # Normalize metrics to -1 to +1
            galaxy_score_norm = self.normalize_score(galaxy_score, input_min=0, input_max=100) if has_lunarcrush else 0.0
            dev_activity_norm = self.normalize_score(dev_activity, input_min=0, input_max=100) if has_coingecko else 0.0
            tokenomics_norm = self.normalize_score(tokenomics_score, input_min=0, input_max=100) if has_tokenomics else 0.0
            
            # Alt rank: lower is better, so invert
            # Normalize assuming rank 1-1000 range (rank 1 = best, rank 1000 = worst)
            if has_lunarcrush and alt_rank < 999999:
                alt_rank_norm = self.normalize_score(1000 - alt_rank, input_min=0, input_max=999)
            else:
                alt_rank_norm = 0.0
            
            # Calculate weighted fundamental score
            # Original weights: 0.50 (galaxy) + 0.30 (dev) + 0.20 (alt_rank) = 1.0
            # Add tokenomics with 0.10 weight, adjust others proportionally
            # New weights: 0.45 (galaxy) + 0.27 (dev) + 0.18 (alt_rank) + 0.10 (tokenomics) = 1.0
            total_weight = 0.0
            weighted_score = 0.0
            
            if has_lunarcrush:
                weighted_score += 0.45 * galaxy_score_norm
                total_weight += 0.45
            
            if has_coingecko:
                weighted_score += 0.27 * dev_activity_norm
                total_weight += 0.27
            
            if has_lunarcrush and alt_rank_norm > 0:
                weighted_score += 0.18 * alt_rank_norm
                total_weight += 0.18
            
            if has_tokenomics:
                weighted_score += 0.10 * tokenomics_norm
                total_weight += 0.10
            
            # Normalize by actual weight used
            if total_weight > 0:
                fundamental_score = weighted_score / total_weight
            else:
                fundamental_score = 0.0
            
            # Calculate confidence based on data availability
            data_sources_count = sum([has_lunarcrush, has_coingecko, has_tokenomics])
            if data_sources_count >= 3:
                confidence = 0.85
            elif data_sources_count == 2:
                confidence = 0.75
            else:
                confidence = 0.6
            
            metadata = {
                'galaxy_score': galaxy_score,
                'developer_activity': dev_activity,
                'tokenomics_score': tokenomics_score,
                'alt_rank': alt_rank,
                'social_volume': social_volume,
                'code_changes_4w': dev_activity_data.get('code_additions_deletions_4_weeks', {}).get('net', 0),
                'github_forks': dev_activity_data.get('forks', 0),
                'github_stars': dev_activity_data.get('stars', 0),
                'dilution_risk': tokenomics_data.get('dilution_risk', 0),
                'fdv_mc_ratio': tokenomics_data.get('fdv_mc_ratio'),
                'circulating_supply': tokenomics_data.get('circulating_supply', 0),
                'max_supply': tokenomics_data.get('max_supply'),
                'score_breakdown': {
                    'galaxy_score_norm': galaxy_score_norm,
                    'dev_activity_norm': dev_activity_norm,
                    'alt_rank_norm': alt_rank_norm,
                    'tokenomics_norm': tokenomics_norm,
                },
                'sources': []
            }
            
            if has_lunarcrush:
                metadata['sources'].append('lunarcrush')
            if has_coingecko:
                metadata['sources'].append('coingecko')
            if has_tokenomics:
                metadata['sources'].append('coingecko_tokenomics')
            
            return self.create_result(fundamental_score, confidence, metadata)
            
        except Exception as e:
            self.logger.error(f"Error calculating crypto fundamental score: {str(e)}", exc_info=True)
            return self.create_result(
                0.0,
                0.0,
                {
                    'error': True,
                    'error_message': str(e),
                    'asset_id': asset_id
                }
            )
    
    def _calculate_stock_fundamental(
        self,
        asset_id: str,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Compute a fundamental score for a stock from Finnhub's `/stock/metric`
        endpoint (P/E, ROE, debt/equity, P/B, dividend yield).

        Why this is a complete rewrite:
            The original path filtered StockNewsAPI for articles containing
            "earnings"/"revenue"/"performance" keywords, ran FinBERT on those,
            and returned 0 when no match. For most stocks on most days, NO
            news matches those keywords (real earnings news is quarterly),
            so the engine effectively reported `0` for every stock, every day
            — turning every user strategy that required `fundamental > 0.4`
            into a structurally unreachable rule.

            News-based "fundamental" was the wrong abstraction. Real
            fundamentals are the financials. We pay for a Finnhub key that
            already exposes them; the new path just calls it.

        Composite (each component clamped to [-1, 1] before weighting):
            * value (35%)   — P/E + P/B + dividend yield
            * quality (40%) — ROE
            * leverage(25%) — debt/equity

        Confidence scales with how many metrics Finnhub returned.

        Returns null (handle_no_data) when Finnhub has no metrics — fusion
        will redistribute weight to engines that do.
        """
        # asset_id is the DB UUID in the cron path; the actual ticker lives
        # in kwargs.asset_symbol (the cron always sets it). Fall back to
        # asset_id for direct API callers that already pass the ticker.
        asset_symbol = (kwargs.get('asset_symbol') or asset_id or '').upper()
        if not asset_symbol:
            return self.handle_no_data("Missing asset_symbol", context=f"asset_id={asset_id}")

        # Surface the precise failure mode so the next probe can tell us
        # whether it's "no API key on Render", "request raised", or "request
        # OK but data empty". Without this the original message ("no
        # fundamentals for this symbol") collapsed three different bugs into
        # one indistinguishable null result.
        if not self.finnhub_service.api_key:
            return self.handle_no_data(
                "FINNHUB_API_KEY not configured on this Python service",
                context=f"symbol={asset_symbol} | check Render env vars",
            )

        try:
            batch = self.finnhub_service.fetch_company_fundamentals_batch([asset_symbol])
        except Exception as e:
            return self.handle_error(e, f"finnhub fundamentals fetch for {asset_symbol}")

        if not isinstance(batch, dict):
            return self.handle_no_data(
                "Finnhub service returned non-dict response",
                context=f"symbol={asset_symbol} type={type(batch).__name__}",
            )

        metrics = batch.get(asset_symbol)
        if metrics is None:
            # FinnhubService swallowed an exception (network, SSL, JSON parse,
            # raise_for_status). It logs the warning internally but doesn't
            # surface it to the caller. Best we can do here without changing
            # FinnhubService is signal which key was tried.
            return self.handle_no_data(
                "Finnhub request failed inside FinnhubService (caught, see service logs)",
                context=f"symbol={asset_symbol} | likely network/SSL/timeout",
            )
        if not metrics:
            return self.handle_no_data(
                "Finnhub responded but returned empty data",
                context=f"symbol={asset_symbol}",
            )

        pe = self._as_float(metrics.get('pe_ratio'))
        pb = self._as_float(metrics.get('price_to_book'))
        roe = self._as_float(metrics.get('roe'))
        de = self._as_float(metrics.get('debt_to_equity'))
        div_yield = self._as_float(metrics.get('dividend_yield'))
        # Growth dimension inputs (Finnhub returns these as percentages).
        eps_growth_q = self._as_float(metrics.get('eps_growth_quarterly_yoy'))
        eps_growth_5y = self._as_float(metrics.get('eps_growth_5y'))
        revenue_growth = self._as_float(metrics.get('revenue_growth_ttm_yoy'))
        gross_margin = self._as_float(metrics.get('gross_margin'))

        # --- VALUE component (P/E, P/B, dividend yield) ---
        value_scores: List[float] = []
        if pe is not None:
            if pe <= 0:
                # Negative or zero earnings — company losing money.
                value_scores.append(-0.5)
            else:
                # Centered at PE 25: <10 = strongly positive, >40 = strongly negative.
                value_scores.append(self.clamp_score((25.0 - pe) / 15.0, -1.0, 1.0))
        if pb is not None and pb > 0:
            # Centered at P/B 2: <1 = positive, >5 = negative.
            value_scores.append(self.clamp_score((2.0 - pb) / 2.0, -1.0, 1.0))
        if div_yield is not None and div_yield >= 0:
            # 0% = 0, 4% = +0.4 (good income), 8%+ = +0.5 cap.
            value_scores.append(self.clamp_score(div_yield / 8.0 * 0.5, 0.0, 0.5))

        value_score = sum(value_scores) / len(value_scores) if value_scores else None

        # --- QUALITY component (ROE + gross margin). Finnhub returns these
        # as percentages (e.g. 15.5 for 15.5%), not fractions. ---
        quality_subs: List[float] = []
        if roe is not None:
            # >25% = excellent (+1), 0% = neutral, <0% = -0.8 cap.
            quality_subs.append(self.clamp_score(roe / 25.0, -0.8, 1.0))
        if gross_margin is not None:
            # >50% = software-tier margins = +1, 20% = neutral, <0% = -1.
            quality_subs.append(self.clamp_score((gross_margin - 20.0) / 30.0, -1.0, 1.0))
        quality_score = sum(quality_subs) / len(quality_subs) if quality_subs else None

        # --- GROWTH component (NEW). Reflects forward earnings power that
        # the value-only formula missed. A company growing EPS 20%+ YoY
        # earns a high P/E — the old formula penalized that as "expensive".
        # Now we credit it directly. ---
        growth_subs: List[float] = []
        if eps_growth_q is not None:
            # 20%+ YoY = +1, 0% = 0, -20%+ = -1
            growth_subs.append(self.clamp_score(eps_growth_q / 20.0, -1.0, 1.0))
        if eps_growth_5y is not None:
            # 15%+ 5y CAGR = +1, 0% = 0, -10% = -1
            growth_subs.append(self.clamp_score(eps_growth_5y / 15.0, -1.0, 1.0))
        if revenue_growth is not None:
            # 15%+ YoY = +1, 0% = 0, -15% = -1
            growth_subs.append(self.clamp_score(revenue_growth / 15.0, -1.0, 1.0))
        growth_score = sum(growth_subs) / len(growth_subs) if growth_subs else None

        # --- LEVERAGE component (debt/equity, lower is better) ---
        if de is not None:
            if de < 0:
                leverage_score = -0.5  # Negative D/E (negative equity) = warning
            else:
                # 0 = +1, 1 = +0.5, 2 = 0, 3 = -0.5, 5+ = -1.
                leverage_score = self.clamp_score((1.0 - de) / 2.0, -1.0, 1.0)
        else:
            leverage_score = None

        # Weighted average, ignoring components we don't have data for.
        # New 4-dimension breakdown:
        #   value 30%, quality 25%, growth 25%, leverage 20%
        # Growth was missing entirely in the old engine. Adding it lets fast-
        # growers (semis, biotech, software) score above their value-only
        # reading, which was systematically pessimistic about quality
        # high-multiple companies.
        weights = {'value': 0.30, 'quality': 0.25, 'growth': 0.25, 'leverage': 0.20}
        contributions: Dict[str, float] = {}
        if value_score is not None:
            contributions['value'] = value_score
        if quality_score is not None:
            contributions['quality'] = quality_score
        if growth_score is not None:
            contributions['growth'] = growth_score
        if leverage_score is not None:
            contributions['leverage'] = leverage_score

        if not contributions:
            return self.handle_no_data(
                "Finnhub returned no usable metric values",
                context=f"symbol={asset_symbol}",
            )

        total_weight = sum(weights[k] for k in contributions)
        fundamental_score = sum(weights[k] * v for k, v in contributions.items()) / total_weight
        fundamental_score = self.clamp_score(fundamental_score, -1.0, 1.0)

        # Confidence: how many of the 4 dimensions we could score.
        dimensions_covered = len(contributions)
        if dimensions_covered >= 4:
            confidence = 0.90
        elif dimensions_covered == 3:
            confidence = 0.80
        elif dimensions_covered == 2:
            confidence = 0.65
        else:
            confidence = 0.50

        metadata = {
            'source': 'finnhub_metric',
            'symbol': asset_symbol,
            'raw_metrics': {
                'pe_ratio': pe,
                'price_to_book': pb,
                'roe_pct': roe,
                'gross_margin_pct': gross_margin,
                'debt_to_equity': de,
                'dividend_yield_pct': div_yield,
                'eps_growth_quarterly_yoy_pct': eps_growth_q,
                'eps_growth_5y_pct': eps_growth_5y,
                'revenue_growth_ttm_yoy_pct': revenue_growth,
                'market_cap': metrics.get('market_cap'),
                'eps': metrics.get('eps'),
            },
            'component_scores': {
                'value': value_score,
                'quality': quality_score,
                'growth': growth_score,
                'leverage': leverage_score,
            },
            'dimensions_used': list(contributions.keys()),
        }
        return self.create_result(fundamental_score, confidence, metadata)

    @staticmethod
    def _as_float(v: Any) -> Optional[float]:
        """Coerce a Finnhub response value to float, treating ``None`` / ``"None"`` / unparseable as missing."""
        if v is None:
            return None
        if isinstance(v, str) and v.lower() in ('none', 'null', 'nan', ''):
            return None
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        # Finnhub occasionally returns NaN for missing metrics; treat as missing.
        if f != f:  # NaN check (NaN != NaN)
            return None
        return f
    
    def _ensure_finbert_initialized(self) -> bool:
        """Ensure FinBERT inference is initialized."""
        if self.finbert_inference is None:
            try:
                self.finbert_inference = get_finbert_inference()
                return True
            except Exception as e:
                self.logger.error(f"Failed to initialize FinBERT: {str(e)}")
                return False
        return True
    
    def _analyze_earnings_news(self, news_data: List[Dict[str, Any]]) -> tuple:
        """
        Analyze earnings news sentiment using FinBERT.
        
        Filters news for earnings-related keywords and analyzes sentiment.
        
        Args:
            news_data: List of news article dictionaries with 'title' and 'text'
        
        Returns:
            Tuple of (sentiment_score, article_count)
            sentiment_score: Average sentiment in range [-1, 1]
            article_count: Number of earnings-related articles analyzed
        """
        if not self._ensure_finbert_initialized():
            return (0.0, 0)
        
        # Keywords for earnings-related news
        earnings_keywords = [
            'earnings', 'eps', 'profit', 'quarterly results', 'q1', 'q2', 'q3', 'q4',
            'beats expectations', 'misses expectations', 'earnings report', 'earnings call',
            'net income', 'operating income', 'earnings per share', 'guidance',
            'earnings beat', 'earnings miss', 'earnings surprise'
        ]
        
        earnings_articles = []
        for article in news_data:
            title = article.get('title', '').lower()
            text = article.get('text', '').lower()
            combined = f"{title} {text}"
            
            # Check if article contains earnings keywords
            if any(keyword in combined for keyword in earnings_keywords):
                earnings_articles.append(article)
        
        if not earnings_articles:
            return (0.0, 0)
        
        # Analyze sentiment for each earnings article
        sentiments = []
        for article in earnings_articles:
            try:
                text = article.get('text', '') or article.get('title', '')
                if text:
                    result = self.finbert_inference.analyze_financial_text(text, source='stock_news_api')
                    score = result.get('score', 0.0)
                    sentiments.append(score)
            except Exception as e:
                self.logger.warning(f"Error analyzing earnings article: {str(e)}")
                continue
        
        if not sentiments:
            return (0.0, len(earnings_articles))
        
        # Return average sentiment
        avg_sentiment = sum(sentiments) / len(sentiments)
        return (avg_sentiment, len(earnings_articles))
    
    def _analyze_revenue_news(self, news_data: List[Dict[str, Any]]) -> tuple:
        """
        Analyze revenue news sentiment using FinBERT.
        
        Filters news for revenue-related keywords and analyzes sentiment.
        
        Args:
            news_data: List of news article dictionaries with 'title' and 'text'
        
        Returns:
            Tuple of (sentiment_score, article_count)
            sentiment_score: Average sentiment in range [-1, 1]
            article_count: Number of revenue-related articles analyzed
        """
        if not self._ensure_finbert_initialized():
            return (0.0, 0)
        
        # Keywords for revenue-related news
        revenue_keywords = [
            'revenue', 'sales', 'income', 'top line', 'revenue growth', 'sales growth',
            'revenue beat', 'revenue miss', 'revenue target', 'sales target',
            'quarterly revenue', 'annual revenue', 'revenue guidance', 'sales guidance',
            'revenue increase', 'revenue decrease', 'sales increase', 'sales decrease'
        ]
        
        revenue_articles = []
        for article in news_data:
            title = article.get('title', '').lower()
            text = article.get('text', '').lower()
            combined = f"{title} {text}"
            
            # Check if article contains revenue keywords
            if any(keyword in combined for keyword in revenue_keywords):
                revenue_articles.append(article)
        
        if not revenue_articles:
            return (0.0, 0)
        
        # Analyze sentiment for each revenue article
        sentiments = []
        for article in revenue_articles:
            try:
                text = article.get('text', '') or article.get('title', '')
                if text:
                    result = self.finbert_inference.analyze_financial_text(text, source='stock_news_api')
                    score = result.get('score', 0.0)
                    sentiments.append(score)
            except Exception as e:
                self.logger.warning(f"Error analyzing revenue article: {str(e)}")
                continue
        
        if not sentiments:
            return (0.0, len(revenue_articles))
        
        # Return average sentiment
        avg_sentiment = sum(sentiments) / len(sentiments)
        return (avg_sentiment, len(revenue_articles))
    
    def _analyze_performance_news(self, news_data: List[Dict[str, Any]]) -> tuple:
        """
        Analyze financial performance news sentiment using FinBERT.
        
        Filters news for performance-related keywords and analyzes sentiment.
        
        Args:
            news_data: List of news article dictionaries with 'title' and 'text'
        
        Returns:
            Tuple of (sentiment_score, article_count)
            sentiment_score: Average sentiment in range [-1, 1]
            article_count: Number of performance-related articles analyzed
        """
        if not self._ensure_finbert_initialized():
            return (0.0, 0)
        
        # Keywords for performance-related news
        performance_keywords = [
            'performance', 'guidance', 'outlook', 'forecast', 'targets', 'expectations',
            'financial performance', 'operational performance', 'business performance',
            'upgrade guidance', 'downgrade guidance', 'raise guidance', 'lower guidance',
            'strong performance', 'weak performance', 'improved performance', 'declining performance',
            'growth outlook', 'future outlook', 'forward guidance'
        ]
        
        performance_articles = []
        for article in news_data:
            title = article.get('title', '').lower()
            text = article.get('text', '').lower()
            combined = f"{title} {text}"
            
            # Check if article contains performance keywords
            if any(keyword in combined for keyword in performance_keywords):
                performance_articles.append(article)
        
        if not performance_articles:
            return (0.0, 0)
        
        # Analyze sentiment for each performance article
        sentiments = []
        for article in performance_articles:
            try:
                text = article.get('text', '') or article.get('title', '')
                if text:
                    result = self.finbert_inference.analyze_financial_text(text, source='stock_news_api')
                    score = result.get('score', 0.0)
                    sentiments.append(score)
            except Exception as e:
                self.logger.warning(f"Error analyzing performance article: {str(e)}")
                continue
        
        if not sentiments:
            return (0.0, len(performance_articles))
        
        # Return average sentiment
        avg_sentiment = sum(sentiments) / len(sentiments)
        return (avg_sentiment, len(performance_articles))
