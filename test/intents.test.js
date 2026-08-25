import { describe, it, expect } from 'vitest';
import { extractIntent } from '../src/lib/intents.js';

describe('extractIntent', () => {
  it('should extract title from simple transcript', async () => {
    const mockEnv = {
      AI: {
        run: async () => ({
          response: '{"title": "buy milk", "date": "2026-08-26", "priority": "medium", "category": "shopping", "tags": ["grocery"]}'
        })
      }
    };

    const result = await extractIntent('buy milk tomorrow', mockEnv);
    expect(result.title).toBe('buy milk');
    expect(result.date).toBe('2026-08-26');
    expect(result.priority).toBe('medium');
  });

  it('should fallback on LLM failure', async () => {
    const mockEnv = {
      AI: {
        run: async () => { throw new Error('timeout'); }
      }
    };

    const result = await extractIntent('buy milk', mockEnv);
    expect(result.title).toBe('buy milk');
    expect(result.date).toBeNull();
    expect(result.priority).toBe('medium');
  });

  it('should handle vague input', async () => {
    const mockEnv = {
      AI: {
        run: async () => ({
          response: '{"title": "grab coffee", "date": null, "priority": "low", "category": null, "tags": []}'
        })
      }
    };

    const result = await extractIntent('grab coffee', mockEnv);
    expect(result.title).toBe('grab coffee');
    expect(result.date).toBeNull();
    expect(result.priority).toBe('low');
  });
});
