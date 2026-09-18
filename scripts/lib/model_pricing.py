#!/usr/bin/env python3
"""
ADK Model Pricing Calculator.
Calculates token and step usage costs across various AI models (Gemini, Claude, GPT).
"""
import re
from typing import Any, Dict, Optional

# Default USD to KRW exchange rate estimate for localized reporting
DEFAULT_USD_KRW_RATE = 1350.0

# Pricing in USD per 1,000,000 (1M) tokens
# Ref: Standard provider API pricing specs
MODEL_PRICING_CATALOG: Dict[str, Dict[str, Any]] = {
    # Google Gemini Models
    "gemini-flash": {
        "canonical": "gemini-flash",
        "display_name": "Google Gemini Flash",
        "input_per_million": 0.075,
        "output_per_million": 0.30,
        "cached_input_per_million": 0.01875,
        "avg_tokens_per_step": 1200,
    },
    "gemini-pro": {
        "canonical": "gemini-pro",
        "display_name": "Google Gemini Pro",
        "input_per_million": 1.25,
        "output_per_million": 5.00,
        "cached_input_per_million": 0.3125,
        "avg_tokens_per_step": 2000,
    },
    # Anthropic Claude Models
    "claude-sonnet": {
        "canonical": "claude-sonnet",
        "display_name": "Anthropic Claude Sonnet",
        "input_per_million": 3.00,
        "output_per_million": 15.00,
        "cached_input_per_million": 0.30,
        "avg_tokens_per_step": 2500,
    },
    "claude-haiku": {
        "canonical": "claude-haiku",
        "display_name": "Anthropic Claude Haiku",
        "input_per_million": 0.80,
        "output_per_million": 4.00,
        "cached_input_per_million": 0.08,
        "avg_tokens_per_step": 1200,
    },
    "claude-opus": {
        "canonical": "claude-opus",
        "display_name": "Anthropic Claude Opus",
        "input_per_million": 15.00,
        "output_per_million": 75.00,
        "cached_input_per_million": 1.50,
        "avg_tokens_per_step": 3500,
    },
    # OpenAI GPT Models
    "gpt-4o": {
        "canonical": "gpt-4o",
        "display_name": "OpenAI GPT-4o",
        "input_per_million": 2.50,
        "output_per_million": 10.00,
        "cached_input_per_million": 1.25,
        "avg_tokens_per_step": 2200,
    },
    "gpt-4o-mini": {
        "canonical": "gpt-4o-mini",
        "display_name": "OpenAI GPT-4o mini",
        "input_per_million": 0.15,
        "output_per_million": 0.60,
        "cached_input_per_million": 0.075,
        "avg_tokens_per_step": 1200,
    },
    # Fallback default
    "default": {
        "canonical": "default",
        "display_name": "Standard AI Model",
        "input_per_million": 1.00,
        "output_per_million": 4.00,
        "cached_input_per_million": 0.25,
        "avg_tokens_per_step": 1500,
    }
}


def normalize_model_name(raw_name: Optional[str]) -> str:
    """Matches arbitrary model name strings to catalog canonical keys."""
    if not raw_name:
        return "default"
    cleaned = raw_name.lower().replace("_", "-").strip()

    if "flash" in cleaned:
        return "gemini-flash"
    if "pro" in cleaned:
        return "gemini-pro"
    if "sonnet" in cleaned:
        return "claude-sonnet"
    if "haiku" in cleaned:
        return "claude-haiku"
    if "opus" in cleaned:
        return "claude-opus"
    if "gpt-4o-mini" in cleaned or "4o-mini" in cleaned:
        return "gpt-4o-mini"
    if "gpt-4" in cleaned or "4o" in cleaned:
        return "gpt-4o"

    return "default"


def get_model_spec(model_name: Optional[str]) -> Dict[str, Any]:
    """Returns the pricing specification for the given model name."""
    key = normalize_model_name(model_name)
    return MODEL_PRICING_CATALOG.get(key, MODEL_PRICING_CATALOG["default"])


