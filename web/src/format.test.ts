import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, formatSize, openTarget } from './format.ts';

describe('format', () => {
  it('formats sizes', () => {
    assert.equal(formatSize(0), '0 B'); assert.equal(formatSize(1023), '1023 B');
    assert.equal(formatSize(1536), '1.5 KB'); assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
    assert.equal(formatSize(300 * 1024 * 1024), '300 MB'); assert.equal(formatSize(2 * 1024 ** 4), '2.0 TB');
  });
  it('formats dates relative to now', () => {
    const now = new Date(2026, 5, 15, 12, 0).getTime();
    assert.match(formatDate(new Date(2026, 5, 15, 9, 5).getTime(), now), /9:05/);
    assert.doesNotMatch(formatDate(new Date(2026, 0, 3).getTime(), now), /2026/);
    assert.match(formatDate(new Date(2024, 0, 3).getTime(), now), /2024/);
  });
  it('routes folders to the browser and files to the opener', () => {
    assert.equal(openTarget({ id: 'a', kind: 'folder' }), '/files/a');
    assert.equal(openTarget({ id: 'b', kind: 'document' }), '/open/b');
  });
});
