"use client";

import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import {
  acceptCompletion,
  startCompletion,
  type CompletionContext,
} from "@codemirror/autocomplete";
import { PostgreSQL, sql, type SQLNamespace } from "@codemirror/lang-sql";

export default function SqlCodeEditor({
  value,
  namespace,
  defaultTable,
  defaultSchema,
  disabled,
  onChange,
  onRun,
}: {
  value: string;
  namespace: SQLNamespace;
  defaultTable?: string;
  defaultSchema?: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onRun: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const editable = useRef(new Compartment());
  const callbacks = useRef({ onChange, onRun });
  callbacks.current = { onChange, onRun };
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                callbacks.current.onRun();
                return true;
              },
            },
            { key: "Ctrl-Space", run: startCompletion },
            { key: "Tab", run: acceptCompletion },
            indentWithTab,
          ]),
          basicSetup,
          language.current.of(
            sql({ dialect: PostgreSQL, upperCaseKeywords: true }),
          ),
          PostgreSQL.language.data.of({
            autocomplete: (context: CompletionContext) => {
              const match = context.matchBefore(/\$\d*/);
              if (!match) return null;
              return {
                from: match.from,
                options: Array.from({ length: 10 }, (_, i) => ({
                  label: `$${i + 1}`,
                  type: "variable",
                  detail: "bound parameter",
                })),
                validFor: /\$\d*/,
              };
            },
          }),
          editable.current.of([
            EditorView.editable.of(true),
            EditorState.readOnly.of(false),
          ]),
          EditorView.contentAttributes.of({
            "aria-label": "SQL query editor",
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              callbacks.current.onChange(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": {
              fontSize: "13px",
              border: "1px solid #dce5df",
              borderRadius: "8px",
              overflow: "hidden",
            },
            ".cm-scroller": {
              fontFamily: "Consolas, monospace",
              minHeight: "220px",
              maxHeight: "420px",
              overflow: "auto",
            },
            ".cm-content": { padding: "14px 0" },
            ".cm-gutters": {
              backgroundColor: "#f5f8f5",
              borderRight: "1px solid #e5ebe6",
            },
            "&.cm-focused": { outline: "2px solid #64a582" },
            ".cm-tooltip-autocomplete": {
              border: "1px solid #bfd1c4",
              borderRadius: "6px",
            },
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
      effects: language.current.reconfigure(
        sql({
          dialect: PostgreSQL,
          schema: namespace,
          defaultTable,
          defaultSchema,
          upperCaseKeywords: true,
        }),
      ),
    });
  }, [namespace, defaultTable, defaultSchema]);
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
  return <div ref={host} className="sql-code-editor" />;
}
