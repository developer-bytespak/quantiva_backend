"""
Options Engine
Maps AI trading signals (BUY/SELL, confidence, timeframe) to specific options
recommendations (strike, expiry, call/put, quantity).

Input:  Signal output + options chain data
Output: OptionsRecommendation with strike, expiry, type, quantity, risk metrics
"""
from typing import Dict, Any, Optional, List
import logging
import numpy as np
from datetime import datetime, timedelta

from .base_engine import BaseEngine

logger = logging.getLogger(__name__)


class OptionsEngine(BaseEngine):
    """
    Options recommendation engine.
    Takes an existing BUY/SELL signal and maps it to a specific options contract.
    """

    def __init__(self):
        super().__init__("OptionsEngine")

        # Risk limits per risk level (% of portfolio per trade)
        self.risk_per_trade = {
            'low': 0.01,     # 1%
            'medium': 0.02,  # 2%
            'high': 0.05,    # 5%
        }

        # Timeframe to target DTE (days to expiry) mapping
        self.timeframe_to_dte = {
            '1m': (0, 2),      # 0-2 days
            '5m': (0, 3),      # 0-3 days
            '15m': (1, 5),     # 1-5 days
            '1h': (3, 10),     # 3-10 days
            '4h': (7, 21),     # 1-3 weeks
            '1d': (14, 45),    # 2-6 weeks
            '1w': (30, 90),    # 1-3 months
        }

        # Liquidity filters
        self.min_open_interest = 50
        self.max_bid_ask_spread_pct = 0.10  # 10%
        self.min_volume = 5

    def calculate(
        self,
        asset_id: str,
        asset_type: str,
        timeframe: Optional[str] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Main entry point. Generate an options recommendation from a signal.
        
        Required kwargs:
            signal: dict with action, final_score, confidence, risk_level, timeframe
            options_chain: dict with underlying, underlying_price, contracts[]
            portfolio_value: float (optional)
        """
        signal = kwargs.get('signal', {})
        options_chain = kwargs.get('options_chain', {})
        portfolio_value = kwargs.get('portfolio_value')

        if not signal or not options_chain:
            return self._neutral_result("Missing signal or options chain data")

        action = signal.get('action', 'HOLD')
        if action == 'HOLD':
            return self._neutral_result("Signal action is HOLD — no options recommendation")

        underlying_price = options_chain.get('underlying_price', 0)
        contracts = options_chain.get('contracts', [])

        if not contracts or underlying_price <= 0:
            return self._neutral_result("No contracts or missing underlying price")

        try:
            recommendation = self._generate_recommendation(
                signal=signal,
                underlying_price=underlying_price,
                contracts=contracts,
                portfolio_value=portfolio_value,
            )
            return {
                'score': signal.get('final_score', 0),
                'confidence': signal.get('confidence', 0),
                'metadata': {},
                'recommendation': recommendation,
            }
        except Exception as e:
            self.logger.error(f"Options recommendation failed: {e}")
            return self._neutral_result(f"Recommendation generation failed: {str(e)}")

    def _generate_recommendation(
        self,
        signal: Dict[str, Any],
        underlying_price: float,
        contracts: List[Dict],
        portfolio_value: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Core recommendation logic."""
        action = signal.get('action', 'BUY')
        confidence = signal.get('confidence', 0.5)
        risk_level = signal.get('risk_level', 'medium')
        timeframe = signal.get('timeframe', '1d')
        final_score = signal.get('final_score', 0)

        # 1. Determine option type
        option_type = self._map_signal_to_option_type(action)

        # 2. Filter contracts by type
        typed_contracts = [
            c for c in contracts
            if c.get('type', '').upper() == option_type
        ]

        if not typed_contracts:
            raise ValueError(f"No {option_type} contracts available")

        # 3. Select target expiry range
        target_dte_min, target_dte_max = self._get_target_dte(timeframe)

        # 4. Filter by expiry
        expiry_filtered = self._filter_by_expiry(
            typed_contracts, target_dte_min, target_dte_max
        )

        # Fallback: if no contracts in range, use nearest available
        if not expiry_filtered:
            expiry_filtered = self._get_nearest_expiry_contracts(typed_contracts)

        if not expiry_filtered:
            raise ValueError("No contracts match expiry criteria")

        # 5. Filter by liquidity
        liquid_contracts = self._filter_by_liquidity(expiry_filtered)

        # Use all if none pass liquidity filter (with warning)
        liquidity_ok = len(liquid_contracts) > 0
        working_contracts = liquid_contracts if liquid_contracts else expiry_filtered

        # 6. Select strike based on confidence
        selected = self._select_strike(
            working_contracts, underlying_price, confidence, option_type
        )

        if not selected:
            raise ValueError("Could not select a suitable strike")

        # 7. Calculate IV metrics
        iv_value = self._extract_iv(selected)
        iv_rank = self._estimate_iv_rank(iv_value, working_contracts)

        # 8. Calculate quantity and max loss
        estimated_premium = self._estimate_premium(selected)
        quantity, max_loss = self._calculate_position_size(
            estimated_premium=estimated_premium,
            confidence=confidence,
            risk_level=risk_level,
            portfolio_value=portfolio_value,
            contract_size=selected.get('contract_size', 1),
        )

        # 9. Greeks snapshot
        greeks = selected.get('greeks', {})

        # 10. Confidence adjustment based on options-specific factors
        confidence_adjustment = self._calculate_confidence_adjustment(
            iv_rank=iv_rank,
            liquidity_ok=liquidity_ok,
            dte=self._get_dte(selected.get('expiry', '')),
            bid_ask_spread=self._get_spread(selected),
        )

        # 11. Build reasoning text
        reasoning = self._build_reasoning(
            action=action,
            option_type=option_type,
            strike=selected.get('strike', 0),
            expiry=selected.get('expiry', ''),
            confidence=confidence,
            iv_rank=iv_rank,
            liquidity_ok=liquidity_ok,
            underlying_price=underlying_price,
        )

        return {
            'option_type': option_type,
            'strike': selected.get('strike', 0),
            'expiry': selected.get('expiry', ''),
            'symbol': selected.get('symbol', ''),
            'estimated_premium': estimated_premium,
            'quantity': quantity,
            'max_loss': max_loss,
            'iv_rank': round(iv_rank, 4),
            'iv_value': round(iv_value, 6) if iv_value else None,
            'greeks': {
                'delta': greeks.get('delta', 0),
                'gamma': greeks.get('gamma', 0),
                'theta': greeks.get('theta', 0),
                'vega': greeks.get('vega', 0),
                'impliedVolatility': greeks.get('impliedVolatility'),
            },
            'liquidity_ok': liquidity_ok,
            'reasoning': reasoning,
            'confidence_adjustment': round(confidence_adjustment, 4),
        }

    # ── Signal → Option Type ────────────────────────────────

    def _map_signal_to_option_type(self, action: str) -> str:
        """BUY signal → CALL, SELL signal → PUT."""
        if action.upper() == 'BUY':
            return 'CALL'
        elif action.upper() == 'SELL':
            return 'PUT'
        else:
            return 'CALL'  # default

    # ── Expiry Selection ────────────────────────────────────

    def _get_target_dte(self, timeframe: str) -> tuple:
        """Get target days-to-expiry range from signal timeframe."""
        return self.timeframe_to_dte.get(timeframe, (14, 45))

    def _filter_by_expiry(
        self,
        contracts: List[Dict],
        min_dte: int,
        max_dte: int,
    ) -> List[Dict]:
        """Filter contracts within the target DTE range."""
        now = datetime.utcnow()
        result = []
        for c in contracts:
            dte = self._get_dte(c.get('expiry', ''))
            if min_dte <= dte <= max_dte:
                result.append(c)
        return result

    def _get_nearest_expiry_contracts(self, contracts: List[Dict]) -> List[Dict]:
        """Get contracts with the nearest expiry date that hasn't passed."""
        now = datetime.utcnow()
        future_contracts = [
            c for c in contracts if self._get_dte(c.get('expiry', '')) > 0
        ]
        if not future_contracts:
            return []

        # Group by expiry, pick the nearest
        by_expiry: Dict[str, List[Dict]] = {}
        for c in future_contracts:
            exp = c.get('expiry', '')[:10]  # date part
            by_expiry.setdefault(exp, []).append(c)

        nearest_date = min(by_expiry.keys())
        return by_expiry[nearest_date]

    def _get_dte(self, expiry_str: str) -> int:
        """Calculate days to expiry from ISO date string."""
        if not expiry_str:
            return 0
        try:
            exp_date = datetime.fromisoformat(expiry_str.replace('Z', '+00:00'))
            return max(0, (exp_date - datetime.utcnow()).days)
        except:
            return 0

    # ── Liquidity Filters ───────────────────────────────────

    def _filter_by_liquidity(self, contracts: List[Dict]) -> List[Dict]:
        """Filter contracts by bid-ask spread, open interest, and volume."""
        result = []
        for c in contracts:
            bid = c.get('bid_price', 0) or 0
            ask = c.get('ask_price', 0) or 0
            mid = (bid + ask) / 2 if (bid + ask) > 0 else 0
            spread_pct = (ask - bid) / mid if mid > 0 else 1.0

            oi = c.get('open_interest', 0) or 0
            vol = c.get('volume', 0) or 0

            if (
                spread_pct <= self.max_bid_ask_spread_pct
                and oi >= self.min_open_interest
                and vol >= self.min_volume
            ):
                result.append(c)

        return result

    def _get_spread(self, contract: Dict) -> float:
        """Calculate bid-ask spread percentage."""
        bid = contract.get('bid_price', 0) or 0
        ask = contract.get('ask_price', 0) or 0
        mid = (bid + ask) / 2
        return (ask - bid) / mid if mid > 0 else 1.0

    # ── Strike Selection ────────────────────────────────────

    def _select_strike(
        self,
        contracts: List[Dict],
        underlying_price: float,
        confidence: float,
        option_type: str,
    ) -> Optional[Dict]:
        """
        Select strike based on confidence level:
        - High confidence (>0.7):  ATM or slightly ITM (maximum delta)
        - Medium (0.4-0.7):       Slightly OTM (1-2 strikes out)
        - Low (<0.4):             Far OTM (cheaper premium, higher leverage)
        """
        if not contracts:
            return None

        # Sort by strike
        sorted_contracts = sorted(contracts, key=lambda c: c.get('strike', 0))

        # Find ATM index (strike closest to underlying price)
        atm_idx = 0
        min_diff = float('inf')
        for i, c in enumerate(sorted_contracts):
            diff = abs(c.get('strike', 0) - underlying_price)
            if diff < min_diff:
                min_diff = diff
                atm_idx = i

        # Determine target offset from ATM based on confidence
        if confidence >= 0.7:
            # High confidence → ATM or 1 strike ITM
            if option_type == 'CALL':
                target_idx = max(0, atm_idx - 1)  # slightly lower strike = ITM for call
            else:
                target_idx = min(len(sorted_contracts) - 1, atm_idx + 1)  # higher strike = ITM for put
        elif confidence >= 0.4:
            # Medium → 1-2 strikes OTM
            offset = 1
            if option_type == 'CALL':
                target_idx = min(len(sorted_contracts) - 1, atm_idx + offset)
            else:
                target_idx = max(0, atm_idx - offset)
        else:
            # Low confidence → 3-4 strikes OTM (cheap)
            offset = 3
            if option_type == 'CALL':
                target_idx = min(len(sorted_contracts) - 1, atm_idx + offset)
            else:
                target_idx = max(0, atm_idx - offset)

        return sorted_contracts[target_idx]

    # ── IV Analysis ─────────────────────────────────────────

    def _extract_iv(self, contract: Dict) -> float:
        """Extract implied volatility from contract."""
        greeks = contract.get('greeks', {})
        iv = greeks.get('impliedVolatility') or greeks.get('implied_volatility')
        return float(iv) if iv else 0.0

    def _estimate_iv_rank(self, iv_value: float, contracts: List[Dict]) -> float:
        """
        Estimate IV rank as percentile within current chain.
        (Proper IV rank requires historical IV data; this is an approximation.)
        """
        if not iv_value or not contracts:
            return 0.5  # default to 50th percentile

        all_ivs = []
        for c in contracts:
            iv = self._extract_iv(c)
            if iv > 0:
                all_ivs.append(iv)

        if not all_ivs:
            return 0.5

        all_ivs.sort()
        rank = sum(1 for x in all_ivs if x <= iv_value) / len(all_ivs)
        return rank

    # ── Premium & Position Sizing ───────────────────────────

    def _estimate_premium(self, contract: Dict) -> float:
        """Estimate premium as mid price or mark price."""
        bid = contract.get('bid_price', 0) or 0
        ask = contract.get('ask_price', 0) or 0
        mark = contract.get('mark_price', 0) or 0

        if bid > 0 and ask > 0:
            return (bid + ask) / 2
        elif mark > 0:
            return mark
        return contract.get('last_price', 0) or 0

    def _calculate_position_size(
        self,
        estimated_premium: float,
        confidence: float,
        risk_level: str,
        portfolio_value: Optional[float] = None,
        contract_size: float = 1.0,
    ) -> tuple:
        """
        Calculate quantity and max loss.
        Max risk per trade = risk_per_trade[risk_level] × portfolio_value × confidence
        Quantity = max_risk / (premium × contract_size)
        Max loss for buyer = premium × quantity × contract_size
        """
        if not portfolio_value or portfolio_value <= 0:
            # Default: 1 contract
            max_loss = estimated_premium * 1 * contract_size
            return (1, round(max_loss, 8))

        risk_pct = self.risk_per_trade.get(risk_level, 0.02)
        max_risk = portfolio_value * risk_pct * confidence

        if estimated_premium <= 0 or contract_size <= 0:
            return (1, max_risk)

        cost_per_contract = estimated_premium * contract_size
        quantity = max(1, int(max_risk / cost_per_contract))

        # Cap at 10 contracts max per trade
        quantity = min(quantity, 10)
        max_loss = cost_per_contract * quantity

        return (quantity, round(max_loss, 8))

    # ── Confidence Adjustment ───────────────────────────────

    def _calculate_confidence_adjustment(
        self,
        iv_rank: float,
        liquidity_ok: bool,
        dte: int,
        bid_ask_spread: float,
    ) -> float:
        """
        Calculate confidence adjustment based on options-specific factors.
        Returns a value in [-0.3, +0.1] to adjust base signal confidence.
        """
        adj = 0.0

        # High IV → reduce confidence for buying (overpaying premium)
        if iv_rank > 0.8:
            adj -= 0.15
        elif iv_rank > 0.6:
            adj -= 0.05

        # Poor liquidity → reduce confidence
        if not liquidity_ok:
            adj -= 0.10

        # Very short DTE → reduce confidence (gamma risk)
        if dte <= 1:
            adj -= 0.10
        elif dte <= 3:
            adj -= 0.05

        # Wide spread → reduce confidence
        if bid_ask_spread > 0.05:
            adj -= 0.05

        return max(-0.3, min(0.1, adj))

    # ── Reasoning Text ──────────────────────────────────────

    def _build_reasoning(
        self,
        action: str,
        option_type: str,
        strike: float,
        expiry: str,
        confidence: float,
        iv_rank: float,
        liquidity_ok: bool,
        underlying_price: float,
    ) -> str:
        """Build human-readable reasoning for the recommendation."""
        parts = []

        # Direction
        parts.append(
            f"AI signal is {action} with {confidence:.0%} confidence."
        )

        # Option type mapping
        parts.append(
            f"Recommending {option_type} option (strike ${strike:,.0f}, "
            f"underlying at ${underlying_price:,.0f})."
        )

        # Expiry
        dte = self._get_dte(expiry)
        parts.append(f"Expiry: {expiry[:10]} ({dte} days).")

        # Strike selection reasoning
        moneyness = (strike - underlying_price) / underlying_price * 100
        if abs(moneyness) < 2:
            parts.append("Strike is near ATM — balanced risk/reward.")
        elif (option_type == 'CALL' and moneyness > 0) or (
            option_type == 'PUT' and moneyness < 0
        ):
            parts.append(
                f"Strike is {abs(moneyness):.1f}% OTM — lower premium, higher leverage."
            )
        else:
            parts.append(
                f"Strike is {abs(moneyness):.1f}% ITM — higher probability of profit."
            )

        # IV warning
        if iv_rank > 0.7:
            parts.append(
                f"⚠ IV rank is high ({iv_rank:.0%}) — premiums may be expensive."
            )
        elif iv_rank < 0.3:
            parts.append(
                f"IV rank is low ({iv_rank:.0%}) — premiums are relatively cheap."
            )

        # Liquidity warning
        if not liquidity_ok:
            parts.append(
                "⚠ Low liquidity detected — wider spreads may increase slippage."
            )

        return " ".join(parts)

    # ── Neutral result ──────────────────────────────────────

    def _neutral_result(self, reason: str) -> Dict[str, Any]:
        """Return a neutral result when no recommendation can be made."""
        return {
            'score': 0,
            'confidence': 0,
            'metadata': {'reason': reason},
            'recommendation': None,
        }
