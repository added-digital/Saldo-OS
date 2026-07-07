# Licenspris- & rabattverktyg — Specifikation

Reverse-engineered from the reference workbook **`Huvud excel.xlsm`** (v1.2,
© 2025–2026 Erik Bryntse, Bilanxia AB). This document is the source of truth for
the in-app pricing/discount feature. Every formula below was verified: the
TypeScript engine reproduces the workbook's own computed values for **all 504
customer rows** (Fortnox price and Reda price) with zero mismatches.

---

## 1. What the tool does

Saldo resells Fortnox licenses (and Reda supplier-invoice scanning) to its
clients. Each month Saldo:

1. Exports a **Fortnox license file** (`Faktureringsunderlag <Month> <Year>`) —
   what Saldo *pays* Fortnox, broken down per client company.
2. Exports a **Saldo client list** — clients that exist in Saldo's Fortnox but
   have no license line (so the fixed client fee / Reda can still be charged).
3. Exports a **Reda file** — number of supplier-invoice scans per client.

The tool merges these three, applies each client's **discount / fixed-price /
"do-not-invoice" settings**, computes the **customer price** (what Saldo charges
the client) versus **cost** (what Saldo pays), and produces Fortnox invoice rows
plus a reconciliation summary.

The margin model: base Fortnox licenses are discounted per customer; **extra
licenses** (articles billed separately by Fortnox, outside the fixed monthly
fee) are always passed through at cost with **no discount**.

---

## 2. Data model — the `Kundnr` sheet (one row per client company)

| Col | Field | Source | Meaning |
|-----|-------|--------|---------|
| A | `abonnemangsnummer` | file | Fortnox database/subscription number |
| B | `orgnr` | file | Organisation number |
| C | `namn` | file | Company name |
| D | `kundnrMatch` | file | Fortnox customer no matching the org nr |
| E | `kundnr` | **manual** | Fortnox customer no. **`EJ`**, **`ÅR`**, or blank ⇒ do not invoice |
| F | `rabattPct` | **manual** | Discount %, **not applied to extra licenses** |
| G | `fastPris` | **manual** | Fixed price override (> 0 activates it) |
| H | `redaFastPris` | **manual** | Reda fixed price. Blank = variable, `0` = do not invoice Reda |
| I | `kundprisFortnox` | **calc** | Customer's Fortnox price (see §3) |
| J | `diffMotListpris` | calc | `I − L` |
| K | `kundprisReda` | **calc** | Customer's Reda price (see §3) |
| L | `listpris` | file | Total list price = Σ(qty × standard price) over all the client's articles |
| M | `fastKostnad` | file | What Saldo pays Fortnox for the fixed client fee |
| N | `kostnadExtraLicenser` | file | What Saldo pays for extra/additional licenses (paid price > 0) |
| O | `kostnadReda` | file | Reda cost = scans × unit price |
| P–S | info | file/manual | Active-customer cross-check, comments, status |

Columns A–D, L–O are filled by the importer. E–H are the manual levers. I, J, K
are computed.

---

## 3. Core formulas (verified 100% against the workbook)

Let `notInvoiced = trim(upper(E)) ∈ {"EJ","ÅR",""}`.

### 3.1 Customer Fortnox price (column I)

```
I = notInvoiced                 → 0
    else if G > 0               → G + N            (fixed-price override + extra licenses at cost)
    else                        → N + (L − N) × (1 − F/100)
```

Interpretation of the `else` branch: extra licenses `N` are charged at cost with
no discount; the remaining base value `(L − N)` gets the customer discount `F%`.

### 3.2 Customer Reda price (column K)

```
K = notInvoiced                 → 0
    else if H is non-empty      → H               (Reda fixed price; H=0 means do not invoice)
    else                        → O               (variable: scans × unit price)
```

### 3.3 Diff vs list price (column J)

```
J = I − L
```

---

## 4. How the importer derives L, M, N, O

### 4.1 Fortnox license file (`Faktureringsunderlag`)

Two sections are parsed:

**"Summa produkter"** (product summary) — one row per article:
`ArticleName | ArticleNumber | TotalQuantity | TotalPrice`. From this the
importer derives the **paid unit price** per article:

