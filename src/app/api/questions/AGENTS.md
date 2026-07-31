# QUESTIONS API KNOWLEDGE

## Scope
Applies to `src/app/api/questions`.

## Overview
Question routes handle generated SQL and document/CRM RAG flows. They predate or run alongside the newer chat tool architecture.

## Where To Look
| Task | Location |
|------|----------|
| Document Q&A | `ask-documents/route.ts` |
| Generated SQL Q&A | `ask-sql/route.ts` |
| SQL context rules | `ask-sql/db-context.md` |
| Newer chat replacement | `src/app/api/chat` |

## Generated SQL Rules
- Generated SQL must be read-only and table-allowlisted.
- Validate SQL before execution and reject mutation, DDL, multi-statement, or unsafe function patterns.
- Customer-scoped roles must be scoped through approved placeholders such as `{user_cost_center}`.
- Avoid personal contact detail exposure unless a route explicitly allows it.

## Reporting Rules
- Use `total_ex_vat` for turnover and active contracts for contract KPIs.
- Prefer `customer_kpis` for monthly KPI totals.
- Do not use raw invoice rows for high-level KPI totals unless clearly labeled as raw.

## Document/RAG Rules
- Keep answers grounded in retrieved CRM/document context.
- Use Voyage embeddings and vector search conventions already present in the route.
- Do not log uploaded document contents, generated SQL with sensitive literals, or full provider payloads.

## Verification
- For SQL changes, simulate blocked and allowed queries.
- For RAG changes, test missing-context and relevant-document paths.
- For answer-format changes, check current dashboard consumers before changing response keys.
