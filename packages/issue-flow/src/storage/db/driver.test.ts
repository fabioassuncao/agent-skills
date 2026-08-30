import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './driver.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('SQLite driver', () => {
  it('configures foreign keys, busy timeout, synchronous mode and DELETE journal on network filesystems', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'issue-flow-driver-'));
    directories.push(directory);
    const warnings: string[] = [];
    const db = await openDatabase(join(directory, 'issue-flow.db'), {
      isNetworkFilesystem: () => true,
      onWarning: (message) => warnings.push(message),
    });
    try {
      expect(db.prepare('PRAGMA foreign_keys').get<{ foreign_keys: number }>()?.foreign_keys).toBe(
        1,
      );
      expect(db.prepare('PRAGMA busy_timeout').get<{ timeout: number }>()?.timeout).toBe(5000);
      expect(db.prepare('PRAGMA synchronous').get<{ synchronous: number }>()?.synchronous).toBe(1);
      expect(db.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>()?.journal_mode).toBe(
        'delete',
      );
      expect(warnings).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('uses WAL on local filesystems and creates a consistent backup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'issue-flow-driver-'));
    directories.push(directory);
    const source = join(directory, 'issue-flow.db');
    const backup = join(directory, 'backups', 'copy.db');
    const db = await openDatabase(source, { isNetworkFilesystem: () => false });
    try {
      expect(db.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>()?.journal_mode).toBe(
        'wal',
      );
      db.exec('CREATE TABLE sample (value TEXT)');
      db.prepare('INSERT INTO sample (value) VALUES (?)').run('saved');
      db.backup(backup);
    } finally {
      db.close();
    }
    const copy = await openDatabase(backup);
    try {
      expect(copy.prepare('SELECT value FROM sample').get<{ value: string }>()?.value).toBe(
        'saved',
      );
    } finally {
      copy.close();
    }
  });
});
