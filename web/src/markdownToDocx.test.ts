import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { markdownToDocx } from './markdownToDocx.ts';

describe('markdownToDocx', () => {
  it('produces a Word file with headings, emphasis, lists, code, quotes, links and tables', async () => {
    const md = '# Title\n\nSome **bold** and *italic* with `code` and [a link](https://example.com).\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n> quoted\n\n```\nlet x = 1\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n---\n';
    const bytes = new Uint8Array(await markdownToDocx(md));
    assert.equal(String.fromCharCode(bytes[0]!, bytes[1]!), 'PK');
    const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string');
    for (const s of ['Title', 'bold', 'italic', 'one', 'nested', 'first', 'quoted', 'let x = 1', '<w:tbl>', 'a link', 'Heading1']) assert.ok(xml.includes(s), 'missing ' + s);
    assert.match(xml, /<w:b\s*\/>/);
  });
  it('handles an empty file', async () => { assert.ok((await markdownToDocx('')).byteLength > 500); });
});
