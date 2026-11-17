# WebTools

A collection of small browser-based web tools.

## Tools

### SqlFormatter

**Live:** https://sqlformatter.abacusai.app · **Source:** [`SqlFormatter/`](SqlFormatter/)

A browser-based tool that fixes the indentation of SQL, or of XML that contains SQL.

#### How to use
1. Paste text (SQL, or XML containing SQL) into the input box.
2. Pick an indentation: **2 spaces**, **4 spaces**, **8 spaces** or **TAB**.
3. Click **Fix Indentation**.
4. The re-indented result appears in a read-only output box. Click **Copy** to copy it to the clipboard.

#### What it does
- Changes **only leading whitespace**. It never moves text between lines, so the line count and all non-whitespace content stay exactly the same.
- Indents blocks: `BEGIN`/`END`, `IF`/`ELSE`/`END IF`, `BEGIN TRY`/`BEGIN CATCH`, `WHILE`, `LOOP`, and `CASE ... WHEN ... THEN ... ELSE ... END` spanning several lines.
- Indents multi-line parentheses and subqueries.
- Ignores keywords inside string literals, quoted identifiers and comments (`--` and `/* */`).
- **XML-aware:** XML markup is left untouched; only the SQL sections (for example inside `<![CDATA[ ... ]]>`) are re-indented.

#### Technical notes
- Next.js + React + Tailwind CSS. All formatting runs in the browser (`SqlFormatter/app/components/sql-formatter-client.tsx`).
- No authentication and no persistence: nothing you paste is sent to or stored on a server.
- Run locally: `cd SqlFormatter && yarn install && yarn dev`, then open http://localhost:3000.