def calculate_token_cost(
    model_name: Optional[str],
    input_tokens: int = 0,
    output_tokens: int = 0,
    cached_tokens: int = 0,
    usd_to_krw_rate: float = DEFAULT_USD_KRW_RATE
) -> Dict[str, Any]:
    """
    Calculates detailed token costs based on model specification.
    Returns costs in USD and estimated KRW.
    """
    spec = get_model_spec(model_name)
    input_t = max(0, int(input_tokens))
    output_t = max(0, int(output_tokens))
    cached_t = max(0, int(cached_tokens))

    in_cost = (input_t / 1_000_000.0) * spec["input_per_million"]
    out_cost = (output_t / 1_000_000.0) * spec["output_per_million"]
    cached_cost = (cached_t / 1_000_000.0) * spec.get("cached_input_per_million", 0.0)

    total_usd = round(in_cost + out_cost + cached_cost, 6)
    total_krw = round(total_usd * usd_to_krw_rate, 1)

    return {
        "model": spec["canonical"],
        "display_name": spec["display_name"],
        "input_tokens": input_t,
        "output_tokens": output_t,
        "cached_tokens": cached_t,
        "total_tokens": input_t + output_t + cached_t,
        "cost_usd": total_usd,
        "cost_krw": total_krw,
        "rates": {
            "input_per_million": spec["input_per_million"],
            "output_per_million": spec["output_per_million"],
            "cached_per_million": spec.get("cached_input_per_million", 0.0),
        }
    }


def calculate_step_cost(
    model_name: Optional[str],
    steps: int = 0,
    usd_to_krw_rate: float = DEFAULT_USD_KRW_RATE
) -> Dict[str, Any]:
    """
    Estimates token and financial usage based on execution steps
    when exact token counts are unmetered.
    """
    spec = get_model_spec(model_name)
    s = max(0, int(steps))
    avg_per_step = spec.get("avg_tokens_per_step", 1500)
    # Heuristic ratio: ~75% input prompt/context, ~25% output generation
    est_input = int(s * avg_per_step * 0.75)
    est_output = int(s * avg_per_step * 0.25)

    res = calculate_token_cost(
        model_name=model_name,
        input_tokens=est_input,
        output_tokens=est_output,
        usd_to_krw_rate=usd_to_krw_rate
    )
    res["steps"] = s
    res["estimated_tokens_per_step"] = avg_per_step
    return res


def get_model_multiplier(model_name: Optional[str]) -> float:
    """Returns the quota consumption multiplier relative to baseline Flash (1.0x)."""
    key = normalize_model_name(model_name)
    multipliers = {
        "gemini-flash": 1.0,
        "gemini-pro": 5.0,
        "claude-haiku": 1.0,
        "claude-sonnet": 3.0,
        "claude-opus": 10.0,
        "gpt-4o-mini": 1.0,
        "gpt-4o": 4.0,
        "default": 1.0,
    }
    return multipliers.get(key, 1.0)


def predict_quota_burn(
    raw_steps: int,
    model_name: Optional[str] = None,
    base_flash_capacity: int = 80000,
    multiplier: Optional[float] = None
) -> Dict[str, Any]:
    """Calculates weighted steps and quota burn percentage for rolling window."""
    mult = multiplier if multiplier is not None else get_model_multiplier(model_name)
    weighted_steps = int(raw_steps * mult)
    burn_pct = round((weighted_steps / max(1, base_flash_capacity)) * 100, 1)
    effective_capacity = int(base_flash_capacity / mult) if mult > 0 else base_flash_capacity

    risk_level = "safe"
    risk_label = "정상 여유 (Safe)"
    if burn_pct >= 95:
        risk_level = "critical"
        risk_label = "소진 임박 (일시 대기 가능)" if burn_pct <= 100.0 else f"한도 초과 ({burn_pct}%)"
    elif burn_pct >= 80:
        risk_level = "warning"
        risk_label = "소진 주의 (80% 이상)"

    return {
        "raw_steps": raw_steps,
        "multiplier": mult,
        "weighted_steps": weighted_steps,
        "base_capacity": base_flash_capacity,
        "effective_capacity": effective_capacity,
        "burn_pct": burn_pct,
        "risk_level": risk_level,
        "risk_label": risk_label,
    }

