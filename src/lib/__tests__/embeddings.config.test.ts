import { describe, it, expect } from 'vitest';
import { EMBED_CONFIG, EMBED_MODEL_ID, EMBED_DIMENSION } from '../embeddings/config';

describe('EMBED_CONFIG', () => {
  it('uses canonical gemini-embedding-2 @ 768', () => {
    expect(EMBED_MODEL_ID).toBe('gemini-embedding-2');
    expect(EMBED_CONFIG.model).toBe('gemini-embedding-2');
    expect(EMBED_DIMENSION).toBe(768);
    expect(EMBED_CONFIG.dimension).toBe(768);
  });
});
