#!/usr/bin/env python3
"""Unit tests for Kokoro multi-chunk concatenation logic.

Verifies that np.array(mx_audio).reshape(-1) correctly flattens 2-D arrays
before concatenation, preventing ValueError when chunks have different lengths.
"""

import numpy as np
import unittest


class TestTtsConcat(unittest.TestCase):
    """Test concatenation of audio chunks from Kokoro pipeline."""

    def test_reshape_flattens_2d_to_1d(self):
        """mx.array from Kokoro is shape (1, N); reshape(-1) should make it (N,)."""
        chunk_2d = np.array([[1.0, 2.0, 3.0, 4.0]])  # shape (1, 4)
        flattened = chunk_2d.reshape(-1)
        self.assertEqual(flattened.shape, (4,))
        self.assertTrue(np.array_equal(flattened, np.array([1.0, 2.0, 3.0, 4.0])))

    def test_concatenate_multiple_chunks_different_lengths(self):
        """Multiple chunks with different N should concatenate without ValueError."""
        chunk1 = np.array([[1.0, 2.0, 3.0]])      # shape (1, 3)
        chunk2 = np.array([[4.0, 5.0, 6.0, 7.0]])  # shape (1, 4)
        chunk3 = np.array([[8.0, 9.0]])            # shape (1, 2)

        # This is the exact pattern in _synthesize_with_kokoro
        audio_chunks = [c.reshape(-1) for c in (chunk1, chunk2, chunk3)]
        full_audio = np.concatenate(audio_chunks)

        expected = np.array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0])
        self.assertTrue(np.array_equal(full_audio, expected))

    def test_concatenate_single_chunk_works(self):
        """Single chunk should work without concatenate path."""
        chunk = np.array([[1.0, 2.0, 3.0]])
        audio_chunks = [chunk.reshape(-1)]
        full_audio = np.concatenate(audio_chunks) if len(audio_chunks) > 1 else audio_chunks[0]
        self.assertTrue(np.array_equal(full_audio, np.array([1.0, 2.0, 3.0])))

    def test_concatenate_without_reshape_raises(self):
        """Without reshape, concatenate on axis 0 raises ValueError for different N."""
        chunk1 = np.array([[1.0, 2.0, 3.0]])      # shape (1, 3)
        chunk2 = np.array([[4.0, 5.0, 6.0, 7.0]])  # shape (1, 4)

        audio_chunks = [chunk1, chunk2]  # NO reshape
        with self.assertRaises(ValueError):
            np.concatenate(audio_chunks)

    def test_simulated_kokoro_pipeline_output(self):
        """Simulate Kokoro yielding multiple Result objects with 2-D audio."""
        # Kokoro yields Result objects; each result.output.audio is mx.array -> 2-D numpy
        class MockResult:
            def __init__(self, audio_data):
                class MockOutput:
                    audio = audio_data
                self.output = MockOutput()

        # First chunk: 100 samples, second: 150 samples
        chunk1_2d = np.random.randn(1, 100).astype(np.float32)
        chunk2_2d = np.random.randn(1, 150).astype(np.float32)

        results = [MockResult(chunk1_2d), MockResult(chunk2_2d)]

        audio_chunks = []
        for result in results:
            mx_audio = result.output.audio
            np_audio = np.array(mx_audio).reshape(-1)  # THE FIX
            audio_chunks.append(np_audio)

        full_audio = np.concatenate(audio_chunks)
        self.assertEqual(full_audio.shape, (250,))


if __name__ == "__main__":
    unittest.main()