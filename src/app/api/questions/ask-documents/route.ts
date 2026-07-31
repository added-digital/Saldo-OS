import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import mammoth from "mammoth";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type AskDocumentsBody = {
  question?: string;
};

type AskDocumentsInput = {
  question: string;
  attachmentContext: string;
  attachmentSources: SourceRow[];
};

type OpenAiSqlResponse = {
  sql: string;
  raw_response?: string;
};

type ResponsesTextContent = {
  type?: string;
  text?: string;
};

type ResponsesOutputItem = {
  type?: string;
  content?: ResponsesTextContent[];
};

type ResponsesPayload = {
  output_text?: string;
  output?: ResponsesOutputItem[];
};

type EmbeddingResponse = {
  data?: Array<{
    embedding?: number[];
    index?: number;
  }>;
};

type ChunkSearchRow = {
  chunk_id: string;
  document_id: string;
  chunk_text: string;
  file_name: string;
  document_type: string | null;
  similarity: number;
  storage_path: string;
};

type SourceRow = {
  file_name: string;
  document_type: string | null;
  similarity: number;
};

type PdfParserErrorEvent = Error | { parserError: Error };

type DirectChunkRow = {
  id: string;
  document_id: string;
  chunk_text: string;
  embedding: unknown;
  documents:
    | {
        id: string;
        file_name: string;
        document_type: string | null;
        storage_path: string;
      }
    | null;
};

const ALLOWED_TABLES = new Set([
  "customers",
  "profiles",
  "teams",
  "invoices",
  "time_reports",
  "contract_accruals",
  "customer_kpis",
  "customer_segments",
  "segments",
]);

const CRM_ENABLED_ROLES = new Set(["admin", "team_lead", "user"]);
const CRM_CUSTOMER_SCOPED_ROLES = new Set(["team_lead", "user"]);
const FORBIDDEN_SQL_COLUMN_PATTERN = /\b(email|phone|linkedin|notes)\b/i;

type FinancialReportWindow = {
  month: number;
  year: number;
};

type RollingWindowPreset = "last-12-months" | "current-year";

type MonthToken = {
  month: number;
  index: number;
};

const REPORTING_KEYWORDS = [
  "report",
  "rapport",
  "financial",
  "ekonom",
  "omsattning",
  "omsättning",
  "turnover",
  "revenue",
  "intakt",
  "intäkt",
  "invoice",
  "faktura",
  "kpi",
  "resultat",
  "budget",
  "cost",
  "kostnad",
  "hours",
  "timmar",
  "contract",
  "kontrakt",
  "customer",
  "customers",
  "kund",
  "kunder",
  "tjanat",
  "tjänat",
  "fakturerat",
  "fakturering",
];

function toVectorString(values: number[]): string {
  return `[${values.join(",")}]`;
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function getFileExtension(fileName: string): string {
  const parts = fileName.toLowerCase().split(".");
  if (parts.length < 2) return "";
  return parts[parts.length - 1];
}

function getFileKind(fileName: string, fileType: string): "pdf" | "docx" | "txt" | "unsupported" {
  const normalizedType = fileType.toLowerCase();
  const extension = getFileExtension(fileName);

  if (normalizedType === "application/pdf" || extension === "pdf") return "pdf";
  if (
    normalizedType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    extension === "docx"
  ) {
    return "docx";
  }
  if (normalizedType.startsWith("text/") || extension === "txt" || extension === "md") return "txt";

  return "unsupported";
}

async function extractTextFromAttachment(input: {
  fileBuffer: Buffer;
  fileName: string;
  fileType: string;
}): Promise<string> {
  const kind = getFileKind(input.fileName, input.fileType);

  if (kind === "pdf") {
    const PDFParser = (await import("pdf2json")).default;
    return new Promise((resolve, reject) => {
      const parser = new PDFParser(null, true);
      parser.on("pdfParser_dataError", (err: PdfParserErrorEvent) => {
        if (err instanceof Error) {
          reject(err);
          return;
        }
        reject(err.parserError);
      });
      parser.on("pdfParser_dataReady", () => {
        resolve(normalizeWhitespace(parser.getRawTextContent()));
      });
      parser.parseBuffer(input.fileBuffer);
    });
  }

  if (kind === "docx") {
    const result = await mammoth.extractRawText({ buffer: input.fileBuffer });
    return normalizeWhitespace(result.value ?? "");
  }

  if (kind === "txt") {
    return normalizeWhitespace(input.fileBuffer.toString("utf8"));
  }

  return "";
}

async function parseAskDocumentsInput(request: Request): Promise<AskDocumentsInput> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const question = normalizeWhitespace(String(formData.get("question") ?? ""));
    const files = formData.getAll("files").filter((entry): entry is File => entry instanceof File);

    const attachmentParts: string[] = [];
    const attachmentSources: SourceRow[] = [];

    for (const file of files) {
      const fileBuffer = Buffer.from(await file.arrayBuffer());
      const extracted = await extractTextFromAttachment({
        fileBuffer,
        fileName: file.name,
        fileType: file.type || "application/octet-stream",
      });

      if (!extracted) continue;

      attachmentParts.push([
        `Attachment file: ${file.name}`,
        "Attachment document type: Chat attachment",
        `Attachment content: ${extracted}`,
      ].join("\n"));

      attachmentSources.push({
        file_name: file.name,
        document_type: "Chat attachment",
        similarity: 1,
      });
    }

    return {
      question,
      attachmentContext: attachmentParts.join("\n\n"),
      attachmentSources,
    };
  }

  const body = (await request.json()) as AskDocumentsBody;
  return {
    question: normalizeWhitespace(body.question ?? ""),
    attachmentContext: "",
    attachmentSources: [],
  };
}

async function readDbContext(): Promise<string> {
  const filePath = path.join(
    process.cwd(),
    "src/app/api/questions/ask-sql/db-context.md",
  );

  return readFile(filePath, "utf8");
}

function toSafeUuidLiteral(value: string | null | undefined): string {
  if (!value) return "NULL";

  const trimmed = value.trim();
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!uuidPattern.test(trimmed)) return "NULL";

  return `'${trimmed}'`;
}

function toSafeTextLiteral(value: string | null | undefined): string {
  if (!value) return "NULL";
  const trimmed = value.trim();
  if (!trimmed) return "NULL";
  return `'${trimmed.replace(/'/g, "''")}'`;
}

