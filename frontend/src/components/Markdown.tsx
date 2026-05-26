import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

interface Props {
  content: string;
  streaming?: boolean;
}

export function Markdown({ content, streaming }: Props) {
  const text = streaming ? content + "\u200B" : content;

  return (
    <div className="md-body break-words text-[15px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a: (props) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          ),
          pre: ({ children, ...props }) => (
            <CodeBlock preProps={props}>{children}</CodeBlock>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      {streaming && <span className="md-cursor" aria-hidden />}
    </div>
  );
}

function CodeBlock({
  children,
  preProps,
}: {
  children: React.ReactNode;
  preProps: React.HTMLAttributes<HTMLPreElement>;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const root = preRef.current;
    if (!root) return;
    const code = root.querySelector("code");
    const text = (code?.textContent ?? root.textContent ?? "").replace(/\u200B/g, "");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  return (
    <div className="md-codeblock group/code relative">
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "已复制" : "复制代码"}
        className="absolute top-2 right-2 z-10 px-2 py-0.5 rounded text-xs
          bg-bg-panel/90 text-fg-secondary border border-border-subtle
          opacity-0 group-hover/code:opacity-100 focus:opacity-100
          hover:text-fg-primary hover:bg-bg-hover transition"
      >
        {copied ? "已复制" : "复制"}
      </button>
      <pre ref={preRef} {...preProps}>
        {children}
      </pre>
    </div>
  );
}
