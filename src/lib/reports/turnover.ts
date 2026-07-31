import type {
  InvoiceDetailRow,
  InvoiceDetailSource,
  RollingMonth,
  TurnoverMonthRow,
} from "./types";

export function invoiceTurnoverStrictExVat(input: {
  total_ex_vat: number | null;
}): { amount: number | null; fromTotal: boolean } {
  if (input.total_ex_vat != null) {
    return { amount: Number(input.total_ex_vat), fromTotal: false };
  }

  return { amount: null, fromTotal: false };
}

export function mapInvoicesToDetailRows(
  invoices: InvoiceDetailSource[],
  options?: {
    fallbackDocumentNumber?: string;
    includeDueDate?: boolean;
    /** Reference date ('YYYY-MM-DD') for overdue classification. Defaults to today. */
    today?: string;
  },
): InvoiceDetailRow[] {
  const fallbackDocumentNumber = options?.fallbackDocumentNumber ?? "-";
  const includeDueDate = options?.includeDueDate ?? false;
  const today = options?.today ?? new Date().toISOString().slice(0, 10);

  return invoices.map((invoice) => {
    const turnover = invoiceTurnoverStrictExVat(invoice);
    // Status is three-way:
    //   paid    → balance settled (≤ 0)
    //   overdue → unpaid AND the due date has already passed
    //   pending → unpaid but still within (or without) its payment period
    // Without a known balance the status is left undefined.
    let status: InvoiceDetailRow["status"];
    if (invoice.balance == null) {
      status = undefined;
    } else if (Number(invoice.balance) <= 0) {
      status = "paid";
    } else if (invoice.due_date != null && invoice.due_date < today) {
      status = "overdue";
    } else {
      status = "pending";
    }

    return {
      id: invoice.id,
      documentNumber: invoice.document_number ?? fallbackDocumentNumber,
      customerName: invoice.customer_name ?? null,
      invoiceDate: invoice.invoice_date,
      dueDate: includeDueDate ? invoice.due_date ?? null : null,
      turnover: turnover.amount,
      turnoverFromTotal: turnover.fromTotal,
      currencyCode: invoice.currency_code ?? "SEK",
      status,
    };
  });
}

export function createEmptyTurnoverRows(
  months: RollingMonth[],
): TurnoverMonthRow[] {
  return months.map((month) => ({
    monthKey: month.key,
    monthLabel: `${month.label} ${String(month.year).slice(-2)}`,
    turnover: 0,
    invoiceCount: 0,
  }));
}