```
paidUnitPrice(article) = round(TotalPrice / TotalQuantity, 2)
```

An article with `paidUnitPrice = 0` is a **base license** (included in the fixed
monthly client fee). An article with `paidUnitPrice > 0` is an **extra license**
(billed separately, passed through at cost, never discounted).

**"Byråns egna"** (per-client license lines) — rows of
`DatabaseName | DatabaseNumber | OrgNo | ArticleNumber | Quantity`. Rows are
grouped by `DatabaseNumber` (the client). Each client's article dictionary is
seeded with the fixed-client-price article (qty 1).

Per client the importer accumulates:

```
L (listpris)        = Σ  qty × standardPrice(article)          over all articles
N (extra cost)      = Σ  qty × paidUnitPrice(article)          over articles (only extras have paidUnitPrice > 0)
M (fixed cost)      = fixedArticleQty × fixedClientPricePaid
```

`standardPrice(article)` comes from the **Fortnox standardpris** list (§5). If the
license file reports a different unit price than the list, the file price wins
and the list cell is annotated. Unknown articles are appended to the list for the
user to price, and the import errors until a price is supplied.

### 4.2 Reda file

Header must be `Client | Orgnr | Antal…`. Per row: match `OrgNo` (then lowercased
name) to a Fortnox database; unmatched scans are attributed to Saldo's own
database and flagged. Then:

```
O (reda cost) = round(quantity × redaUnitPrice, 2)      redaUnitPrice default = 2.5 kr/scan
```

### 4.3 Invoice generation (what actually gets billed)

Per client, when a customer number is present (`notInvoiced = false`):

- **Fixed price set (G ≠ 0):** one row `"Fast avgift för Fortnox"` at `G`, no discount.
- **Otherwise:** one row `"Fortnox-licenser"` = `Σ(qty × standardPrice)` over base
  articles only (paidUnitPrice = 0), times `(1 − F/100)`.
- **Extra licenses (paidUnitPrice > 0):** one row per article at
  `qty × paidUnitPrice`, **always, no discount**, even when a fixed price is set.
- **Reda:** fixed `H` if provided, else `qty × redaUnitPrice`.

> Note: the `Kundnr` column-I formula `N + (L−N)(1−F/100)` is the reconciliation
> approximation; the per-row invoice above is the exact billing. They agree when
> an extra article's standard price equals its paid price (the normal case). The
> `Diff` and control rows on the Summary sheet surface any discrepancy.

---

## 5. Standard price list (`Fortnox standardpris`)

Article number → product → monthly price ex VAT. Editable reference data (46
rows in the reference file). Two article numbers are the **fixed client fee**:
`82500` (0 kr, info) and `82501` (500 kr). See `src/lib/pricing/price-list.ts`.

Config constants (from the "Läs in och skicka till Fortnox" sheet):

| Constant | Value | Meaning |
|----------|-------|---------|
| `fixedLicensePriceArticle` | `82501` | Article that carries the fixed client fee |
| `fortnoxArticleNumber` | `97` | Invoice article for Fortnox licenses |
| `redaArticleNumber` | `99` | Invoice article for Reda |
| `redaUnitPrice` | `2.5` | Price per Reda scan |
| `invoiceDay` | `16` | Invoice date day-of-month |

---

## 6. Summary sheet (reconciliation)

Aggregates over `Kundnr`, excluding Saldo's own database (`65018`) where noted:

- **Fakturerat för Fortnox** = `Σ I` (where I > 0)
- **Kostnad fastpris** = `−Σ M`
- **Kostnad övriga licenser** = `−Σ N`
- **Resultat** = invoiced − costs (the margin)
- **Listpris** = `Σ L` (where I > 0)
- **Reda fakturerat / kostnad** = `Σ K` / `−Σ O`
- Control rows check that per-bucket sums reconcile against the invoice sheet and
  the raw imported totals (tolerance 0.01).

---

## 7. Status colours (validation, from the instructions sheet)

- **Grey row** — not in the Fortnox file or Saldo client list; fixed price / Reda still billed.
- **Yellow** — org nr differs between file and customer register (fine if another customer is billed).
- **Red** — customer number missing, or customer inactive in Fortnox → must fix before invoicing.
- **Blue** — company absent from the Fortnox license file.
