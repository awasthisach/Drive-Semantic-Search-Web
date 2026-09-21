import { describe, it, expect } from 'vitest';
import { runSemanticSearch } from '../searchEngine';
import type { DriveFile } from '../../types';

const base: DriveFile = {
  id: '1',
  name: 'Fiscal Audit Report 2024.pdf',
  mimeType: 'application/pdf',
  size: 10,
  modifiedTime: '2024-01-01T00:00:00.000Z',
  createdTime: '2024-01-01T00:00:00.000Z',
  category: 'document',
  isOffline: false,
  isEncrypted: false,
  contentHash: 'gdrive-1',
  tags: ['finance', 'audit'],
  semanticSummary: 'Yearly fiscal audit for regional sales',
  starred: false,
  isGoogleDriveItem: true,
};

describe('runSemanticSearch', () => {
  it('matches filename keywords', () => {
    const results = runSemanticSearch('fiscal audit', [base]);
    expect(results.length).toBe(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('filters by google_drive category', () => {
    const local = { ...base, id: '2', isGoogleDriveItem: false, name: 'local fiscal' };
    const results = runSemanticSearch('fiscal', [base, local], 'google_drive');
    expect(results.every(r => r.file.isGoogleDriveItem)).toBe(true);
  });

  it('browse mode when query empty (score 0, not ranked relevance)', () => {
    const results = runSemanticSearch('', [base]);
    expect(results.length).toBe(1);
    expect(results[0].score).toBe(0);
    expect(results[0].relevanceReason).toMatch(/Browse/i);
  });

  it('ranks exact filename match above weak summary-only match', () => {
    const exact = { ...base, id: '1', name: 'Budget 2024.pdf', semanticSummary: 'Annual plan' };
    const weak = {
      ...base,
      id: '2',
      name: 'Random notes.txt',
      semanticSummary: 'Someone mentioned budget casually once',
    };
    const results = runSemanticSearch('Budget 2024', [exact, weak]);
    expect(results[0].file.id).toBe('1');
    expect(results[0].score).toBeGreaterThan(results.find(r => r.file.id === '2')?.score ?? 0);
  });

  it('does not give full phrase bonus for single stopword-like query', () => {
    const many = {
      ...base,
      id: '3',
      name: 'Meeting notes.pdf',
      semanticSummary: 'This is a report about the team',
    };
    const results = runSemanticSearch('report', [many]);
    if (results.length) {
      expect(results[0].score).toBeLessThan(50);
    }
  });
});
