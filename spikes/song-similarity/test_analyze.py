"""Pure-helper tests; they need numpy but not Essentia. Run: python -m unittest"""
import unittest

import numpy as np

import analyze


class AnalyzeHelpers(unittest.TestCase):
    def test_pool_is_unit_length_with_expected_dimension(self):
        frames = np.random.default_rng(0).normal(size=(7, analyze.DIMENSION))
        vector = analyze.pool(frames)
        self.assertEqual(len(vector), analyze.DIMENSION)
        self.assertAlmostEqual(float(np.linalg.norm(vector)), 1.0, places=3)

    def test_pool_rejects_wrong_shape(self):
        with self.assertRaises(ValueError):
            analyze.pool(np.ones((3, 10)))

    def test_trim_silence_removes_leading_and_trailing_quiet(self):
        sr = analyze.SAMPLE_RATE
        loud = np.sin(np.linspace(0, 2000, sr * 2)).astype(np.float32) * 0.5
        audio = np.concatenate([np.zeros(sr), loud, np.zeros(sr)])
        trimmed = analyze.trim_silence(audio)
        self.assertLess(abs(len(trimmed) - len(loud)), sr // 10)

    def test_all_silence_trims_to_nothing_and_is_rejected(self):
        trimmed = analyze.trim_silence(np.zeros(analyze.SAMPLE_RATE * 30))
        with self.assertRaises(ValueError):
            analyze.windows(trimmed, 30)

    def test_windows_take_the_first_and_last_seconds(self):
        sr = analyze.SAMPLE_RATE
        audio = np.arange(sr * 60, dtype=np.float32)
        opening, closing = analyze.windows(audio, 30)
        self.assertEqual(opening[0], 0)
        self.assertEqual(closing[-1], audio[-1])
        self.assertEqual(len(opening), 30 * sr)


if __name__ == "__main__":
    unittest.main()
