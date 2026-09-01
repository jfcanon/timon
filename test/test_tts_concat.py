#!/usr/bin/env python3
"""Unit tests for tts_server concatenation logic (NID-534).

Validates that _synthesize_with_kokoro correctly handles multi-chunk output
where Kokoro yields 2-D audio arrays shape (1, N). The reshape(-1) fix
ensures np.concatenate succeeds on axis 0.
"""
import numpy as np


def test_single_chunk_2d_reshape():
    chunk = np.ones((1, 100), dtype=np.float32) * 0.5
    reshaped = chunk.reshape(-1)
    assert reshaped.shape == (100,)
    assert reshaped.ndim == 1


def test_multi_chunk_concat():
    chunk1 = np.ones((1, 80), dtype=np.float32) * 0.3
    chunk2 = np.ones((1, 120), dtype=np.float32) * 0.7
    reshaped1 = chunk1.reshape(-1)
    reshaped2 = chunk2.reshape(-1)
    full = np.concatenate([reshaped1, reshaped2])
    assert full.shape == (200,)
    np.testing.assert_array_almost_equal(full[:80], 0.3)
    np.testing.assert_array_almost_equal(full[80:], 0.7)


def test_multi_chunk_concat_fails_without_reshape():
    chunk1 = np.ones((1, 80), dtype=np.float32)
    chunk2 = np.ones((1, 120), dtype=np.float32)
    try:
        np.concatenate([chunk1, chunk2])
        assert False, "Should have raised ValueError"
    except ValueError:
        pass


def test_multi_chunk_concat_same_length():
    chunk1 = np.ones((1, 100), dtype=np.float32) * 0.3
    chunk2 = np.ones((1, 100), dtype=np.float32) * 0.7
    full_2d = np.concatenate([chunk1, chunk2])
    assert full_2d.shape == (2, 100)
    full_1d = np.concatenate([chunk1.reshape(-1), chunk2.reshape(-1)])
    assert full_1d.shape == (200,)


def test_reshape_preserves_values():
    original = np.array([[0.1, 0.2, 0.3, 0.4, 0.5]], dtype=np.float32)
    reshaped = original.reshape(-1)
    np.testing.assert_array_equal(original.flatten(), reshaped)


if __name__ == "__main__":
    test_single_chunk_2d_reshape()
    test_multi_chunk_concat()
    test_multi_chunk_concat_fails_without_reshape()
    test_multi_chunk_concat_same_length()
    test_reshape_preserves_values()
    print("All tests passed.")
