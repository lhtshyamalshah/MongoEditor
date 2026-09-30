"use client";

import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";

export default function JsonCodeEditor({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const callbacks = useRef({ onChange });
  callbacks.current = { onChange };
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          keymap.of([indentWithTab]),
          basicSetup,
          json(),
          editable.current.of([
            EditorView.editable.of(true),
            EditorState.readOnly.of(false),
          ]),
          EditorView.contentAttributes.of({
            "aria-label": "Document JSON",
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              callbacks.current.onChange(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": {
              fontSize: "12px",
              height: "45dvh",
              minHeight: "250px",
              border: "1px solid #dce5df",
              borderRadius: "7px",
              overflow: "hidden",
              backgroundColor: "#fafcf9",
            },
            ".cm-scroller": {
              fontFamily: "var(--mono)",
              lineHeight: "1.7",
              overflow: "auto",
            },
            ".cm-content": { padding: "12px 0" },
            ".cm-gutters": {
              backgroundColor: "#f5f8f5",
              borderRight: "1px solid #e5ebe6",
            },
            "&.cm-focused": { outline: "2px solid #64a582" },
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = null;
    };
    // The document and callbacks are synchronized below without resetting undo history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    editor.current?.dispatch({
      effects: editable.current.reconfigure([
        EditorView.editable.of(!disabled),
        EditorState.readOnly.of(disabled),
      ]),
    });
  }, [disabled]);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
  }, [value]);
  return <div ref={host} />;
}