function toSqlLikeLiteral(value: string): string {
  const escaped = value.trim().replace(/'/g, "''").replace(/[%_]/g, "\\$&");
  return `'%${escaped}%'`;
}

function parseFinancialReportWindow(question: string): FinancialReportWindow | null {
  const normalized = question.toLowerCase();

  const monthPatterns: Array<{ month: number; patterns: string[] }> = [
    { month: 1, patterns: ["january", "jan", "januari"] },
    { month: 2, patterns: ["february", "feb", "februari"] },
    { month: 3, patterns: ["march", "mar", "mars"] },
    { month: 4, patterns: ["april", "apr"] },
    { month: 5, patterns: ["may", "maj"] },
    { month: 6, patterns: ["june", "jun", "juni"] },
    { month: 7, patterns: ["july", "jul", "juli"] },
    { month: 8, patterns: ["august", "aug"] },
    { month: 9, patterns: ["september", "sep", "sept"] },
    { month: 10, patterns: ["october", "oct", "oktober", "okt"] },
    { month: 11, patterns: ["november", "nov"] },
    { month: 12, patterns: ["december", "dec", "december", "dec"] },
  ];

  let detectedMonth: number | null = null;
  for (const monthPattern of monthPatterns) {
    if (monthPattern.patterns.some((pattern) => new RegExp(`\\b${pattern}\\b`, "i").test(normalized))) {
      detectedMonth = monthPattern.month;
      break;
    }
  }

  if (!detectedMonth) {
    return null;
  }

  const detectedYear = normalized.match(/\b(20\d{2})\b/)?.[1];
  const year = detectedYear ? Number(detectedYear) : new Date().getUTCFullYear();

  return {
    month: detectedMonth,
    year,
  };
}

function getMonthTokensInQuestion(question: string): MonthToken[] {
  const normalized = question.toLowerCase();

  const monthTokenPatterns: Array<{ month: number; patterns: string[] }> = [
    { month: 1, patterns: ["january", "jan", "januari"] },
    { month: 2, patterns: ["february", "feb", "februari"] },
    { month: 3, patterns: ["march", "mar", "mars"] },
    { month: 4, patterns: ["april", "apr"] },
    { month: 5, patterns: ["may", "maj"] },
    { month: 6, patterns: ["june", "jun", "juni"] },
    { month: 7, patterns: ["july", "jul", "juli"] },
    { month: 8, patterns: ["august", "aug"] },
    { month: 9, patterns: ["september", "sep", "sept"] },
    { month: 10, patterns: ["october", "oct", "oktober", "okt"] },
    { month: 11, patterns: ["november", "nov"] },
    { month: 12, patterns: ["december", "dec", "december", "dec"] },
  ];

  const tokens: MonthToken[] = [];
  for (const monthPattern of monthTokenPatterns) {
    for (const pattern of monthPattern.patterns) {
      const regex = new RegExp(`\\b${pattern}\\b`, "gi");
      let match = regex.exec(normalized);
      while (match) {
        tokens.push({
          month: monthPattern.month,
          index: match.index,
        });
        match = regex.exec(normalized);
      }
    }
  }

  return tokens.sort((a, b) => a.index - b.index);
}

function parseFinancialComparisonWindows(question: string): [FinancialReportWindow, FinancialReportWindow] | null {
  const tokens = getMonthTokensInQuestion(question);
  if (tokens.length < 2) {
    return null;
  }

  const uniqueMonthsInOrder: number[] = [];
  for (const token of tokens) {
    if (!uniqueMonthsInOrder.includes(token.month)) {
      uniqueMonthsInOrder.push(token.month);
    }
  }

  if (uniqueMonthsInOrder.length < 2) {
    return null;
  }

  const normalized = question.toLowerCase();
  const detectedYear = normalized.match(/\b(20\d{2})\b/)?.[1];
  const year = detectedYear ? Number(detectedYear) : new Date().getUTCFullYear();

  return [
    { month: uniqueMonthsInOrder[0], year },
    { month: uniqueMonthsInOrder[1], year },
  ];
}

function isReportingQuestion(question: string): boolean {
  const normalized = question
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  return REPORTING_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function buildGeneralReportFallbackSql(input: {
  role: string;
}): string {
  if (CRM_CUSTOMER_SCOPED_ROLES.has(input.role)) {
    return [
      "WITH scoped_customers AS (",
      "  SELECT id, fortnox_customer_number",
      "  FROM customers",
      "  WHERE fortnox_cost_center = {user_cost_center}",
      "    AND (status = 'active' OR status IS NULL)",
      "),",
      "scoped_invoices AS (",
      "  SELECT i.*",
      "  FROM invoices i",
      "  INNER JOIN scoped_customers sc",
      "    ON sc.fortnox_customer_number = i.fortnox_customer_number",
      "),",
      "current_month AS (",
      "  SELECT *",
      "  FROM scoped_invoices",
      "  WHERE invoice_date >= date_trunc('month', now())::date",
      "    AND invoice_date < (date_trunc('month', now())::date + INTERVAL '1 month')",
      "),",
      "rolling_12 AS (",
      "  SELECT *",
      "  FROM scoped_invoices",
      "  WHERE invoice_date >= (date_trunc('month', now())::date - INTERVAL '12 months')",
      ")",
      "SELECT",
      "  (SELECT COUNT(*) FROM scoped_customers) AS active_customers,",
      "  (SELECT COUNT(*) FROM current_month) AS current_month_invoice_count,",
      "  (SELECT COALESCE(SUM(total_ex_vat), 0) FROM current_month) AS current_month_turnover_ex_vat,",
      "  (SELECT COALESCE(SUM(balance), 0) FROM current_month) AS current_month_outstanding_balance,",
      "  (SELECT COUNT(*) FROM rolling_12) AS rolling_12_invoice_count,",
      "  (SELECT COALESCE(SUM(total_ex_vat), 0) FROM rolling_12) AS rolling_12_turnover_ex_vat",
      "LIMIT 1",
    ].join("\n");
  }

  return [
    "WITH active_customers AS (",
    "  SELECT id, fortnox_customer_number",
    "  FROM customers",
    "  WHERE status = 'active' OR status IS NULL",
    "),",
    "active_invoices AS (",
    "  SELECT i.*",
    "  FROM invoices i",
    "  INNER JOIN active_customers c",
    "    ON c.fortnox_customer_number = i.fortnox_customer_number",
    "),",
    "current_month AS (",
    "  SELECT *",
    "  FROM active_invoices",
    "  WHERE invoice_date >= date_trunc('month', now())::date",
    "    AND invoice_date < (date_trunc('month', now())::date + INTERVAL '1 month')",
    "),",
    "rolling_12 AS (",
    "  SELECT *",
    "  FROM active_invoices",
    "  WHERE invoice_date >= (date_trunc('month', now())::date - INTERVAL '12 months')",
    ")",
    "SELECT",
    "  (SELECT COUNT(*) FROM active_customers) AS active_customers,",
    "  (SELECT COUNT(*) FROM current_month) AS current_month_invoice_count,",
    "  (SELECT COALESCE(SUM(total_ex_vat), 0) FROM current_month) AS current_month_turnover_ex_vat,",
    "  (SELECT COALESCE(SUM(balance), 0) FROM current_month) AS current_month_outstanding_balance,",
    "  (SELECT COUNT(*) FROM rolling_12) AS rolling_12_invoice_count,",
    "  (SELECT COALESCE(SUM(total_ex_vat), 0) FROM rolling_12) AS rolling_12_turnover_ex_vat",
    "LIMIT 1",
  ].join("\n");
}

function buildFinancialReportFallbackSql(input: {
  role: string;
  userCostCenter: string | null;
  window: FinancialReportWindow;
}): string {
  const monthStart = `${input.window.year}-${String(input.window.month).padStart(2, "0")}-01`;

  if (CRM_CUSTOMER_SCOPED_ROLES.has(input.role)) {
    return [
      "WITH scoped_customers AS (",
      "  SELECT fortnox_customer_number",
      "  FROM customers",
      "  WHERE fortnox_cost_center = {user_cost_center}",
      "    AND (status = 'active' OR status IS NULL)",
      "),",
      "monthly_kpis AS (",
      "  SELECT COALESCE(SUM(ck.invoice_count), 0) AS invoice_count,",
      "         COALESCE(SUM(ck.total_turnover), 0) AS turnover_ex_vat",
      "  FROM customer_kpis ck",
      "  INNER JOIN customers c ON c.id = ck.customer_id",
      "  INNER JOIN scoped_customers sc",
      "    ON sc.fortnox_customer_number = c.fortnox_customer_number",
      "  WHERE ck.period_type = 'month'",
      `    AND ck.period_year = EXTRACT(YEAR FROM '${monthStart}'::date)::int`,
      `    AND ck.period_month = EXTRACT(MONTH FROM '${monthStart}'::date)::int`,
      "),",
      "monthly_invoices AS (",
      "  SELECT i.*",
      "  FROM invoices i",
      "  INNER JOIN scoped_customers sc",
      "    ON sc.fortnox_customer_number = i.fortnox_customer_number",
      `  WHERE i.invoice_date >= '${monthStart}'::date`,
      `    AND i.invoice_date < ('${monthStart}'::date + INTERVAL '1 month')`,
      ")",
      "SELECT",
      "  mk.invoice_count AS invoice_count,",
      "  mk.turnover_ex_vat AS turnover_ex_vat,",
      "  COALESCE(SUM(mi.total), 0) AS turnover_incl_vat,",
      "  COALESCE(SUM(mi.balance), 0) AS outstanding_balance",
      "FROM monthly_kpis mk",
      "LEFT JOIN monthly_invoices mi ON TRUE",
      "GROUP BY mk.invoice_count, mk.turnover_ex_vat",
    ].join("\n");
  }

  return [
    "WITH active_customers AS (",
    "  SELECT fortnox_customer_number, id",
    "  FROM customers",
    "  WHERE status = 'active' OR status IS NULL",
    "),",
    "monthly_kpis AS (",
    "  SELECT COALESCE(SUM(ck.invoice_count), 0) AS invoice_count,",
    "         COALESCE(SUM(ck.total_turnover), 0) AS turnover_ex_vat",
    "  FROM customer_kpis ck",
    "  INNER JOIN active_customers ac ON ac.id = ck.customer_id",
    "  WHERE ck.period_type = 'month'",
    `    AND ck.period_year = EXTRACT(YEAR FROM '${monthStart}'::date)::int`,
    `    AND ck.period_month = EXTRACT(MONTH FROM '${monthStart}'::date)::int`,
    "),",
    "monthly_invoices AS (",
    "  SELECT i.*",
    "  FROM invoices i",
    "  INNER JOIN active_customers ac",
    "    ON ac.fortnox_customer_number = i.fortnox_customer_number",
    `  WHERE i.invoice_date >= '${monthStart}'::date`,
    `    AND i.invoice_date < ('${monthStart}'::date + INTERVAL '1 month')`,
    ")",
    "SELECT",
    "  mk.invoice_count AS invoice_count,",
    "  mk.turnover_ex_vat AS turnover_ex_vat,",
    "  COALESCE(SUM(mi.total), 0) AS turnover_incl_vat,",
    "  COALESCE(SUM(mi.balance), 0) AS outstanding_balance",
    "FROM monthly_kpis mk",
    "LEFT JOIN monthly_invoices mi ON TRUE",
    "GROUP BY mk.invoice_count, mk.turnover_ex_vat",
  ].join("\n");
}

function buildFinancialComparisonFallbackSql(input: {
  role: string;
  periods: [FinancialReportWindow, FinancialReportWindow];
}): string {
  const [first, second] = input.periods;
  const firstStart = `${first.year}-${String(first.month).padStart(2, "0")}-01`;
  const secondStart = `${second.year}-${String(second.month).padStart(2, "0")}-01`;

  const scopedCustomersCte = CRM_CUSTOMER_SCOPED_ROLES.has(input.role)
    ? [
        "scoped_customers AS (",
        "  SELECT fortnox_customer_number, id",
        "  FROM customers",
        "  WHERE fortnox_cost_center = {user_cost_center}",
        "    AND (status = 'active' OR status IS NULL)",
        "),",
      ]
    : [
        "active_customers AS (",
        "  SELECT fortnox_customer_number, id",
        "  FROM customers",
        "  WHERE status = 'active' OR status IS NULL",
        "),",
      ];

  const customerScopeSource = CRM_CUSTOMER_SCOPED_ROLES.has(input.role)
    ? [
        "  FROM scoped_customers c",
      ]
    : ["  FROM active_customers c"];

  const invoiceJoinSource = CRM_CUSTOMER_SCOPED_ROLES.has(input.role)
    ? [
        "  LEFT JOIN (",
        "    SELECT i.invoice_date, i.total, i.balance",
        "    FROM invoices i",
        "    INNER JOIN scoped_customers sc",
        "      ON sc.fortnox_customer_number = i.fortnox_customer_number",
        "  ) i",
        "    ON i.invoice_date >= p.start_date",
        "   AND i.invoice_date < p.end_date",
      ]
    : [
        "  LEFT JOIN (",
        "    SELECT i.invoice_date, i.total, i.balance",
        "    FROM invoices i",
        "    INNER JOIN active_customers ac",
        "      ON ac.fortnox_customer_number = i.fortnox_customer_number",
        "  ) i",
        "    ON i.invoice_date >= p.start_date",
        "   AND i.invoice_date < p.end_date",
      ];

  return [
    "WITH",
    ...scopedCustomersCte,
    "periods AS (",
    "  SELECT 'period_a'::text AS label,",
    `         '${firstStart}'::date AS start_date,`,
    `         ('${firstStart}'::date + INTERVAL '1 month')::date AS end_date`,
    "  UNION ALL",
    "  SELECT 'period_b'::text AS label,",
    `         '${secondStart}'::date AS start_date,`,
    `         ('${secondStart}'::date + INTERVAL '1 month')::date AS end_date`,
    "),",
    "monthly_kpis AS (",
    "  SELECT",
    "    p.label,",
    "    COALESCE(SUM(ck.invoice_count), 0) AS invoice_count,",
    "    COALESCE(SUM(ck.total_turnover), 0) AS turnover_ex_vat",
    ...customerScopeSource,
    "  INNER JOIN customer_kpis ck ON ck.customer_id = c.id",
    "  INNER JOIN periods p",
    "    ON ck.period_type = 'month'",
    "   AND ck.period_year = EXTRACT(YEAR FROM p.start_date)::int",
    "   AND ck.period_month = EXTRACT(MONTH FROM p.start_date)::int",
    "  GROUP BY p.label",
    "),",
    "monthly AS (",
    "  SELECT",
    "    p.label,",
    "    COALESCE(mk.invoice_count, 0) AS invoice_count,",
    "    COALESCE(mk.turnover_ex_vat, 0) AS turnover_ex_vat,",
    "    COALESCE(SUM(i.total), 0) AS turnover_incl_vat,",
    "    COALESCE(SUM(i.balance), 0) AS outstanding_balance",
    "  FROM periods p",
    "  LEFT JOIN monthly_kpis mk ON mk.label = p.label",
    ...invoiceJoinSource,
    "  GROUP BY p.label, mk.invoice_count, mk.turnover_ex_vat",
    ")",
    "SELECT",
    "  p.label,",
    "  COALESCE(m.invoice_count, 0) AS invoice_count,",
    "  COALESCE(m.turnover_ex_vat, 0) AS turnover_ex_vat,",
    "  COALESCE(m.turnover_incl_vat, 0) AS turnover_incl_vat,",
    "  COALESCE(m.outstanding_balance, 0) AS outstanding_balance",
    "FROM periods p",
    "LEFT JOIN monthly m ON m.label = p.label",
    "ORDER BY p.label",
  ].join("\n");
}

function buildTopCustomersFallbackSql(input: {
  role: string;
  year: number;
}): string {
  if (CRM_CUSTOMER_SCOPED_ROLES.has(input.role)) {
    return [
      "WITH scoped_customers AS (",
      "  SELECT id, name, fortnox_customer_number",
      "  FROM customers",
      "  WHERE fortnox_cost_center = {user_cost_center}",
      "    AND (status = 'active' OR status IS NULL)",
      "),",
      "yearly_kpis AS (",
      "  SELECT",
      "    sc.name AS customer_name,",
      "    COALESCE(SUM(ck.total_turnover), 0) AS turnover_ex_vat,",
      "    COALESCE(SUM(ck.invoice_count), 0) AS invoice_count,",
      "    COALESCE(SUM(ck.total_hours), 0) AS total_hours",
      "  FROM scoped_customers sc",
      "  INNER JOIN customer_kpis ck ON ck.customer_id = sc.id",
      "  WHERE ck.period_type = 'month'",
      `    AND ck.period_year = ${input.year}`,
      "  GROUP BY sc.name",
      ")",
      "SELECT customer_name, turnover_ex_vat, invoice_count, total_hours",
      "FROM yearly_kpis",
      "ORDER BY turnover_ex_vat DESC, customer_name ASC",
      "LIMIT 10",
    ].join("\n");
  }

  return [
    "WITH active_customers AS (",
    "  SELECT id, name",
    "  FROM customers",
    "  WHERE status = 'active' OR status IS NULL",
    "),",
    "yearly_kpis AS (",
    "  SELECT",
    "    ac.name AS customer_name,",
    "    COALESCE(SUM(ck.total_turnover), 0) AS turnover_ex_vat,",
    "    COALESCE(SUM(ck.invoice_count), 0) AS invoice_count,",
    "    COALESCE(SUM(ck.total_hours), 0) AS total_hours",
    "  FROM active_customers ac",
    "  INNER JOIN customer_kpis ck ON ck.customer_id = ac.id",
    "  WHERE ck.period_type = 'month'",
    `    AND ck.period_year = ${input.year}`,
    "  GROUP BY ac.name",
    ")",
    "SELECT customer_name, turnover_ex_vat, invoice_count, total_hours",
    "FROM yearly_kpis",
    "ORDER BY turnover_ex_vat DESC, customer_name ASC",
    "LIMIT 10",
  ].join("\n");
}

function buildTopCustomerByInvoicesForYearFallbackSql(input: {
  role: string;
  year: number;
}): string {
  if (CRM_CUSTOMER_SCOPED_ROLES.has(input.role)) {
    return [
      "WITH scoped_customers AS (",
      "  SELECT id, name",
      "  FROM customers",
      "  WHERE fortnox_cost_center = {user_cost_center}",
      "    AND (status = 'active' OR status IS NULL)",
      "),",
      "yearly AS (",
      "  SELECT",
      "    sc.name AS customer_name,",
      "    COALESCE(SUM(ck.invoice_count), 0) AS invoice_count,",
      "    COALESCE(SUM(ck.total_turnover), 0) AS turnover_ex_vat,",
      "    COALESCE(SUM(ck.total_hours), 0) AS total_hours",
      "  FROM scoped_customers sc",
      "  INNER JOIN customer_kpis ck ON ck.customer_id = sc.id",
      "  WHERE ck.period_type = 'month'",
      `    AND ck.period_year = ${input.year}`,
      "  GROUP BY sc.name",
      ")",
      "SELECT customer_name, invoice_count, turnover_ex_vat, total_hours",
      "FROM yearly",
      "ORDER BY invoice_count DESC, turnover_ex_vat DESC, customer_name ASC",
      "LIMIT 1",
    ].join("\n");
  }

  return [
    "WITH active_customers AS (",
    "  SELECT id, name",
    "  FROM customers",
    "  WHERE status = 'active' OR status IS NULL",
    "),",
    "yearly AS (",
    "  SELECT",
    "    ac.name AS customer_name,",
    "    COALESCE(SUM(ck.invoice_count), 0) AS invoice_count,",
    "    COALESCE(SUM(ck.total_turnover), 0) AS turnover_ex_vat,",
    "    COALESCE(SUM(ck.total_hours), 0) AS total_hours",
    "  FROM active_customers ac",
    "  INNER JOIN customer_kpis ck ON ck.customer_id = ac.id",
    "  WHERE ck.period_type = 'month'",
    `    AND ck.period_year = ${input.year}`,
    "  GROUP BY ac.name",
    ")",
    "SELECT customer_name, invoice_count, turnover_ex_vat, total_hours",
    "FROM yearly",
    "ORDER BY invoice_count DESC, turnover_ex_vat DESC, customer_name ASC",
    "LIMIT 1",
  ].join("\n");
}

function buildTopCustomerForMonthFallbackSql(input: {
  role: string;
  window: FinancialReportWindow;
}): string {
  if (CRM_CUSTOMER_SCOPED_ROLES.has(input.role)) {
    return [
      "WITH scoped_customers AS (",
      "  SELECT id, name",
      "  FROM customers",
      "  WHERE fortnox_cost_center = {user_cost_center}",
      "    AND (status = 'active' OR status IS NULL)",
      "),",
      "monthly AS (",
      "  SELECT",
      "    sc.name AS customer_name,",
      "    COALESCE(SUM(ck.total_turnover), 0) AS turnover_ex_vat,",
      "    COALESCE(SUM(ck.invoice_count), 0) AS invoice_count,",
      "    COALESCE(SUM(ck.total_hours), 0) AS total_hours",
      "  FROM scoped_customers sc",
      "  INNER JOIN customer_kpis ck ON ck.customer_id = sc.id",
      "  WHERE ck.period_type = 'month'",
      `    AND ck.period_year = ${input.window.year}`,
      `    AND ck.period_month = ${input.window.month}`,
      "  GROUP BY sc.name",
      ")",
      "SELECT customer_name, turnover_ex_vat, invoice_count, total_hours",
      "FROM monthly",
      "ORDER BY turnover_ex_vat DESC, customer_name ASC",
      "LIMIT 1",
    ].join("\n");
  }

  return [
    "WITH active_customers AS (",
    "  SELECT id, name",
    "  FROM customers",
    "  WHERE status = 'active' OR status IS NULL",
    "),",
    "monthly AS (",
    "  SELECT",
    "    ac.name AS customer_name,",
    "    COALESCE(SUM(ck.total_turnover), 0) AS turnover_ex_vat,",
    "    COALESCE(SUM(ck.invoice_count), 0) AS invoice_count,",
    "    COALESCE(SUM(ck.total_hours), 0) AS total_hours",
    "  FROM active_customers ac",
    "  INNER JOIN customer_kpis ck ON ck.customer_id = ac.id",
    "  WHERE ck.period_type = 'month'",
    `    AND ck.period_year = ${input.window.year}`,
    `    AND ck.period_month = ${input.window.month}`,
    "  GROUP BY ac.name",
    ")",
    "SELECT customer_name, turnover_ex_vat, invoice_count, total_hours",
    "FROM monthly",
    "ORDER BY turnover_ex_vat DESC, customer_name ASC",
    "LIMIT 1",
  ].join("\n");
}

function buildCustomerMonthKpiFallbackSql(input: {
  role: string;
  window: FinancialReportWindow;
  customerName: string;
}): string {
  const customerNameFilter = toSqlLikeLiteral(input.customerName);

  if (CRM_CUSTOMER_SCOPED_ROLES.has(input.role)) {
    return [
      "WITH scoped_customers AS (",
      "  SELECT id, name",
      "  FROM customers",
      "  WHERE fortnox_cost_center = {user_cost_center}",
      "    AND (status = 'active' OR status IS NULL)",
      `    AND name ILIKE ${customerNameFilter} ESCAPE '\\\\'`,
      "),",
      "monthly AS (",
      "  SELECT",
      "    sc.name AS customer_name,",
      "    COALESCE(SUM(ck.total_turnover), 0) AS turnover_ex_vat,",
      "    COALESCE(SUM(ck.invoice_count), 0) AS invoice_count,",
      "    COALESCE(SUM(ck.total_hours), 0) AS total_hours",
      "  FROM scoped_customers sc",
      "  INNER JOIN customer_kpis ck ON ck.customer_id = sc.id",
      "  WHERE ck.period_type = 'month'",
      `    AND ck.period_year = ${input.window.year}`,
      `    AND ck.period_month = ${input.window.month}`,
      "  GROUP BY sc.name",
      ")",
      "SELECT customer_name, turnover_ex_vat, invoice_count, total_hours",
      "FROM monthly",
      "ORDER BY turnover_ex_vat DESC, customer_name ASC",
      "LIMIT 5",
    ].join("\n");
  }

  return [
    "WITH active_customers AS (",
    "  SELECT id, name",
    "  FROM customers",
    "  WHERE status = 'active' OR status IS NULL",
    `    AND name ILIKE ${customerNameFilter} ESCAPE '\\\\'`,
    "),",
    "monthly AS (",
    "  SELECT",
    "    ac.name AS customer_name,",
    "    COALESCE(SUM(ck.total_turnover), 0) AS turnover_ex_vat,",
    "    COALESCE(SUM(ck.invoice_count), 0) AS invoice_count,",
    "    COALESCE(SUM(ck.total_hours), 0) AS total_hours",
    "  FROM active_customers ac",
    "  INNER JOIN customer_kpis ck ON ck.customer_id = ac.id",
    "  WHERE ck.period_type = 'month'",
    `    AND ck.period_year = ${input.window.year}`,
    `    AND ck.period_month = ${input.window.month}`,
    "  GROUP BY ac.name",
    ")",
    "SELECT customer_name, turnover_ex_vat, invoice_count, total_hours",
    "FROM monthly",
    "ORDER BY turnover_ex_vat DESC, customer_name ASC",
    "LIMIT 5",
  ].join("\n");
}

function buildMonthCustomerKpiListFallbackSql(input: {
  role: string;
  window: FinancialReportWindow;
}): string {
  if (CRM_CUSTOMER_SCOPED_ROLES.has(input.role)) {
    return [
      "WITH scoped_customers AS (",
      "  SELECT id, name",
      "  FROM customers",
      "  WHERE fortnox_cost_center = {user_cost_center}",
      "    AND (status = 'active' OR status IS NULL)",
      "),",
      "monthly AS (",
      "  SELECT",
      "    sc.name AS customer_name,",
      "    COALESCE(SUM(ck.total_turnover), 0) AS turnover_ex_vat,",
      "    COALESCE(SUM(ck.invoice_count), 0) AS invoice_count,",
      "    COALESCE(SUM(ck.total_hours), 0) AS total_hours",
      "  FROM scoped_customers sc",
      "  INNER JOIN customer_kpis ck ON ck.customer_id = sc.id",
      "  WHERE ck.period_type = 'month'",
      `    AND ck.period_year = ${input.window.year}`,
      `    AND ck.period_month = ${input.window.month}`,
      "  GROUP BY sc.name",
      ")",
      "SELECT customer_name, turnover_ex_vat, invoice_count, total_hours",
      "FROM monthly",
      "ORDER BY turnover_ex_vat DESC, invoice_count DESC, customer_name ASC",
      "LIMIT 10",
    ].join("\n");
  }

  return [
    "WITH active_customers AS (",
    "  SELECT id, name",
    "  FROM customers",
    "  WHERE status = 'active' OR status IS NULL",
    "),",
    "monthly AS (",
    "  SELECT",
    "    ac.name AS customer_name,",
    "    COALESCE(SUM(ck.total_turnover), 0) AS turnover_ex_vat,",
    "    COALESCE(SUM(ck.invoice_count), 0) AS invoice_count,",
    "    COALESCE(SUM(ck.total_hours), 0) AS total_hours",
    "  FROM active_customers ac",
    "  INNER JOIN customer_kpis ck ON ck.customer_id = ac.id",
    "  WHERE ck.period_type = 'month'",
    `    AND ck.period_year = ${input.window.year}`,
    `    AND ck.period_month = ${input.window.month}`,
    "  GROUP BY ac.name",
    ")",
    "SELECT customer_name, turnover_ex_vat, invoice_count, total_hours",
    "FROM monthly",
    "ORDER BY turnover_ex_vat DESC, invoice_count DESC, customer_name ASC",
    "LIMIT 10",
  ].join("\n");
}

function parseTopCustomerForMonthWindow(question: string): FinancialReportWindow | null {
  const normalized = question
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  const hasCustomerKeyword =
    normalized.includes("customer") ||
    normalized.includes("customers") ||
    normalized.includes("kund") ||
    normalized.includes("kunder");
  const hasTurnoverKeyword =
    normalized.includes("turnover") ||
    normalized.includes("omsattning") ||
    normalized.includes("revenue") ||
    normalized.includes("intakt") ||
    normalized.includes("tjanat") ||
    normalized.includes("fakturerat") ||
    normalized.includes("fakturering");
  const hasTopKeyword =
    normalized.includes("highest") ||
    normalized.includes("greatest") ||
    normalized.includes("top") ||
    normalized.includes("hogst") ||
    normalized.includes("storst") ||
    normalized.includes("mest");

  if (!hasCustomerKeyword || !hasTurnoverKeyword || !hasTopKeyword) {
    return null;
  }

  return parseFinancialReportWindow(question);
}

function isMonthCustomerKpiQuestion(question: string): boolean {
  const normalized = question
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  const hasCustomerKeyword =
    normalized.includes("customer") ||
    normalized.includes("customers") ||
    normalized.includes("kund") ||
    normalized.includes("kunder");

  const hasKpiKeyword =
    normalized.includes("turnover") ||
    normalized.includes("omsattning") ||
    normalized.includes("invoice") ||
    normalized.includes("faktura") ||
    normalized.includes("hours") ||
    normalized.includes("timmar") ||
    normalized.includes("kpi") ||
    normalized.includes("resultat");

  return hasCustomerKeyword && hasKpiKeyword;
}

function parseRollingWindowPreset(question: string): RollingWindowPreset | null {
  const normalized = question
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  const last12Patterns = [
    "last 12 months",
    "past 12 months",
    "rolling 12",
    "senaste 12 manader",
    "rullande 12 manader",
    "12 manader",
  ];

  if (last12Patterns.some((pattern) => normalized.includes(pattern))) {
    return "last-12-months";
  }

  const currentYearPatterns = [
    "this year",
    "current year",
    "i ar",
    "innevarande ar",
    "hittills i ar",
    "year to date",
    "ytd",
  ];

  if (currentYearPatterns.some((pattern) => normalized.includes(pattern))) {
    return "current-year";
  }

  return null;
}

function parseQuotedCustomerName(question: string): string | null {
  const match = question.match(/(?:customer|kund)\s+["“](.+?)["”]/i);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

function buildRollingWindowKpisFallbackSql(input: {
  role: string;
  preset: RollingWindowPreset;
}): string {
  const windowBounds =
    input.preset === "current-year"
      ? [
          "date_trunc('year', now())::date AS start_date,",
          "(date_trunc('month', now())::date + INTERVAL '1 month')::date AS end_date",
        ]
      : [
          "(date_trunc('month', now())::date - INTERVAL '11 months')::date AS start_date,",
          "(date_trunc('month', now())::date + INTERVAL '1 month')::date AS end_date",
        ];

  if (CRM_CUSTOMER_SCOPED_ROLES.has(input.role)) {
    return [
      "WITH scoped_customers AS (",
      "  SELECT id",
      "  FROM customers",
      "  WHERE fortnox_cost_center = {user_cost_center}",
      "    AND (status = 'active' OR status IS NULL)",
      "),",
      "bounds AS (",
      "  SELECT",
      ...windowBounds.map((line) => `    ${line}`),
      "),",
      "monthly AS (",
      "  SELECT",
      "    ck.period_year,",
      "    ck.period_month,",
      "    COALESCE(SUM(ck.invoice_count), 0) AS invoice_count,",
      "    COALESCE(SUM(ck.total_turnover), 0) AS turnover_ex_vat,",
      "    COALESCE(SUM(ck.total_hours), 0) AS total_hours",
      "  FROM customer_kpis ck",
      "  INNER JOIN scoped_customers sc ON sc.id = ck.customer_id",
      "  CROSS JOIN bounds b",
      "  WHERE ck.period_type = 'month'",
      "    AND make_date(ck.period_year, ck.period_month, 1) >= b.start_date",
      "    AND make_date(ck.period_year, ck.period_month, 1) < b.end_date",
      "  GROUP BY ck.period_year, ck.period_month",
      ")",
      "SELECT period_year, period_month, invoice_count, turnover_ex_vat, total_hours",
      "FROM monthly",
      "ORDER BY period_year ASC, period_month ASC",
      "LIMIT 24",
    ].join("\n");
  }

  return [
    "WITH active_customers AS (",
    "  SELECT id",
    "  FROM customers",
    "  WHERE status = 'active' OR status IS NULL",
    "),",
    "bounds AS (",
    "  SELECT",
    ...windowBounds.map((line) => `    ${line}`),
    "),",
    "monthly AS (",
    "  SELECT",
    "    ck.period_year,",
    "    ck.period_month,",
    "    COALESCE(SUM(ck.invoice_count), 0) AS invoice_count,",
    "    COALESCE(SUM(ck.total_turnover), 0) AS turnover_ex_vat,",
    "    COALESCE(SUM(ck.total_hours), 0) AS total_hours",
    "  FROM customer_kpis ck",
    "  INNER JOIN active_customers ac ON ac.id = ck.customer_id",
    "  CROSS JOIN bounds b",
    "  WHERE ck.period_type = 'month'",
    "    AND make_date(ck.period_year, ck.period_month, 1) >= b.start_date",
    "    AND make_date(ck.period_year, ck.period_month, 1) < b.end_date",
    "  GROUP BY ck.period_year, ck.period_month",
    ")",
    "SELECT period_year, period_month, invoice_count, turnover_ex_vat, total_hours",
    "FROM monthly",
    "ORDER BY period_year ASC, period_month ASC",
    "LIMIT 24",
  ].join("\n");
}

function buildCustomerRollingWindowKpisFallbackSql(input: {
  role: string;
  preset: RollingWindowPreset;
  customerName: string;
}): string {
  const windowBounds =
    input.preset === "current-year"
      ? [
          "date_trunc('year', now())::date AS start_date,",
          "(date_trunc('month', now())::date + INTERVAL '1 month')::date AS end_date",
        ]
      : [
          "(date_trunc('month', now())::date - INTERVAL '11 months')::date AS start_date,",
          "(date_trunc('month', now())::date + INTERVAL '1 month')::date AS end_date",
        ];

  const customerNameFilter = toSqlLikeLiteral(input.customerName);

  if (CRM_CUSTOMER_SCOPED_ROLES.has(input.role)) {
    return [
      "WITH scoped_customers AS (",
      "  SELECT id, name",
      "  FROM customers",
      "  WHERE fortnox_cost_center = {user_cost_center}",
      "    AND (status = 'active' OR status IS NULL)",
      `    AND name ILIKE ${customerNameFilter} ESCAPE '\\'`,
      "),",
      "bounds AS (",
      "  SELECT",
      ...windowBounds.map((line) => `    ${line}`),
      "),",
      "monthly AS (",
      "  SELECT",
      "    sc.name AS customer_name,",
      "    ck.period_year,",
      "    ck.period_month,",
      "    COALESCE(SUM(ck.invoice_count), 0) AS invoice_count,",
      "    COALESCE(SUM(ck.total_turnover), 0) AS turnover_ex_vat,",
      "    COALESCE(SUM(ck.total_hours), 0) AS total_hours",
      "  FROM customer_kpis ck",
      "  INNER JOIN scoped_customers sc ON sc.id = ck.customer_id",
      "  CROSS JOIN bounds b",
      "  WHERE ck.period_type = 'month'",
      "    AND make_date(ck.period_year, ck.period_month, 1) >= b.start_date",
      "    AND make_date(ck.period_year, ck.period_month, 1) < b.end_date",
      "  GROUP BY sc.name, ck.period_year, ck.period_month",
      ")",
      "SELECT customer_name, period_year, period_month, invoice_count, turnover_ex_vat, total_hours",
      "FROM monthly",
      "ORDER BY period_year ASC, period_month ASC",
      "LIMIT 24",
    ].join("\n");
  }

  return [
    "WITH active_customers AS (",
    "  SELECT id, name",
    "  FROM customers",
    "  WHERE status = 'active' OR status IS NULL",
    `    AND name ILIKE ${customerNameFilter} ESCAPE '\\'`,
    "),",
    "bounds AS (",
    "  SELECT",
    ...windowBounds.map((line) => `    ${line}`),
    "),",
    "monthly AS (",
    "  SELECT",
    "    ac.name AS customer_name,",
    "    ck.period_year,",
    "    ck.period_month,",
    "    COALESCE(SUM(ck.invoice_count), 0) AS invoice_count,",
    "    COALESCE(SUM(ck.total_turnover), 0) AS turnover_ex_vat,",
    "    COALESCE(SUM(ck.total_hours), 0) AS total_hours",
    "  FROM customer_kpis ck",
    "  INNER JOIN active_customers ac ON ac.id = ck.customer_id",
    "  CROSS JOIN bounds b",
    "  WHERE ck.period_type = 'month'",
    "    AND make_date(ck.period_year, ck.period_month, 1) >= b.start_date",
    "    AND make_date(ck.period_year, ck.period_month, 1) < b.end_date",
    "  GROUP BY ac.name, ck.period_year, ck.period_month",
    ")",
    "SELECT customer_name, period_year, period_month, invoice_count, turnover_ex_vat, total_hours",
    "FROM monthly",
    "ORDER BY period_year ASC, period_month ASC",
    "LIMIT 24",
  ].join("\n");
}

function parseTopCustomersYear(question: string): number | null {
  const normalized = question
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  const hasCustomerKeyword =
    normalized.includes("customer") ||
    normalized.includes("customers") ||
    normalized.includes("kund") ||
    normalized.includes("kunder");

  const hasValueKeyword =
    normalized.includes("turnover") ||
    normalized.includes("omsattning") ||
    normalized.includes("revenue") ||
    normalized.includes("intakt") ||
    normalized.includes("tjanat") ||
    normalized.includes("fakturerat") ||
    normalized.includes("fakturering");

  const hasTopKeyword =
    normalized.includes("top") ||
    normalized.includes("highest") ||
    normalized.includes("greatest") ||
    normalized.includes("best") ||
    normalized.includes("hogst") ||
    normalized.includes("storst") ||
    normalized.includes("mest");

  if (!hasCustomerKeyword || !hasValueKeyword || !hasTopKeyword) {
    return null;
  }

  const detectedYear = normalized.match(/\b(20\d{2})\b/)?.[1];
  if (detectedYear) return Number(detectedYear);

  const hasCurrentYearHint =
    normalized.includes("this year") ||
    normalized.includes("current year") ||
    normalized.includes("i ar") ||
    normalized.includes("innevarande ar") ||
    normalized.includes("hittills i ar") ||
    normalized.includes("year to date") ||
    normalized.includes("ytd");

  return hasCurrentYearHint ? new Date().getUTCFullYear() : null;
}

function parseTopInvoiceCustomerYear(question: string): number | null {
  const normalized = question
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  const hasCustomerKeyword =
    normalized.includes("customer") ||
    normalized.includes("customers") ||
    normalized.includes("kund") ||
    normalized.includes("kunder");

  const hasInvoiceKeyword =
    normalized.includes("invoice") ||
    normalized.includes("invoices") ||
    normalized.includes("faktura") ||
    normalized.includes("fakturor");

  const hasTopKeyword =
    normalized.includes("most") ||
    normalized.includes("highest") ||
    normalized.includes("greatest") ||
    normalized.includes("top") ||
    normalized.includes("flest") ||
    normalized.includes("mest");

  if (!hasCustomerKeyword || !hasInvoiceKeyword || !hasTopKeyword) {
    return null;
  }

  const detectedYear = normalized.match(/\b(20\d{2})\b/)?.[1];
  if (detectedYear) return Number(detectedYear);

  const hasCurrentYearHint =
    normalized.includes("this year") ||
    normalized.includes("current year") ||
    normalized.includes("i ar") ||
    normalized.includes("innevarande ar") ||
    normalized.includes("hittills i ar") ||
    normalized.includes("year to date") ||
    normalized.includes("ytd");

  return hasCurrentYearHint ? new Date().getUTCFullYear() : null;
}

function buildDeterministicReportingSql(input: {
  question: string;
  role: string;
  userCostCenter: string | null;
}): string {
  const monthWindow = parseFinancialReportWindow(input.question);
  const quotedCustomerName = parseQuotedCustomerName(input.question);
  if (monthWindow && quotedCustomerName && isMonthCustomerKpiQuestion(input.question)) {
    return buildCustomerMonthKpiFallbackSql({
      role: input.role,
      window: monthWindow,
      customerName: quotedCustomerName,
    });
  }

  if (monthWindow && isMonthCustomerKpiQuestion(input.question)) {
    return buildMonthCustomerKpiListFallbackSql({
      role: input.role,
      window: monthWindow,
    });
  }

  const topInvoiceCustomerYear = parseTopInvoiceCustomerYear(input.question);
  if (topInvoiceCustomerYear) {
    return buildTopCustomerByInvoicesForYearFallbackSql({
      role: input.role,
      year: topInvoiceCustomerYear,
    });
  }

  const topCustomerMonthWindow = parseTopCustomerForMonthWindow(input.question);
  if (topCustomerMonthWindow) {
    return buildTopCustomerForMonthFallbackSql({
      role: input.role,
      window: topCustomerMonthWindow,
    });
  }

  const rollingPreset = parseRollingWindowPreset(input.question);
  if (rollingPreset && quotedCustomerName) {
    return buildCustomerRollingWindowKpisFallbackSql({
      role: input.role,
      preset: rollingPreset,
      customerName: quotedCustomerName,
    });
  }

  if (rollingPreset) {
    return buildRollingWindowKpisFallbackSql({
      role: input.role,
      preset: rollingPreset,
    });
  }

  const comparisonWindow = parseFinancialComparisonWindows(input.question);
  if (comparisonWindow) {
    return buildFinancialComparisonFallbackSql({
      role: input.role,
      periods: comparisonWindow,
    });
  }

  const singleWindow = parseFinancialReportWindow(input.question);
  if (singleWindow) {
    return buildFinancialReportFallbackSql({
      role: input.role,
      userCostCenter: input.userCostCenter,
      window: singleWindow,
    });
  }

  const topCustomersYear = parseTopCustomersYear(input.question);
  if (topCustomersYear) {
    return buildTopCustomersFallbackSql({
      role: input.role,
      year: topCustomersYear,
    });
  }

  return buildGeneralReportFallbackSql({ role: input.role });
}

function extractCteNames(sql: string): Set<string> {
  const cteNames = new Set<string>();
  const withMatches = sql.matchAll(/\bwith\s+([a-z_][a-z0-9_]*)\s+as\b/gi);
  const chainedMatches = sql.matchAll(/,\s*([a-z_][a-z0-9_]*)\s+as\b/gi);

  for (const match of withMatches) {
    cteNames.add(match[1].toLowerCase());
  }

  for (const match of chainedMatches) {
    cteNames.add(match[1].toLowerCase());
  }

  return cteNames;
}

function extractRelationNames(sql: string): string[] {
  const matches = sql.matchAll(
    /\b(?:from|join)\s+(?:lateral\s+)?([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)/gi,
  );

  return Array.from(matches, (match) => {
    const raw = match[1].toLowerCase();
    const parts = raw.split(".");
    return parts[parts.length - 1];
  });
}

function validateSql(
  query: string,
): { valid: true; sql: string } | { valid: false; error: string } {
  const fencedMatch = query.match(/```(?:sql)?\s*([\s\S]*?)\s*```/i);
  const unfenced = (fencedMatch?.[1] ?? query).trim();
  const firstSelectOrWith = unfenced.match(/(?:^|[\s\S]*?)(\b(?:select|with)\b[\s\S]*)/i);
  const extracted = (firstSelectOrWith?.[1] ?? unfenced).trim();

  const trimmed = extracted.replace(/;+\s*$/, "");
  const lowered = trimmed.toLowerCase();

  if (!lowered.startsWith("select") && !lowered.startsWith("with")) {
    return { valid: false, error: "Only SELECT queries are allowed." };
  }

  const forbiddenKeywords = [
    "insert",
    "update",
    "delete",
    "drop",
    "alter",
    "truncate",
    "grant",
    "revoke",
  ];

  for (const keyword of forbiddenKeywords) {
    if (new RegExp(`\\b${keyword}\\b`, "i").test(trimmed)) {
      return { valid: false, error: `Forbidden SQL keyword: ${keyword}` };
    }
  }

  const cteNames = extractCteNames(trimmed);
  const tableNames = extractRelationNames(trimmed);

  for (const tableName of tableNames) {
    if (cteNames.has(tableName)) {
      continue;
    }

    if (!ALLOWED_TABLES.has(tableName)) {
      return { valid: false, error: `Table not allowed: ${tableName}` };
    }
  }

  const hasLimit = /\blimit\s+\d+/i.test(trimmed);
  const limited = hasLimit ? trimmed : `${trimmed} LIMIT 200`;

  return { valid: true, sql: limited };
}

async function callOpenAiForSql(input: {
  question: string;
  userId: string;
  role: string;
  userCostCenter: string | null;
  dbContext: string;
}): Promise<OpenAiSqlResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const requiresCustomerScope = CRM_CUSTOMER_SCOPED_ROLES.has(input.role);
  const scopeInstructions = requiresCustomerScope
    ? [
        "The authenticated user is customer-scoped, not global.",
        "You MUST scope the query to the user's own customers using placeholder {user_cost_center}.",
        "Use a customers CTE filtered on customers.fortnox_cost_center = {user_cost_center} and status = 'active'.",
        "For invoices, time_reports, contract_accruals, and customer_kpis, join through the scoped customers set using fortnox_customer_number.",
        "Never return data outside the scoped customer set.",
      ]
    : [
        "The authenticated user is admin-scoped and may query reporting data across all customers.",
        "For reporting and KPI questions, still scope through active customers (status = 'active' OR status IS NULL).",
        "For invoices, time_reports, contract_accruals, and customer_kpis, join through the active customer set using fortnox_customer_number (or customer_id for customer_kpis).",
      ];

  const prompt = [
    "You generate SQL for Postgres.",
    "Return only JSON that matches the provided schema.",
    "Generate a read-only query using only allowed tables from context.",
    "Use placeholder {user_id} only when relevant.",
    "Do not use markdown fences.",
    "Keep the query focused on the user's question and return only fields needed to answer it.",
    "If the question is not about CRM or reporting data, return JSON with sql as an empty string.",
    "Never query or return direct personal contact details such as email addresses, phone numbers, linkedin links, or free-text notes.",
    "Do not use contact tables for this endpoint.",
    "For turnover values, prefer total_ex_vat when available.",
    "For contract totals or KPI questions, use active contract_accruals only.",
    "For monthly/rolling KPI reporting questions, prefer customer_kpis (period_type = 'month') for invoice_count, turnover, and hours so results align with the Reports dashboard.",
    ...scopeInstructions,
    "",
    `Question: ${input.question}`,
    `Authenticated user id: ${input.userId}`,
    `Authenticated user role: ${input.role}`,
    `Authenticated user cost center: ${input.userCostCenter ?? "none"}`,
    "",
    "Database context:",
    input.dbContext,
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "generated_sql",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              sql: {
                type: "string",
              },
            },
            required: ["sql"],
            strict: true,
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI SQL generation failed: ${text}`);
  }

  const payload = (await response.json()) as ResponsesPayload;
  const outputTexts: string[] = [];

  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    outputTexts.push(payload.output_text);
  }

  const outputItems = Array.isArray(payload.output) ? payload.output : [];
  for (const item of outputItems) {
    const contentItems = Array.isArray(item.content) ? item.content : [];
    for (const contentItem of contentItems) {
      if (typeof contentItem.text === "string" && contentItem.text.trim()) {
        outputTexts.push(contentItem.text);
      }
    }
  }

  const joinedOutput = outputTexts.join("\n").trim();
  const fencedMatch = joinedOutput.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const rawJson = (fencedMatch?.[1] ?? joinedOutput).trim();

  let parsed: OpenAiSqlResponse | null = null;

  try {
    parsed = JSON.parse(rawJson) as OpenAiSqlResponse;
  } catch {
    const payloadSnippet = JSON.stringify(payload).slice(0, 400);
    throw new Error(`OpenAI SQL generation returned non-JSON payload: ${payloadSnippet}`);
  }

  if (!parsed || typeof parsed.sql !== "string") {
    throw new Error("OpenAI SQL generation returned invalid payload");
  }

  return {
    sql: parsed.sql.trim(),
    raw_response: joinedOutput,
  };
}

function buildContextFromRows(rows: Array<Record<string, unknown>>): string {
  return rows
    .slice(0, 50)
    .map((row, index) => `CRM row ${index + 1}: ${JSON.stringify(row)}`)
    .join("\n");
}

function dedupeSources(sources: SourceRow[]): SourceRow[] {
  const deduped = new Map<string, SourceRow>();

  for (const source of sources) {
    const fileNameKey = source.file_name.trim().toLowerCase();
    const key = fileNameKey;
    const existing = deduped.get(key);

    if (!existing || source.similarity > existing.similarity) {
      deduped.set(key, source);
    }
  }

  return Array.from(deduped.values());
}

async function buildDatabaseContext(input: {
  question: string;
  userId: string;
  role: string | null;
  userCostCenter: string | null;
}): Promise<{ context: string; sources: SourceRow[] }> {
  try {
    if (!input.role || !CRM_ENABLED_ROLES.has(input.role)) {
      return { context: "", sources: [] };
    }

    if (CRM_CUSTOMER_SCOPED_ROLES.has(input.role) && !input.userCostCenter) {
      return { context: "", sources: [] };
    }

    const deterministicReportingSql = isReportingQuestion(input.question)
      ? buildDeterministicReportingSql({
          question: input.question,
          role: input.role,
          userCostCenter: input.userCostCenter,
        })
      : "";

    let generatedSql = "";

    if (!deterministicReportingSql && process.env.OPENAI_API_KEY) {
      const dbContext = await readDbContext();
      try {
        const generated = await callOpenAiForSql({
          question: input.question,
          userId: input.userId,
          role: input.role,
          userCostCenter: input.userCostCenter,
          dbContext,
        });

        generatedSql = generated.sql;
      } catch (error) {
        console.error("crm sql generation failed", {
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    const sqlCandidate = deterministicReportingSql || generatedSql;

    if (!sqlCandidate) {
      return { context: "", sources: [] };
    }

    if (
      CRM_CUSTOMER_SCOPED_ROLES.has(input.role) &&
      !/\{user_cost_center\}/i.test(sqlCandidate)
    ) {
      console.error("crm sql rejected missing scope token", { role: input.role });
      return { context: "", sources: [] };
    }

    const withTokensReplaced = sqlCandidate.replaceAll(
      "{user_id}",
      toSafeUuidLiteral(input.userId),
    );

    const withAllTokensReplaced = withTokensReplaced.replaceAll(
      "{user_cost_center}",
      toSafeTextLiteral(input.userCostCenter),
    );

    const validated = validateSql(withAllTokensReplaced);
    if (!validated.valid) {
      console.error("crm sql validation failed", { error: validated.error });
      return { context: "", sources: [] };
    }

    if (FORBIDDEN_SQL_COLUMN_PATTERN.test(validated.sql)) {
      console.error("crm sql rejected forbidden columns");
      return { context: "", sources: [] };
    }

    const adminClient = createAdminClient();
    const { data, error } = await adminClient.rpc("run_generated_sql" as never, {
      query_text: validated.sql,
    } as never);

    if (error) {
      console.error("crm sql execution failed", { message: error.message });
      return { context: "", sources: [] };
    }

    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    if (rows.length === 0) {
      return { context: "", sources: [] };
    }

    const context = [
      `CRM SQL: ${validated.sql}`,
      "CRM query results:",
      buildContextFromRows(rows),
    ].join("\n");

    return {
      context,
      sources: [
        {
          file_name: "CRM database",
          document_type: "Structured data",
          similarity: 1,
        },
      ],
    };
  } catch (error) {
    console.error("crm context build failed", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return { context: "", sources: [] };
  }
}

function parseVectorEmbedding(value: unknown): number[] {
  if (Array.isArray(value)) {
    const numbers = value.filter((item): item is number => typeof item === "number");
    return numbers;
  }

  if (typeof value !== "string") {
    return [];
  }

  const trimmed = value.trim();
  const normalized = trimmed.replace(/^\[/, "").replace(/\]$/, "");
  if (!normalized) return [];

  return normalized
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function embedQuestion(question: string): Promise<number[]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error("VOYAGE_API_KEY is missing");
  }

  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "voyage-3",
      input: [question],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Voyage embedding failed: ${text}`);
  }

  const payload = (await response.json()) as EmbeddingResponse;
  const firstItem = Array.isArray(payload.data) ? payload.data[0] : null;
  const embedding = Array.isArray(firstItem?.embedding) ? firstItem.embedding : [];

  if (embedding.length !== 1024) {
    throw new Error("Voyage question embedding payload was invalid");
  }

  return embedding;
}

function buildContextFromChunks(chunks: ChunkSearchRow[]): string {
  return chunks
    .map((chunk, index) => {
      const docType = chunk.document_type ?? "unknown";
      return [
        `Source ${index + 1}:`,
        `File: ${chunk.file_name}`,
        `Document type: ${docType}`,
        `Similarity: ${chunk.similarity}`,
        `Content: ${chunk.chunk_text}`,
      ].join("\n");
    })
    .join("\n\n");
}

async function callOpenAiForDocumentAnswer(input: {
  question: string;
  documentContext: string;
  crmContext: string;
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is missing");
  }

  const anthropic = new Anthropic({ apiKey });

  const systemPrompt = [
    "You answer questions only using the provided context.",
    "The context may include structured CRM database results and document excerpts.",
    "Use CRM data for operational facts, counts, customers, contacts, invoices, KPIs, and reporting questions.",
    "Use document context for service, offering, package, and attachment questions.",
    "If both are present, combine them carefully and make the answer clear for a business user.",
    "Do not invent details that are not grounded in the provided context.",
    "If the context is insufficient, say so briefly instead of guessing.",
  ].join(" ");

  const prompt = [
    `Question: ${input.question}`,
    "",
    "CRM database context:",
    input.crmContext || "No CRM database context available.",
    "",
    "Document context:",
    input.documentContext || "No document context available.",
  ].join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1200,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const outputTexts = response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text.trim())
    .filter((text) => text.length > 0);

  return outputTexts.join("\n").trim();
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const input = await parseAskDocumentsInput(request);
    const question = input.question;
    const attachmentOnlyMode = input.attachmentContext.trim().length > 0;

    if (!question) {
      return NextResponse.json(
        { error: "Question is required" },
        { status: 400 },
      );
    }

    const { data: profileData } = await supabase
      .from("profiles")
      .select("role, fortnox_cost_center")
      .eq("id", user.id)
      .maybeSingle();

    const profile = profileData as { role: string | null; fortnox_cost_center: string | null } | null;

    const crmContextResult = attachmentOnlyMode
      ? { context: "", sources: [] as SourceRow[] }
      : await buildDatabaseContext({
          question,
          userId: user.id,
          role: profile?.role ?? null,
          userCostCenter: profile?.fortnox_cost_center ?? null,
        });

    const preferReportingOnly =
      isReportingQuestion(question) && !input.attachmentContext && Boolean(crmContextResult.context);

    let rows: ChunkSearchRow[] = [];

    const adminClient = createAdminClient();

    if (!preferReportingOnly && !attachmentOnlyMode) {
      const questionEmbedding = await embedQuestion(question);
      const vectorString = toVectorString(questionEmbedding);
      const vectorWithCast = `${vectorString}::vector`;

      const { data: rpcData, error: rpcError } = await adminClient.rpc(
        "search_chunks" as never,
        {
          query_embedding: vectorWithCast,
          match_count: 5,
        } as never,
      );

      if (rpcError) {
        console.error("search_chunks rpc failed", {
          code: rpcError.code,
          message: rpcError.message,
        });
      }

      rows = Array.isArray(rpcData) ? (rpcData as ChunkSearchRow[]) : [];

      if (rows.length === 0) {
      const sql = [
        "SELECT",
        "  dc.id AS chunk_id,",
        "  dc.document_id,",
        "  dc.chunk_text,",
        "  d.file_name,",
        "  d.document_type,",
        `  1 - (dc.embedding <=> '${vectorString}'::vector(${questionEmbedding.length})) AS similarity,`,
        "  d.storage_path",
        "FROM document_chunks dc",
        "INNER JOIN documents d ON d.id = dc.document_id",
        `ORDER BY dc.embedding <=> '${vectorString}'::vector(${questionEmbedding.length})`,
        "LIMIT 5",
      ].join("\n");

      const { data: rawSqlData, error: rawSqlError } = await adminClient.rpc(
        "run_generated_sql" as never,
        {
          query_text: sql,
        } as never,
      );

      if (rawSqlError) {
        console.error("run_generated_sql fallback failed", {
          code: rawSqlError.code,
          message: rawSqlError.message,
        });
      }

        rows = Array.isArray(rawSqlData) ? (rawSqlData as ChunkSearchRow[]) : [];
      }

      if (rows.length === 0) {
      const { data: directData, error: directError } = await adminClient
        .from("document_chunks")
        .select(
          "id, document_id, chunk_text, embedding, documents!inner(id, file_name, document_type, storage_path)",
        )
        .limit(500);

      if (directError) {
        console.error("document_chunks direct fallback failed", {
          code: directError.code,
          message: directError.message,
        });
      }

      const directRows = (directData ?? []) as DirectChunkRow[];

        rows = directRows
        .map((row) => {
          const parsedEmbedding = parseVectorEmbedding(row.embedding);
          const similarity = cosineSimilarity(questionEmbedding, parsedEmbedding);

          if (!row.documents) {
            return null;
          }

          return {
            chunk_id: row.id,
            document_id: row.document_id,
            chunk_text: row.chunk_text,
            file_name: row.documents.file_name,
            document_type: row.documents.document_type,
            similarity,
            storage_path: row.documents.storage_path,
          };
        })
        .filter((row): row is ChunkSearchRow => Boolean(row))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 5);
      }
    }

    if (rows.length === 0 && !input.attachmentContext && !crmContextResult.context) {
      return NextResponse.json({
        answer: "I could not find relevant information in the available documents or CRM data.",
        sources: crmContextResult.sources,
      });
    }

    const documentContext = [buildContextFromChunks(rows), input.attachmentContext]
      .filter((value) => value.trim().length > 0)
      .join("\n\n");

    const answer = await callOpenAiForDocumentAnswer({
      question,
      documentContext,
      crmContext: attachmentOnlyMode ? "" : crmContextResult.context,
    });

    const sourceMap = new Map<string, SourceRow>();
    for (const row of rows) {
      const key = `${row.file_name}::${row.document_type ?? ""}`;
      const existing = sourceMap.get(key);
      if (!existing || row.similarity > existing.similarity) {
        sourceMap.set(key, {
          file_name: row.file_name,
          document_type: row.document_type,
          similarity: row.similarity,
        });
      }
    }

    const indexedSources = Array.from(sourceMap.values());
    const mergedSources = attachmentOnlyMode
      ? dedupeSources([...input.attachmentSources])
      : dedupeSources([
          ...crmContextResult.sources,
          ...input.attachmentSources,
          ...indexedSources,
        ]);

    return NextResponse.json({
      answer,
      sources: mergedSources,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
