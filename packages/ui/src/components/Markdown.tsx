/**
 * Minimal, dependency-free markdown renderer for chat (Spec 06 §4): paragraphs,
 * fenced code blocks with a copy button, inline code and bold. Deliberately
 * small — full markdown can swap in later behind the same component surface.
 */
import { useState, type CSSProperties } from 'react';
import { Icon } from './Icon.js';

interface Segment {
  kind: 'text' | 'code';
  content: string;
  lang?: string;
}

function parse(md: string): Segment[] {
  const segments: Segment[] = [];
  const fence = /```([\w-]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(md))) {
    if (m.index > last) segments.push({ kind: 'text', content: md.slice(last, m.index) });
    const lang = m[1] || undefined;
    segments.push({ kind: 'code', content: m[2] ?? '', ...(lang ? { lang } : {}) });
    last = fence.lastIndex;
  }
  if (last < md.length) segments.push({ kind: 'text', content: md.slice(last) });
  return segments;
}

function renderInline(text: string): JSX.Element[] {
  // Split on `inline code` and **bold**, preserving the delimiters.
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} style={inlineCode}>
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
}

export function Markdown({ text }: { text: string }): JSX.Element {
  const segments = parse(text);
  return (
    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {segments.map((seg, i) =>
        seg.kind === 'code' ? (
          <CodeBlock key={i} code={seg.content} {...(seg.lang ? { lang: seg.lang } : {})} />
        ) : (
          <span key={i}>{renderInline(seg.content)}</span>
        ),
      )}
    </div>
  );
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div style={codeWrap}>
      <div style={codeBar}>
        <span style={{ color: 'var(--vf-text-faint)', fontSize: 11 }}>{lang ?? 'text'}</span>
        <button style={copyBtn} onClick={copy} title="Copy">
          <Icon name={copied ? 'check' : 'copy'} size={13} />
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre style={pre}>
        <code>{code.replace(/\n$/, '')}</code>
      </pre>
    </div>
  );
}

const inlineCode: CSSProperties = {
  fontFamily: 'var(--vf-mono)',
  fontSize: '0.9em',
  background: 'var(--vf-bg-inset)',
  borderRadius: 4,
  padding: '1px 5px',
};
const codeWrap: CSSProperties = {
  margin: '8px 0',
  border: '1px solid var(--vf-border)',
  borderRadius: 8,
  overflow: 'hidden',
  background: 'var(--vf-bg-inset)',
};
const codeBar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '5px 10px',
  borderBottom: '1px solid var(--vf-border)',
  background: 'var(--vf-bg-raised)',
};
const copyBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  background: 'transparent',
  border: 'none',
  color: 'var(--vf-text-muted)',
  fontSize: 11,
};
const pre: CSSProperties = {
  margin: 0,
  padding: '10px 12px',
  overflowX: 'auto',
  fontFamily: 'var(--vf-mono)',
  fontSize: 12.5,
  lineHeight: 1.55,
};
