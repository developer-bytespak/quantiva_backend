"""
Smoke tests for the StrategyExecutor's `skipped` flag behavior.

After the Phase-3 fix, `_evaluate_single_rule` returns `(met, evaluable)`
and `_evaluate_rules` treats an inevaluable rule as `skipped=True`
regardless of whether the rule used an `indicator` key or a `field` path.
Without this, field-based rules that reference a broken dotted path would
silently return False → signal defaults to HOLD instead of falling back
to the fusion engine's action.

Run from the q_python directory:

    .venv/Scripts/python.exe -m tests.test_strategy_executor_skips
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from src.services.strategies.strategy_executor import StrategyExecutor  # noqa: E402


def _make_fusion_result(score: float):
    return {'score': score, 'action': 'BUY' if score > 0.3 else 'HOLD'}


def _make_engine_scores(sentiment: float = 0.0):
    return {
        'sentiment':   {'score': sentiment, 'confidence': 0.8},
        'trend':       {'score': 0.0, 'confidence': 0.5},
        'fundamental': {'score': 0.0, 'confidence': 0.5},
        'event_risk':  {'score': 0.0, 'confidence': 0.5},
        'liquidity':   {'score': 0.0, 'confidence': 0.5},
    }


def test_indicator_missing_marked_skipped() -> None:
    ex = StrategyExecutor()
    rules = [{'indicator': 'RSI', 'operator': '<', 'value': 30}]
    result = ex._evaluate_rules(
        rules, indicators={'RSI': None}, market_data={}, engine_scores=None, fusion_result=None,
    )
    assert result['conditions'][0]['skipped'] is True
    assert result['conditions'][0]['met'] is False
    assert result['all_skipped'] is True
    print("  PASS: indicator-missing -> skipped=True")


def test_indicator_present_and_matching() -> None:
    ex = StrategyExecutor()
    rules = [{'indicator': 'RSI', 'operator': '<', 'value': 30}]
    result = ex._evaluate_rules(
        rules, indicators={'RSI': 25.0}, market_data={}, engine_scores=None, fusion_result=None,
    )
    assert result['conditions'][0]['skipped'] is False
    assert result['conditions'][0]['met'] is True
    assert result['all_met'] is True
    print("  PASS: indicator-present + matches -> skipped=False, met=True")


def test_field_path_present_and_matching() -> None:
    ex = StrategyExecutor()
    rules = [{'field': 'final_score', 'operator': '>', 'value': 0.2}]
    result = ex._evaluate_rules(
        rules, indicators={}, market_data={}, engine_scores=None,
        fusion_result=_make_fusion_result(0.5),
    )
    assert result['conditions'][0]['skipped'] is False
    assert result['conditions'][0]['met'] is True
    assert result['all_met'] is True
    print("  PASS: field-path present (final_score > 0.2) -> met=True")


def test_field_path_missing_marked_skipped() -> None:
    """Phase-3 regression: a field path that doesn't resolve must be
    reported as skipped=True, not silently met=False."""
    ex = StrategyExecutor()
    rules = [{
        'field': 'metadata.engine_details.nonexistent_engine.score',
        'operator': '>',
        'value': 0.1,
    }]
    result = ex._evaluate_rules(
        rules, indicators={}, market_data={},
        engine_scores=_make_engine_scores(),
        fusion_result=_make_fusion_result(0.5),
    )
    assert result['conditions'][0]['skipped'] is True, (
        f"field-path missing should be skipped, got {result['conditions'][0]}"
    )
    assert result['conditions'][0]['met'] is False
    assert result['all_skipped'] is True
    print("  PASS: field-path missing -> skipped=True, all_skipped=True")


def test_mixed_rules_partial_skip() -> None:
    ex = StrategyExecutor()
    rules = [
        {'indicator': 'RSI', 'operator': '<', 'value': 30},
        {'field': 'metadata.engine_details.nonexistent.score', 'operator': '>', 'value': 0.1},
    ]
    result = ex._evaluate_rules(
        rules, indicators={'RSI': 25.0}, market_data={},
        engine_scores=_make_engine_scores(), fusion_result=None,
    )
    assert result['conditions'][0]['skipped'] is False
    assert result['conditions'][0]['met'] is True
    assert result['conditions'][1]['skipped'] is True
    assert result['conditions'][1]['met'] is False
    assert result['all_skipped'] is False
    assert result['indicators_missing'] == 1
    print("  PASS: mixed -> partial skip tracking works")


def test_malformed_rule_is_evaluable_failed_not_skipped() -> None:
    """A rule missing both 'indicator' and 'field' is an author bug, not
    missing runtime data. It should be evaluable=True, met=False."""
    ex = StrategyExecutor()
    rules = [{'operator': '>', 'value': 0.1}]
    result = ex._evaluate_rules(
        rules, indicators={}, market_data={}, engine_scores=None, fusion_result=None,
    )
    assert result['conditions'][0]['skipped'] is False
    assert result['conditions'][0]['met'] is False
    assert result['all_skipped'] is False
    print("  PASS: malformed rule -> evaluable=True (skipped=False), met=False")


def test_execute_integration_all_field_paths_missing() -> None:
    """End-to-end via execute(): entry rules all have unresolvable field
    paths → executor flags all_skipped so signal_generator can fall back."""
    ex = StrategyExecutor()
    strategy = {
        'entry_rules': [
            {'field': 'metadata.engine_details.phantom.score', 'operator': '>', 'value': 0.1},
        ],
        'exit_rules': [],
    }
    result = ex.execute(
        strategy=strategy,
        market_data={'price': 100.0},
        indicators={},
        engine_scores=_make_engine_scores(),
        fusion_result=_make_fusion_result(0.5),
    )
    assert result['signal'] == 'HOLD'
    assert result['entry_details']['all_skipped'] is True
    assert result['exit_details'].get('no_rules') is True
    print("  PASS: integration -> all-field-paths-missing flags all_skipped for fallback")


def main() -> int:
    failures = []
    for test in [
        test_indicator_missing_marked_skipped,
        test_indicator_present_and_matching,
        test_field_path_present_and_matching,
        test_field_path_missing_marked_skipped,
        test_mixed_rules_partial_skip,
        test_malformed_rule_is_evaluable_failed_not_skipped,
        test_execute_integration_all_field_paths_missing,
    ]:
        print(f"\n[{test.__name__}]")
        try:
            test()
        except AssertionError as e:
            print(f"  FAIL: {e}")
            failures.append(test.__name__)
        except Exception as e:
            print(f"  ERROR: {type(e).__name__}: {e}")
            failures.append(test.__name__)

    print()
    if failures:
        print(f"FAILED: {len(failures)} test(s) -- {failures}")
        return 1
    print("All strategy_executor skip-flag tests passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
