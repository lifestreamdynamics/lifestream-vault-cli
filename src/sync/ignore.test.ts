import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('node:fs');
const mockedFs = vi.mocked(fs);

import {
  DEFAULT_IGNORE_PATTERNS,
  loadIgnoreFile,
  resolveIgnorePatterns,
  shouldIgnore,
} from './ignore.js';

describe('sync ignore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('DEFAULT_IGNORE_PATTERNS', () => {
    it('should include common patterns', () => {
      expect(DEFAULT_IGNORE_PATTERNS).toContain('.git/');
      expect(DEFAULT_IGNORE_PATTERNS).toContain('node_modules/');
      expect(DEFAULT_IGNORE_PATTERNS).toContain('.DS_Store');
      expect(DEFAULT_IGNORE_PATTERNS).toContain('*.tmp');
      expect(DEFAULT_IGNORE_PATTERNS).toContain('.lsvault/');
    });
  });

  describe('loadIgnoreFile', () => {
    it('should return empty array when no file exists', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(loadIgnoreFile('/tmp/vault')).toEqual([]);
    });

    it('should parse ignore file', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        '# Comment\n*.log\nbuild/\n\n  drafts/*.tmp  \n',
      );
      const patterns = loadIgnoreFile('/tmp/vault');
      expect(patterns).toEqual(['*.log', 'build/', 'drafts/*.tmp']);
    });

    it('should handle read errors gracefully', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(() => { throw new Error('read error'); });
      expect(loadIgnoreFile('/tmp/vault')).toEqual([]);
    });
  });

  describe('resolveIgnorePatterns', () => {
    it('should combine defaults, config, and file patterns', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('custom-pattern\n');
      const patterns = resolveIgnorePatterns(['extra-ignore'], '/tmp/vault');
      expect(patterns).toContain('.git/');
      expect(patterns).toContain('extra-ignore');
      expect(patterns).toContain('custom-pattern');
    });

    it('should deduplicate patterns', () => {
      mockedFs.existsSync.mockReturnValue(false);
      const patterns = resolveIgnorePatterns(['.git/', '.DS_Store'], '/tmp/vault');
      const gitCount = patterns.filter(p => p === '.git/').length;
      expect(gitCount).toBe(1);
    });
  });

  describe('shouldIgnore', () => {
    it('should match directory patterns', () => {
      expect(shouldIgnore('.git/config', ['.git/'])).toBe(true);
      expect(shouldIgnore('sub/.git/config', ['.git/'])).toBe(false);
      expect(shouldIgnore('node_modules/pkg/index.js', ['node_modules/'])).toBe(true);
    });

    it('should match glob patterns', () => {
      expect(shouldIgnore('test.tmp', ['*.tmp'])).toBe(true);
      expect(shouldIgnore('sub/test.tmp', ['*.tmp'])).toBe(true);
      expect(shouldIgnore('test.md', ['*.tmp'])).toBe(false);
    });

    it('should match dotfiles by basename', () => {
      expect(shouldIgnore('.DS_Store', ['.DS_Store'])).toBe(true);
      expect(shouldIgnore('sub/.DS_Store', ['.DS_Store'])).toBe(true);
      expect(shouldIgnore('Thumbs.db', ['Thumbs.db'])).toBe(true);
    });

    it('should not ignore valid markdown files', () => {
      expect(shouldIgnore('notes/hello.md', DEFAULT_IGNORE_PATTERNS)).toBe(false);
      expect(shouldIgnore('readme.md', DEFAULT_IGNORE_PATTERNS)).toBe(false);
    });

    it('should ignore .lsvault directory and files', () => {
      expect(shouldIgnore('.lsvault/config.json', ['.lsvault/'])).toBe(true);
      expect(shouldIgnore('.lsvault-ignore', ['.lsvault-*'])).toBe(true);
    });

    it('should return false for empty patterns', () => {
      expect(shouldIgnore('anything.md', [])).toBe(false);
    });
  });
});
