/**
 * Side-by-side diff via CodeMirror merge (Spec 06 §4, §7). Read-only; renders
 * the original vs. modified text for edit_file/write_file tool cards and the
 * right-panel detail view.
 */
import { useEffect, useRef, type CSSProperties } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';

const readOnlyExtensions = [lineNumbers(), EditorView.editable.of(false), EditorState.readOnly.of(true)];

export interface DiffViewProps {
  original: string;
  modified: string;
  height?: number | string;
}

export function DiffView({ original, modified, height = 320 }: DiffViewProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MergeView | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new MergeView({
      parent: hostRef.current,
      a: { doc: original, extensions: readOnlyExtensions },
      b: { doc: modified, extensions: readOnlyExtensions },
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: { margin: 3 },
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [original, modified]);

  return <div ref={hostRef} style={{ ...wrap, height }} className="vf-diff" />;
}

const wrap: CSSProperties = {
  border: '1px solid var(--vf-border)',
  borderRadius: 8,
  overflow: 'auto',
  fontFamily: 'var(--vf-mono)',
  fontSize: 12.5,
  background: 'var(--vf-bg-inset)',
};
