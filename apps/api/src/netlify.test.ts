import { describe, expect, it } from 'vitest';
import { normaliseFunctionPath } from './netlify.js';

describe('normaliseFunctionPath', () => {
  it('passes through the original request path unchanged', () => {
    expect(normaliseFunctionPath('/api/v1/students')).toBe('/api/v1/students');
  });

  it('strips the Netlify function prefix', () => {
    expect(normaliseFunctionPath('/.netlify/functions/api/v1/students')).toBe('/api/v1/students');
  });

  it('handles health probes in both forms', () => {
    expect(normaliseFunctionPath('/api/healthz')).toBe('/api/healthz');
    expect(normaliseFunctionPath('/.netlify/functions/api/healthz')).toBe('/api/healthz');
  });

  it('handles the bare function path', () => {
    expect(normaliseFunctionPath('/.netlify/functions/api')).toBe('/api');
    expect(normaliseFunctionPath('/api')).toBe('/api');
  });

  it('is idempotent, so a double rewrite cannot corrupt the path', () => {
    const once = normaliseFunctionPath('/.netlify/functions/api/v1/students');
    expect(normaliseFunctionPath(once)).toBe(once);
  });

  it('keeps nested paths and trailing segments intact', () => {
    expect(normaliseFunctionPath('/api/v1/students/RNTPS-26-001/siblings')).toBe(
      '/api/v1/students/RNTPS-26-001/siblings',
    );
  });

  it('falls back to /api for an empty path', () => {
    expect(normaliseFunctionPath('')).toBe('/api');
    expect(normaliseFunctionPath(undefined)).toBe('/api');
  });
});
