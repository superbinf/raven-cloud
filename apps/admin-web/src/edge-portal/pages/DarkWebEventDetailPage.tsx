import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CircleAlert,
  Database,
  Download,
  ExternalLink,
  Eye,
  FileSearch,
  FileSpreadsheet,
  FileText,
  X,
} from "lucide-react";
import {
  type DarkWebEventDetail,
  type DarkWebFilePreview,
  type DarkWebFileRecord,
} from "@sentinel/shared";
import { Button, EmptyState, IconButton, Panel, Tag } from "@/components/ui";

import { readPortalSession } from "../app/PortalShell";
import {
  portalApiFetch as apiFetch,
  portalApiRequestHeaders,
  portalApiUrl,
} from "../shared/api/portalApi";
import { EMPTY_DATA_DESCRIPTION, EMPTY_DATA_TITLE } from "../shared/emptyState";
import {
  SortableResizableHeader,
  sortListItems,
  useListViewPreferences,
  type ListViewColumn,
} from "../shared/ListViewControls";
import { PageSizeSelect } from "../shared/PageSizeSelect";

function displayDarkWebDate(value: string) {
  if (!value) return "--";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value.replace("T", " ").slice(0, 19)
    : parsed.toLocaleString("zh-CN", { hour12: false });
}

function httpLink(value: string) {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol)
      ? parsed.toString()
      : "";
  } catch {
    return "";
  }
}

function markdownInline(value: string): ReactNode[] {
  return value
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith("**") && part.endsWith("**"))
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      if (part.startsWith("`") && part.endsWith("`"))
        return <code key={index}>{part.slice(1, -1)}</code>;
      return part;
    });
}

