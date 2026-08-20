import Color from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TextAlign from "@tiptap/extension-text-align";
import TextStyle from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  AlignCenter, AlignLeft, AlignRight, Bold, Code2, Heading1, Heading2, Highlighter,
  ImagePlus, Italic, Link2, List, ListOrdered, Redo2, RemoveFormatting, Table2,
  Underline as UnderlineIcon, Undo2, Unlink
} from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from "react";
import { adminApiFetch, adminApiUrl } from "@/api/admin";

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#039;");
}

function inlineMarkdown(value: string) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function markdownToHtml(value: string) {
  const parts: string[] = [];
  let listItems: string[] = [];
  const flushList = () => {
    if (!listItems.length) return;
    parts.push(`<ul>${listItems.join("")}</ul>`);
    listItems = [];
  };

  for (const rawLine of value.replace(/\r/g, "").split("\n")) {
    const line = rawLine.trim();
    if (!line) { flushList(); continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushList();
      const level = heading[1].length;
      parts.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      listItems.push(`<li>${inlineMarkdown(line.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }
    flushList();
    parts.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  flushList();
  return parts.join("");
}

function portableImageUrls(value: string) {
  return value.replace(/https?:\/\/[^/]+\/api\/article-images\/([a-f0-9]{64}\.(?:png|jpg|gif|webp))/giu, "/api/article-images/$1");
}

function editorValue(value: string) {
  const html = /^\s*<[a-z!/][\s\S]*>/i.test(value) ? value : markdownToHtml(value);
  return html.replace(/(["'])\/api\/article-images\//gu, `$1${adminApiUrl("/api/article-images/")}`);
}

async function uploadArticleImage(file: File) {
  const form = new FormData();
  form.append("file", file, file.name || "article-image");
  const image = await adminApiFetch<{ location: string }>("/api/ingestion/article-images", { method: "POST", body: form });
  return adminApiUrl(image.location);
}

function ToolButton({ label, active = false, disabled = false, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className={active ? "active" : ""} aria-label={label} title={label} aria-pressed={active || undefined} disabled={disabled} onClick={onClick}>{children}</button>;
}

export function ArticleEditor({ value, onChange, onReady }: { value: string; onChange: (value: string) => void; onReady?: (value: string) => void }) {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const lastEmitted = useRef(portableImageUrls(editorValue(value)));
  const readyCalled = useRef(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageError, setImageError] = useState("");
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
      Image.configure({ inline: false, allowBase64: false }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Table.configure({ resizable: false }), TableRow, TableHeader, TableCell
    ],
    content: editorValue(value),
    editorProps: { attributes: { class: "article-editor-content", "aria-label": "正文内容" } },
    onCreate: ({ editor: current }) => {
      const content = portableImageUrls(current.getHTML());
      lastEmitted.current = content;
      if (!readyCalled.current) { readyCalled.current = true; onReady?.(content); }
    },
    onUpdate: ({ editor: current }) => {
      const content = portableImageUrls(current.getHTML());
      lastEmitted.current = content;
      onChange(content);
    }
  });

  useEffect(() => {
    if (!editor || value === lastEmitted.current) return;
    const content = editorValue(value);
    editor.commands.setContent(content, false);
    lastEmitted.current = portableImageUrls(editor.getHTML());
  }, [editor, value]);

  if (!editor) return <div className="article-editor-loading" role="status">正在准备正文编辑器...</div>;

  const setLink = () => {
    const previous = editor.getAttributes("link").href as string | undefined;
    const href = window.prompt("请输入链接地址", previous || "https://");
    if (href === null) return;
    if (!href.trim()) { editor.chain().focus().extendMarkRange("link").unsetLink().run(); return; }
    try {
      const parsed = new URL(href.trim());
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
      editor.chain().focus().extendMarkRange("link").setLink({ href: parsed.toString(), target: "_blank", rel: "noopener noreferrer" }).run();
    } catch { window.alert("链接必须是有效的 HTTP 或 HTTPS 地址"); }
  };

  const insertImages = async (files: File[], position?: number) => {
    if (!files.length) return;
    setUploadingImage(true); setImageError("");
    let inserted = 0;
    try {
      for (const file of files) {
        const src = await uploadArticleImage(file);
        if (position === undefined) {
          editor.chain().focus().setImage({ src, alt: file.name || "正文图片" }).run();
        } else {
          const insertAt = Math.min(position + inserted, editor.state.doc.content.size);
          editor.commands.insertContentAt(insertAt, { type: "image", attrs: { src, alt: file.name || "粘贴图片" } });
        }
        inserted += 1;
      }
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : "图片上传失败";
      setImageError(inserted ? `已插入 ${inserted} 张图片，后续图片上传失败：${detail}` : detail);
    } finally {
      setUploadingImage(false);
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  };

  const pasteImages = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void insertImages(files, editor.state.selection.from);
  };

  return <div className="article-editor" onPasteCapture={pasteImages}>
    <div className="article-editor-toolbar" role="toolbar" aria-label="正文格式工具">
      <div className="article-editor-tool-group">
        <ToolButton label="撤销" disabled={!editor.can().chain().focus().undo().run()} onClick={() => editor.chain().focus().undo().run()}><Undo2 size={17} /></ToolButton>
        <ToolButton label="重做" disabled={!editor.can().chain().focus().redo().run()} onClick={() => editor.chain().focus().redo().run()}><Redo2 size={17} /></ToolButton>
      </div>
      <div className="article-editor-tool-group">
        <ToolButton label="一级标题" active={editor.isActive("heading", { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 size={17} /></ToolButton>
        <ToolButton label="二级标题" active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={17} /></ToolButton>
        <ToolButton label="粗体" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={17} /></ToolButton>
        <ToolButton label="斜体" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={17} /></ToolButton>
        <ToolButton label="下划线" active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}><UnderlineIcon size={17} /></ToolButton>
        <label className="article-editor-color-tool" title="文字颜色"><span className="sr-only">文字颜色</span><input type="color" aria-label="文字颜色" defaultValue="#dbe7f5" onChange={(event) => editor.chain().focus().setColor(event.target.value).run()} /></label>
        <ToolButton label="文字高亮" active={editor.isActive("highlight")} onClick={() => editor.chain().focus().toggleHighlight({ color: "#31506f" }).run()}><Highlighter size={17} /></ToolButton>
      </div>
      <div className="article-editor-tool-group">
        <ToolButton label="项目符号列表" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={17} /></ToolButton>
        <ToolButton label="编号列表" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered size={17} /></ToolButton>
        <ToolButton label="左对齐" active={editor.isActive({ textAlign: "left" })} onClick={() => editor.chain().focus().setTextAlign("left").run()}><AlignLeft size={17} /></ToolButton>
        <ToolButton label="居中" active={editor.isActive({ textAlign: "center" })} onClick={() => editor.chain().focus().setTextAlign("center").run()}><AlignCenter size={17} /></ToolButton>
        <ToolButton label="右对齐" active={editor.isActive({ textAlign: "right" })} onClick={() => editor.chain().focus().setTextAlign("right").run()}><AlignRight size={17} /></ToolButton>
      </div>
      <div className="article-editor-tool-group">
        <ToolButton label="添加链接" active={editor.isActive("link")} onClick={setLink}><Link2 size={17} /></ToolButton>
        <ToolButton label="移除链接" disabled={!editor.isActive("link")} onClick={() => editor.chain().focus().unsetLink().run()}><Unlink size={17} /></ToolButton>
        <ToolButton label="上传正文图片" disabled={uploadingImage} onClick={() => imageInputRef.current?.click()}><ImagePlus size={17} /></ToolButton>
        <ToolButton label="插入表格" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><Table2 size={17} /></ToolButton>
        <ToolButton label="行内代码" active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()}><Code2 size={17} /></ToolButton>
        <ToolButton label="清除格式" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}><RemoveFormatting size={17} /></ToolButton>
      </div>
      <input ref={imageInputRef} className="sr-only" type="file" accept="image/png,image/jpeg,image/gif,image/webp" tabIndex={-1} onChange={(event) => void insertImages(event.target.files?.[0] ? [event.target.files[0]] : [])} />
    </div>
    {imageError && <div className="article-editor-inline-error" role="alert">{imageError}</div>}
    <EditorContent editor={editor} />
    <div className="article-editor-status"><span>{uploadingImage ? "正在压缩并上传图片..." : "自动保留当前编辑内容，点击页面上方按钮完成保存"}</span><span>{editor.storage.characterCount?.characters?.() ?? editor.getText().length} 字</span></div>
  </div>;
}
