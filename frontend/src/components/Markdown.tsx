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
        }}
      >
        {text}
      </ReactMarkdown>
      {streaming && <span className="md-cursor" aria-hidden />}
    </div>
  );
}