function industryArticleContent(value: string, fallback: string) {
  const lines = String(value || fallback)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line, index) => {
    if (/^###\s+/.test(line))
      return (
        <h3 key={`${index}-${line}`}>
          {markdownInline(line.replace(/^###\s+/, ""))}
        </h3>
      );
    if (/^##\s+/.test(line))
      return (
        <h2 key={`${index}-${line}`}>
          {markdownInline(line.replace(/^##\s+/, ""))}
        </h2>
      );
    if (/^#\s+/.test(line))
      return (
        <h1 key={`${index}-${line}`}>
          {markdownInline(line.replace(/^#\s+/, ""))}
        </h1>
      );
    if (/^[-*]\s+/.test(line))
      return (
        <li key={`${index}-${line}`}>
          {markdownInline(line.replace(/^[-*]\s+/, ""))}
        </li>
      );
    if (/^\d+\.\d+[.、\s]/.test(line))
      return <h3 key={`${index}-${line}`}>{markdownInline(line)}</h3>;
    if (/^(?:\d+[.、]|[一二三四五六七八九十]+、)/.test(line))
      return <h2 key={`${index}-${line}`}>{markdownInline(line)}</h2>;
    return <p key={`${index}-${line}`}>{markdownInline(line)}</p>;
  });
}

function safeArticleHtml(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  const removableTags = new Set([
    "SCRIPT",
    "STYLE",
    "IFRAME",
    "OBJECT",
    "EMBED",
    "FORM",
    "INPUT",
    "BUTTON",
    "SVG",
    "MATH",
  ]);
  const allowedTags = new Set([
    "A",
    "P",
    "BR",
    "STRONG",
    "B",
    "EM",
    "I",
    "U",
    "S",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "UL",
    "OL",
    "LI",
    "TABLE",
    "THEAD",
    "TBODY",
    "TFOOT",
    "TR",
    "TH",
    "TD",
    "BLOCKQUOTE",
    "PRE",
    "CODE",
    "HR",
    "SPAN",
    "DIV",
    "IMG",
  ]);
  const allowedStyleProperties = new Set([
    "color",
    "background-color",
    "text-align",
  ]);
  for (const element of Array.from(document.body.querySelectorAll("*"))) {
    if (removableTags.has(element.tagName)) {
      element.remove();
      continue;
    }
    if (!allowedTags.has(element.tagName)) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name === "style") {
        const safeStyle = attribute.value
          .split(";")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => {
            const [property, ...rawValue] = entry.split(":");
            const value = rawValue.join(":").trim();
            return allowedStyleProperties.has(property.trim().toLowerCase()) &&
              !/url\s*\(|expression\s*\(/i.test(value)
              ? `${property.trim()}: ${value}`
              : "";
          })
          .filter(Boolean)
          .join("; ");
        if (safeStyle) element.setAttribute("style", safeStyle);
        else element.removeAttribute("style");
      } else if (
        !(
          element.tagName === "A" &&
          ["href", "title", "target", "rel"].includes(name)
        ) &&
        !(
          element.tagName === "IMG" &&
          ["src", "alt", "title", "width", "height"].includes(name)
        ) &&
        !["colspan", "rowspan"].includes(name)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.tagName === "A") {
      const href = element.getAttribute("href") || "";
      if (!/^(https?:|mailto:)/i.test(href)) element.removeAttribute("href");
      element.setAttribute("rel", "noreferrer noopener nofollow");
      if (element.getAttribute("target") === "_blank")
        element.setAttribute("target", "_blank");
      else element.removeAttribute("target");
    }
    if (element.tagName === "IMG") {
      const source = element.getAttribute("src") || "";
      if (
        !/^\/api\/article-images\/[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/i.test(
          source,
        )
      ) {
        element.remove();
        continue;
      }
      for (const dimension of ["width", "height"])
        if (
          element.hasAttribute(dimension) &&
          !/^\d{1,4}$/.test(element.getAttribute(dimension) || "")
        )
          element.removeAttribute(dimension);
      element.setAttribute("loading", "lazy");
      element.setAttribute("decoding", "async");
    }
  }
  return document.body.innerHTML;
}

function extractIndustryBodyHtml(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  const body = document.body;
  const firstHeading = body.querySelector("h1") || body.querySelector("h2");
  if (!firstHeading) return "";
  while (body.firstChild && body.firstChild !== firstHeading)
    body.firstChild.remove();
  let section = 0;
  let subsection = 0;
  body.querySelectorAll("h1,h2").forEach((heading) => {
    const title = heading.textContent?.trim() || "";
    if (!title) return;
    if (heading.tagName === "H1") {
      section += 1;
      subsection = 0;
      heading.textContent = `${section}. ${title.replace(/^\d+[.、]\s*/, "")}`;
    } else {
      subsection += 1;
      heading.textContent = `${section}.${subsection}. ${title.replace(/^\d+(?:\.\d+)?[.、]\s*/, "")}`;
    }
  });
  return body.innerHTML;
}

function spreadsheetColumnLabel(index: number) {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

export function DarkWebEventDetailPage() {
  const { id = "" } = useParams();
  const canDownloadEvidence =
    readPortalSession()?.permissions.includes("evidence:download") ?? false;
  const [detail, setDetail] = useState<DarkWebEventDetail | null | undefined>(
    undefined,
  );
  const [previewFile, setPreviewFile] = useState<DarkWebFileRecord | null>(
    null,
  );
  const [preview, setPreview] = useState<DarkWebFilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPageSize, setPreviewPageSize] = useState(50);
  const [industryBodyHtml, setIndustryBodyHtml] = useState<string | null>(null);
  const [error, setError] = useState("");
  const previewRequestRef = useRef(0);

  useEffect(() => {
    let active = true;
    setDetail(undefined);
    setError("");
    apiFetch<DarkWebEventDetail>(
      `/api/dark-web/events/${encodeURIComponent(id)}`,
    )
      .then((data) => {
        if (active) setDetail(data);
      })
      .catch((reason) => {
        if (active) {
          setDetail(null);
          setError(
            reason instanceof Error ? reason.message : "事件详情加载失败",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [id]);

  useEffect(() => {
    let active = true;
    if (!detail) {
      setIndustryBodyHtml("");
      return () => {
        active = false;
      };
    }
    const industryOnly =
      detail.intelTags?.includes("行业情报") &&
      !detail.intelTags.includes("数据泄露");
    const report = industryOnly
      ? detail.files.find(
          (file) => file.kind === "report" && file.cached !== false,
        )
      : undefined;
    setIndustryBodyHtml(industryOnly && report ? null : "");
    if (industryOnly && report) {
      apiFetch<DarkWebFilePreview>(
        `/api/dark-web/events/${encodeURIComponent(detail.id)}/files/${encodeURIComponent(report.id)}/preview`,
      )
        .then((result) => {
          if (active)
            setIndustryBodyHtml(
              result.kind === "word"
                ? extractIndustryBodyHtml(result.html)
                : "",
            );
        })
        .catch(() => {
          if (active) setIndustryBodyHtml("");
        });
    }
    return () => {
      active = false;
    };
  }, [detail]);

  const loadPreview = async (
    file: DarkWebFileRecord,
    sheet = 0,
    previewPage = 1,
    requestedPageSize = previewPageSize,
  ) => {
    if (!detail) return;
    const requestId = ++previewRequestRef.current;
    setPreviewFile(file);
    setPreview(null);
    setPreviewLoading(true);
    setError("");
    try {
      const params =
        file.kind === "attachment"
          ? `?sheet=${sheet}&page=${previewPage}&page_size=${requestedPageSize}`
          : "";
      const result = await apiFetch<DarkWebFilePreview>(
        `/api/dark-web/events/${encodeURIComponent(detail.id)}/files/${encodeURIComponent(file.id)}/preview${params}`,
      );
      if (previewRequestRef.current === requestId) setPreview(result);
    } catch (reason) {
      if (previewRequestRef.current === requestId)
        setError(reason instanceof Error ? reason.message : "文件预览加载失败");
    } finally {
      if (previewRequestRef.current === requestId) setPreviewLoading(false);
    }
  };

  const closePreview = () => {
    previewRequestRef.current += 1;
    setPreviewFile(null);
    setPreview(null);
    setPreviewLoading(false);
  };

  const changePreviewPageSize = (value: number) => {
    setPreviewPageSize(value);
    if (preview?.kind === "spreadsheet") {
      void loadPreview(preview.file, preview.sheetIndex, 1, value);
    }
  };

  const downloadEvidence = async (
    eventId: string,
    fileId: string,
    name: string,
  ) => {
    const response = await fetch(
      portalApiUrl(
        `/api/dark-web/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(fileId)}/content`,
      ),
      { credentials: "same-origin", headers: portalApiRequestHeaders() },
    );
    if (!response.ok)
      throw new Error(
        (await response.json().catch(() => null))?.message ?? "文件下载失败",
      );
    const objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = name;
    link.click();
    URL.revokeObjectURL(objectUrl);
  };

  const spreadsheetPreview = preview?.kind === "spreadsheet" ? preview : null;
  const previewColumns = useMemo<ListViewColumn[]>(
    () =>
      Array.from(
        { length: spreadsheetPreview?.displayedColumns || 0 },
        (_, index) => ({
          id: `column-${index + 1}`,
          label: spreadsheetColumnLabel(index),
          defaultWidth: 180,
          minWidth: 72,
        }),
      ),
    [spreadsheetPreview?.displayedColumns],
  );
  const previewTableView = useListViewPreferences(
    `darkweb-sheet-${spreadsheetPreview?.sheetIndex ?? 0}`,
    previewColumns,
  );
  const sortedPreviewRows = sortListItems(
    spreadsheetPreview?.rows || [],
    previewTableView.sort,
    Object.fromEntries(
      previewColumns.map((column, index) => [
        column.id,
        (row: string[]) => row[index] ?? "",
      ]),
    ),
  );

  if (detail === undefined)
    return (
      <div className="portal-container page-content">
        <div className="detail-loading" />
      </div>
    );
  if (!detail)
    return (
      <div className="portal-container page-content">
        <Link className="back-link" to="/portal/modules/dark-web/intelligence">
          <ArrowLeft size={16} />
          返回暗网情报
        </Link>
        <EmptyState
          title={error ? "事件详情加载失败" : EMPTY_DATA_TITLE}
          description={error || EMPTY_DATA_DESCRIPTION}
        />
      </div>
    );
  const isIndustryArticle =
    detail.intelTags?.includes("行业情报") &&
    !detail.intelTags.includes("数据泄露");

  return (
    <div className={`portal-container page-content darkweb-event-detail-page${isIndustryArticle ? " industry-intel-detail-page" : ""}`}>
      <Link className="back-link" to="/portal/modules/dark-web/intelligence">
        <ArrowLeft size={16} />
        返回暗网情报
      </Link>
      {error && (
        <div className="darkweb-leak-error" role="alert">
          <CircleAlert size={17} />
          {error}
        </div>
      )}
      <header className="detail-heading">
        <div className="detail-title">
          <span className="darkweb-detail-mark">
            <Database size={20} />
          </span>
          <div>
            <span>{detail.id}</span>
            <h1>{detail.title}</h1>
          </div>
        </div>
        <div className="detail-status">
          <span>
            首次发现 <strong>{displayDarkWebDate(detail.firstSeenAt)}</strong>
          </span>
          {(detail.intelTags || ["数据泄露"]).map((tag) => (
            <Tag tone={tag === "数据泄露" ? "pink" : "cyan"} key={tag}>
              {tag}
            </Tag>
          ))}
          {detail.repeatedPropagationCount > 0 && (
            <Tag tone="pink">关联传播 {detail.repeatedPropagationCount}</Tag>
          )}
        </div>
      </header>
      <div className="detail-layout">
        <section className="detail-main panel">
          <div className="detail-tab-content darkweb-detail-content">
            <h2>情报说明</h2>
            <p className="darkweb-event-note">
              {detail.intelNote || "未提供说明"}
            </p>
            {(detail.articleMarkdown || isIndustryArticle) && (
              <section
                className="industry-intel-article"
                aria-label={`${detail.title}正文`}
              >
                <h2>情报正文</h2>
                {detail.articleMarkdown ? (
                  /^\s*</.test(detail.articleMarkdown) ? (
                    <div
                      className="industry-intel-body"
                      dangerouslySetInnerHTML={{
                        __html: safeArticleHtml(detail.articleMarkdown),
                      }}
                    />
                  ) : (
                    <div className="industry-intel-body">
                      {industryArticleContent(detail.articleMarkdown, detail.title)}
                    </div>
                  )
                ) : industryBodyHtml === null ? (
                  <div
                    className="industry-intel-loading"
                    aria-label="正在加载行业情报正文"
                  />
                ) : industryBodyHtml ? (
                  <div
                    className="industry-intel-body"
                    dangerouslySetInnerHTML={{
                      __html: safeArticleHtml(industryBodyHtml),
                    }}
                  />
                ) : (
                  <div className="industry-intel-body">
                    {industryArticleContent(detail.intelNote, detail.title)}
                  </div>
                )}
              </section>
            )}
            <h2>来源定位</h2>
            <div className="darkweb-source-list">
              <div>
                <span>来源群</span>
                {httpLink(detail.sourceGroupUrl) ? (
                  <a
                    href={httpLink(detail.sourceGroupUrl)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {detail.sourceGroupName || detail.sourceGroupUrl}
                    <ExternalLink size={14} />
                  </a>
                ) : (
                  <strong>
                    {detail.sourceGroupName || detail.sourceGroupUrl || "--"}
                  </strong>
                )}
              </div>
              <div>
                <span>消息链接 / 原文</span>
                {httpLink(detail.messageUrl) ? (
                  <a
                    href={httpLink(detail.messageUrl)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {detail.messageUrl}
                    <ExternalLink size={14} />
                  </a>
                ) : (
                  <strong>{detail.messageUrl || "--"}</strong>
                )}
              </div>
            </div>
            <div className="darkweb-evidence-heading">
              <h2>证据文件</h2>
              <span>{detail.files.length} 个文件</span>
            </div>
            {detail.files.length ? (
              <div className="darkweb-file-list">
                {detail.files.map((file) => {
                  const cached = file.cached !== false;
                  const FileIcon =
                    file.kind === "attachment" ? FileSpreadsheet : FileText;
                  return (
                    <article className="darkweb-file-row" key={file.id}>
                      <span className="darkweb-file-icon">
                        <FileIcon size={22} />
                      </span>
                      <div className="darkweb-file-info">
                        <div className="darkweb-file-title">
                          <span>
                            {file.kind === "attachment"
                              ? "数据附件"
                              : "事件报告"}
                          </span>
                          <strong>{file.name}</strong>
                        </div>
                        <div className="darkweb-file-meta">
                          <span>{(file.sizeBytes / 1024).toFixed(1)} KB</span>
                          {file.kind === "attachment" && (
                            <>
                              <span>{file.sheetCount} 个工作表</span>
                              <span>{file.rowCount} 个非空行</span>
                              <span>最大 {file.columnCount} 列</span>
                            </>
                          )}
                        </div>
                        <code title={`SHA-256 ${file.sha256}`}>
                          SHA-256&nbsp; {file.sha256}
                        </code>
                      </div>
                      <div className="darkweb-file-actions">
                        {cached && canDownloadEvidence ? (
                          <>
                            <Button
                              variant="secondary"
                              onClick={() => void loadPreview(file)}
                            >
                              <Eye size={16} />
                              预览
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() =>
                                void downloadEvidence(
                                  detail.id,
                                  file.id,
                                  file.name,
                                ).catch((reason) => setError(reason.message))
                              }
                            >
                              <Download size={16} />
                              下载
                            </Button>
                          </>
                        ) : (
                          <span className="darkweb-file-no-access">
                            {cached ? "无证据查看权限" : "本地未缓存"}
                          </span>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                icon={<FileSearch size={32} />}
                title="暂无证据文件"
              />
            )}
          </div>
        </section>
        <aside className="detail-aside">
          <Panel title="事件信息">
            <dl className="metadata">
              <div>
                <dt>报告日期</dt>
                <dd>{detail.reportDate || "--"}</dd>
              </div>
              <div>
                <dt>发布时间</dt>
                <dd>{displayDarkWebDate(detail.publishedAt)}</dd>
              </div>
              <div>
                <dt>泄露类型</dt>
                <dd>{detail.leakDataTypes || "--"}</dd>
              </div>
              <div>
                <dt>泄露数量</dt>
                <dd>{detail.leakCount || "--"}</dd>
              </div>
              <div>
                <dt>来源群 ID</dt>
                <dd>{detail.sourceGroupId || "--"}</dd>
              </div>
              <div>
                <dt>发布人 ID</dt>
                <dd>{detail.publisherId || "--"}</dd>
              </div>
              <div>
                <dt>交易次数</dt>
                <dd>{detail.transactionCount || "--"}</dd>
              </div>
              <div>
                <dt>交易价格</dt>
                <dd>{detail.transactionPrice || "--"}</dd>
              </div>
            </dl>
          </Panel>
        </aside>
      </div>
      {previewFile && (
        <div
          className="darkweb-preview-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`${previewFile.name} 在线预览`}
          onClick={closePreview}
        >
          <article
            className="darkweb-preview-card"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>在线预览</span>
                <h2>{previewFile.name}</h2>
              </div>
              <IconButton label="关闭文件预览" onClick={closePreview}>
                <X size={18} />
              </IconButton>
            </header>
            {previewLoading && !preview ? (
              <div className="darkweb-preview-loading">正在解析文件...</div>
            ) : preview?.kind === "word" ? (
              <div className="darkweb-word-preview">
                <div dangerouslySetInnerHTML={{ __html: preview.html }} />
                {preview.truncated && (
                  <p className="darkweb-preview-notice">
                    文档内容过长，在线预览已截断；可下载原文件查看完整内容。
                  </p>
                )}
              </div>
            ) : preview?.kind === "spreadsheet" ? (
              <div className="darkweb-sheet-preview">
                <div className="darkweb-sheet-toolbar">
                  <label>
                    工作表
                    <select
                      value={preview.sheetIndex}
                      onChange={(event) =>
                        void loadPreview(
                          preview.file,
                          Number(event.target.value),
                          1,
                        )
                      }
                    >
                      {preview.sheets.map((sheet, index) => (
                        <option value={index} key={`${sheet.name}-${index}`}>
                          {sheet.name}（{sheet.rowCount} 行 ×{" "}
                          {sheet.columnCount} 列）
                        </option>
                      ))}
                    </select>
                  </label>
                  <span>
                    第 {preview.page} / {preview.totalPages} 页 · 共{" "}
                    {preview.totalRows} 个非空行
                    {preview.columnsTruncated ? " · 仅展示前 100 列" : ""}
                  </span>
                </div>
                <div className="darkweb-sheet-table-wrap">
                  <table>
                    <colgroup>
                      <col style={{ width: 72 }} />
                      {previewColumns.map((column) => (
                        <col
                          key={column.id}
                          style={{ width: previewTableView.columnWidth(column.id) }}
                        />
                      ))}
                    </colgroup>
                    <thead>
                      <tr>
                        <th>#</th>
                        {previewColumns.map((column) => (
                          <th key={column.id}>
                            <SortableResizableHeader
                              column={column}
                              sort={previewTableView.sort}
                              width={previewTableView.columnWidth(column.id)}
                              onSort={previewTableView.toggleSort}
                              onResize={previewTableView.setColumnWidth}
                            />
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedPreviewRows.map((row, rowIndex) => (
                        <tr key={`${preview.page}-${rowIndex}`}>
                          <th>
                            {(preview.page - 1) * preview.pageSize +
                              rowIndex +
                              1}
                          </th>
                          {Array.from(
                            { length: preview.displayedColumns },
                            (_, columnIndex) => (
                              <td key={columnIndex}>
                                {row[columnIndex] ?? ""}
                              </td>
                            ),
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!preview.rows.length && (
                    <div className="darkweb-preview-empty">
                      当前工作表没有可预览的数据
                    </div>
                  )}
                </div>
                <footer>
                  <PageSizeSelect
                    value={previewPageSize}
                    options={[10, 20, 50, 100]}
                    disabled={previewLoading}
                    onChange={changePreviewPageSize}
                  />
                  <Button
                    variant="ghost"
                    disabled={preview.page <= 1 || previewLoading}
                    onClick={() =>
                      void loadPreview(
                        preview.file,
                        preview.sheetIndex,
                        preview.page - 1,
                      )
                    }
                  >
                    上一页
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={
                      preview.page >= preview.totalPages || previewLoading
                    }
                    onClick={() =>
                      void loadPreview(
                        preview.file,
                        preview.sheetIndex,
                        preview.page + 1,
                      )
                    }
                  >
                    下一页
                  </Button>
                </footer>
              </div>
            ) : (
              <div className="darkweb-preview-loading">无法加载文件预览</div>
            )}
            {previewLoading && preview && (
              <div className="darkweb-preview-updating">正在加载...</div>
            )}
          </article>
        </div>
      )}
    </div>
  );
}
