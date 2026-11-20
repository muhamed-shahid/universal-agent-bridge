import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkDir } from '../../helpers/fs.js';
import { createServices, type Services } from '../../helpers/services.js';

describe('ProjectRegistry', () => {
  let s: Services;
  beforeEach(() => {
    s = createServices();
  });
  afterEach(() => {
    s.close();
  });

  it('registers a directory with its canonical path and folder name', () => {
    const dir = s.sandbox.project('portfolio');
    const { project, created } = s.projects.register(dir);
    expect(created).toBe(true);
    expect(project).toMatchObject({ path: dir, name: 'portfolio' });
    expect(project.id).toMatch(/^PRJ-[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(s.projects.list()).toEqual([project]);
  });

  it('accepts a custom display name and validates it', () => {
    const dir = s.sandbox.project('app');
    expect(s.projects.register(dir, '  Game Testing ').project.name).toBe('Game Testing');
    const other = s.sandbox.project('other');
    expect(() => s.projects.register(other, 'bad\u0007name')).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => s.projects.register(other, '')).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });

  it('returns the existing registration for the same directory reached another way', () => {
    const dir = s.sandbox.project('app');
    const first = s.projects.register(dir).project;
    const link = path.join(s.sandbox.work, 'app-link');
    linkDir(dir, link);
    for (const variant of [dir + path.sep, path.join(dir, '.'), link]) {
      const again = s.projects.register(variant);
      expect(again.created).toBe(false);
      expect(again.project.id).toBe(first.id);
    }
    if (process.platform === 'win32') {
      expect(s.projects.register(dir.toUpperCase()).project.id).toBe(first.id);
    }
    expect(s.projects.list()).toHaveLength(1);
  });

  it('rejects invalid directories without storing anything', () => {
    expect(() => s.projects.register('relative')).toThrow(
      expect.objectContaining({ code: 'PROJECT_PATH_INVALID' }),
    );
    expect(() => s.projects.register(s.sandbox.home)).toThrow(
      expect.objectContaining({ code: 'PROJECT_PATH_INVALID' }),
    );
    expect(s.projects.list()).toEqual([]);
  });

  it('resolves by id or by path and reports unknown projects', () => {
    const dir = s.sandbox.project('app');
    const { project } = s.projects.register(dir);
    expect(s.projects.resolve(project.id)).toEqual(project);
    expect(s.projects.resolve(dir)).toEqual(project);
    expect(() => s.projects.resolve(s.sandbox.project('unregistered'))).toThrow(
      expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }),
    );
    expect(() => s.projects.resolve('PRJ-0000000000')).toThrow(
      expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }),
    );
  });

  it('removes unused projects but refuses projects that have sessions', () => {
    const a = s.projects.register(s.sandbox.project('a')).project;
    const b = s.projects.register(s.sandbox.project('b')).project;
    s.sessions('cli').create({ project: b.id, agentId: 'kiro' });

    s.projects.remove(a.id);
    expect(s.projects.get(a.id)).toBeUndefined();
    expect(() => {
      s.projects.remove(b.id);
    }).toThrow(expect.objectContaining({ code: 'PROJECT_IN_USE' }));
    expect(() => {
      s.projects.remove(a.id);
    }).toThrow(expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }));
  });
});
