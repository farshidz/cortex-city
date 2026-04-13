"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Textarea } from "@/components/ui/textarea";

interface MdEditorProps {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  className?: string;
}

export function MdEditor({
  value,
  onChange,
  rows = 10,
  placeholder,
  className,
}: MdEditorProps) {
  const [mode, setMode] = useState<"write" | "preview">("write");

  return (
    <div className={className}>
      <div className="flex gap-1 mb-2 border-b pb-2">
        <button
          type="button"
          onClick={() => setMode("write")}
          className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
            mode === "write"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Write
        </button>
        <button
          type="button"
          onClick={() => setMode("preview")}
          className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
            mode === "preview"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Preview
        </button>
      </div>

      {mode === "write" ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          placeholder={placeholder}
          className="font-mono text-sm"
        />
      ) : (
        <div
          className="prose prose-sm dark:prose-invert max-w-none min-h-[100px] rounded-md border p-3 overflow-auto"
          style={{ minHeight: `${rows * 1.5}rem` }}
        >
          {value ? (
            <ReactMarkdown>{value}</ReactMarkdown>
          ) : (
            <p className="text-muted-foreground italic">Nothing to preview</p>
          )}
        </div>
      )}
    </div>
  );
}
