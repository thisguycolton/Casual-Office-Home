import { marked, type Token, type Tokens } from 'marked';
import { Document, ExternalHyperlink, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, type ParagraphChild } from 'docx';

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
type Fmt = { bold?: boolean; italics?: boolean; strike?: boolean; code?: boolean };

function inline(tokens: Token[] | undefined, fmt: Fmt = {}): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const t of tokens ?? []) {
    const run = (text: string, f: Fmt) => new TextRun({ text, bold: f.bold, italics: f.italics, strike: f.strike, font: f.code ? 'Courier New' : undefined });
    switch (t.type) {
      case 'strong': out.push(...inline((t as Tokens.Strong).tokens, { ...fmt, bold: true })); break;
      case 'em': out.push(...inline((t as Tokens.Em).tokens, { ...fmt, italics: true })); break;
      case 'del': out.push(...inline((t as Tokens.Del).tokens, { ...fmt, strike: true })); break;
      case 'codespan': out.push(run((t as Tokens.Codespan).text, { ...fmt, code: true })); break;
      case 'link': out.push(new ExternalHyperlink({ link: (t as Tokens.Link).href, children: inline((t as Tokens.Link).tokens, fmt) as TextRun[] })); break;
      case 'br': out.push(new TextRun({ break: 1 })); break;
      case 'image': out.push(run(`[${(t as Tokens.Image).text || 'image'}]`, fmt)); break;
      case 'text': { const tt = t as Tokens.Text; if (tt.tokens?.length) out.push(...inline(tt.tokens, fmt)); else out.push(run(tt.text, fmt)); break; }
      default: if ('text' in t && typeof t.text === 'string') out.push(run(t.text, fmt));
    }
  }
  return out;
}

type Block = Paragraph | Table;
function blocks(tokens: Token[], level = 0, quote = false): Block[] {
  const out: Block[] = [];
  const indent = quote ? { left: 720 } : undefined;
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': out.push(new Paragraph({ heading: HEADINGS[Math.min((t as Tokens.Heading).depth, 6) - 1], children: inline((t as Tokens.Heading).tokens) })); break;
      case 'paragraph': out.push(new Paragraph({ children: inline((t as Tokens.Paragraph).tokens), indent })); break;
      case 'text': out.push(new Paragraph({ children: inline((t as Tokens.Text).tokens ?? [t]), indent })); break;
      case 'code': for (const line of (t as Tokens.Code).text.split('\n')) out.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Courier New' })], indent })); break;
      case 'blockquote': out.push(...blocks((t as Tokens.Blockquote).tokens, level, true)); break;
      case 'hr': out.push(new Paragraph({ border: { bottom: { style: 'single', size: 6, color: '999999', space: 1 } } })); break;
      case 'list': {
        const l = t as Tokens.List;
        l.items.forEach((item, i) => {
          const inner = item.tokens.filter((x) => x.type !== 'list');
          const kids = inline(inner.flatMap((x) => ('tokens' in x && x.tokens ? (x.tokens as Token[]) : [x])));
          const prefix = l.ordered ? `${(Number(l.start) || 1) + i}. ` : '• ';
          out.push(new Paragraph({ children: [new TextRun({ text: prefix }), ...kids], indent: { left: 360 * (level + 1) + (quote ? 720 : 0), hanging: 260 } }));
          for (const sub of item.tokens.filter((x) => x.type === 'list')) out.push(...blocks([sub], level + 1, quote));
        });
        break;
      }
      case 'table': {
        const tb = t as Tokens.Table;
        const row = (cells: Tokens.TableCell[], head: boolean) => new TableRow({ children: cells.map((c) => new TableCell({ children: [new Paragraph({ children: inline(c.tokens, head ? { bold: true } : {}) })] })) });
        out.push(new Table({ rows: [row(tb.header, true), ...tb.rows.map((r) => row(r, false))] }));
        out.push(new Paragraph({}));
        break;
      }
      case 'space': break;
      default: if ('text' in t && typeof t.text === 'string') out.push(new Paragraph({ children: [new TextRun(t.text)] }));
    }
  }
  return out;
}

/** Converts Markdown to a .docx. Images are replaced by their alt text; raw HTML is kept as text. */
export async function markdownToDocx(md: string): Promise<ArrayBuffer> {
  const children = blocks(marked.lexer(md));
  const doc = new Document({ sections: [{ children: children.length ? children : [new Paragraph({})] }] });
  return (await Packer.toBlob(doc)).arrayBuffer();
}
