import { describe, it, expect, beforeEach } from 'vitest';
import { logDiag, getDiagnostics, clearDiagnostics, exportDiagnosticsJson } from '../diagnostics';

describe('diagnostics', () => {
  beforeEach(() => {
    clearDiagnostics();
  });

  it('redacts bearer tokens and emails', () => {
    logDiag('error', 'auth', 'Bearer ya29.xyzSECRET failed for user@example.com');
    const ev = getDiagnostics()[0];
    expect(ev.message).not.toMatch(/ya29/);
    expect(ev.message).not.toMatch(/user@example.com/);
    expect(ev.message).toMatch(/\[token\]|\[email\]|Bearer \[redacted\]/);
  });

  it('caps ring size', () => {
    for (let i = 0; i < 100; i++) logDiag('info', 't', 'n' + i);
    expect(getDiagnostics().length).toBe(80);
  });

  it('export is valid JSON without file bodies field', () => {
    logDiag('warn', 'hash', 'persist failed');
    const j = JSON.parse(exportDiagnosticsJson());
    expect(Array.isArray(j.events)).toBe(true);
    expect(j.note).toMatch(/Local-only/);
  });
});
