#!/usr/bin/env python3
"""Unit tests for ADK Model Pricing Calculator."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from lib.model_pricing import (
    normalize_model_name,
    get_model_spec,
    calculate_token_cost,
    calculate_step_cost,
    MODEL_PRICING_CATALOG
)


class TestModelPricing(unittest.TestCase):
    def test_normalize_model_name(self):
        self.assertEqual(normalize_model_name('Gemini 3.8 Flash (High)'), 'gemini-flash')
        self.assertEqual(normalize_model_name('gemini-2.5-flash'), 'gemini-flash')
        self.assertEqual(normalize_model_name('gemini-pro-1.5'), 'gemini-pro')
        self.assertEqual(normalize_model_name('claude-3-5-sonnet-20241022'), 'claude-sonnet')
        self.assertEqual(normalize_model_name('claude-3-haiku'), 'claude-haiku')
        self.assertEqual(normalize_model_name('gpt-4o'), 'gpt-4o')
        self.assertEqual(normalize_model_name('gpt-4o-mini-2024-07-18'), 'gpt-4o-mini')
        self.assertEqual(normalize_model_name('unknown-custom-model'), 'default')
        self.assertEqual(normalize_model_name(None), 'default')

    def test_calculate_token_cost(self):
        # 1,000,000 input tokens on Gemini Flash: $0.075
        # 1,000,000 output tokens on Gemini Flash: $0.30
        res = calculate_token_cost('gemini-flash', input_tokens=1_000_000, output_tokens=1_000_000)
        self.assertAlmostEqual(res['cost_usd'], 0.375, places=4)
        self.assertEqual(res['total_tokens'], 2_000_000)
        self.assertEqual(res['model'], 'gemini-flash')
        self.assertGreater(res['cost_krw'], 0)

    def test_calculate_step_cost(self):
        res = calculate_step_cost('claude-sonnet', steps=100)
        self.assertEqual(res['steps'], 100)
        self.assertEqual(res['model'], 'claude-sonnet')
        self.assertGreater(res['total_tokens'], 0)
        self.assertGreater(res['cost_usd'], 0)

    def test_zero_and_negative_handling(self):
        res = calculate_token_cost('gemini-flash', input_tokens=-100, output_tokens=0)
        self.assertEqual(res['input_tokens'], 0)
        self.assertEqual(res['output_tokens'], 0)
        self.assertEqual(res['cost_usd'], 0.0)


if __name__ == '__main__':
    unittest.main()
