"""Prompt templates for LLM adapters.

This module provides small helper functions that build text prompts
for generating signal explanations. Keeping these templates simple
avoids importing any heavy dependencies at import time.
"""

from typing import Dict, Any


def create_signal_explanation_prompt(
	signal_data: Dict[str, Any],
	engine_scores: Dict[str, Any],
	asset_id: str,
	asset_type: str,
) -> str:
	"""Build a plain-text prompt for explaining a trading signal.

	Args:
		signal_data: dictionary with keys like `action`, `final_score`, `confidence`, `reason`
		engine_scores: mapping of engine names to score values / metadata
		asset_id: the asset ticker or identifier
		asset_type: 'crypto' or 'stock'

	Returns:
		A single string prompt suitable to send to an LLM.
	"""
	action = signal_data.get("action", "unknown")
	final_score = signal_data.get("final_score", None)
	confidence = signal_data.get("confidence", None)
	reason = signal_data.get("reason") or signal_data.get("explanation") or ""

	# Short summary of engine scores
	scores_lines = []
	for name, val in (engine_scores or {}).items():
		try:
			score = val.get("score") if isinstance(val, dict) else val
		except Exception:
			score = val
		scores_lines.append(f"- {name}: {score}")

	scores_text = "\n".join(scores_lines) if scores_lines else "(no engine scores provided)"

	prompt = (
		f"You are an expert trading analyst. Explain the following trading signal for "
		f"{asset_id} ({asset_type}).\n\n"
		f"Signal:\n"
		f"Action: {action}\n"
		f"Final score: {final_score}\n"
		f"Confidence: {confidence}\n"
		f"Reason: {reason}\n\n"
		f"Engine scores:\n{scores_text}\n\n"
		"Provide a concise (3-6 sentence) human-readable explanation, include the main drivers, "
		"and end with a short summary sentence stating the suggested action and a confidence estimate."
	)

	return prompt


__all__ = ["create_signal_explanation_prompt"]
