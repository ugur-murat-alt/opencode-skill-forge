import { Fragment } from "react";
import { useLang } from "../i18n/lang";
import {
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from "./markdown";

/**
 * Issue #37 (M04): safe preview renderer. Every node becomes a React element;
 * raw HTML never reaches the DOM and unsafe links/images render as inert
 * text. Bounded input is enforced by the parser.
 */
export function MarkdownPreview({
  source,
  testId,
}: {
  source: string;
  testId?: string;
}) {
  const { t } = useLang();
  const { blocks, truncated } = parseMarkdown(source);
  const renderInline = (nodes: MarkdownInline[], keyPrefix: string) => (
    <>
      {nodes.map((node, index) => {
        const key = `${keyPrefix}-${index}`;
        if (node.type === "text")
          return <Fragment key={key}>{node.value}</Fragment>;
        if (node.type === "code") return <code key={key}>{node.value}</code>;
        if (node.type === "strong")
          return <strong key={key}>{renderInline(node.children, key)}</strong>;
        if (node.type === "em")
          return <em key={key}>{renderInline(node.children, key)}</em>;
        if (node.type === "link")
          return (
            <a
              key={key}
              href={node.href}
              target="_blank"
              rel="noopener noreferrer nofollow"
            >
              {renderInline(node.children, key)}
            </a>
          );
        return (
          <span key={key} className="memory-blocked-inline">
            {renderInline(node.children, key)}{" "}
            <small>
              {node.reason === "image"
                ? t("memory.preview.blockedImage")
                : t("memory.preview.blockedLink")}
            </small>
          </span>
        );
      })}
    </>
  );
  const renderBlock = (block: MarkdownBlock, index: number) => {
    const key = `block-${index}`;
    if (block.type === "heading") {
      const Tag = `h${Math.min(block.level + 2, 6)}` as "h3";
      return (
        <Tag key={key} className="memory-preview-heading">
          {renderInline(block.children, key)}
        </Tag>
      );
    }
    if (block.type === "paragraph")
      return (
        <p key={key} className="memory-preview-paragraph">
          {renderInline(block.children, key)}
        </p>
      );
    if (block.type === "code")
      return (
        <pre
          key={key}
          className="memory-preview-code"
          data-language={block.language}
        >
          <code>{block.value}</code>
        </pre>
      );
    if (block.type === "hr") return <hr key={key} />;
    if (block.type === "quote")
      return (
        <blockquote key={key} className="memory-preview-quote">
          {renderInline(block.children, key)}
        </blockquote>
      );
    const Tag = block.ordered ? "ol" : "ul";
    return (
      <Tag
        key={key}
        start={block.ordered && block.start !== 1 ? block.start : undefined}
        className="memory-preview-list"
      >
        {block.items.map((item, itemIndex) => (
          <li key={`${key}-${itemIndex}`}>
            {item.task && (
              <>
                <input
                  type="checkbox"
                  checked={item.checked}
                  readOnly
                  disabled
                />{" "}
              </>
            )}
            {renderInline(item.children, `${key}-${itemIndex}`)}
          </li>
        ))}
      </Tag>
    );
  };
  return (
    <div className="memory-preview" data-testid={testId}>
      {blocks.length === 0 ? (
        <p className="memory-preview-empty">{t("memory.preview.empty")}</p>
      ) : (
        blocks.map(renderBlock)
      )}
      {truncated && (
        <p
          className="memory-preview-truncated"
          data-testid="memory-preview-truncated"
        >
          {t("memory.preview.truncated")}
        </p>
      )}
    </div>
  );
}
