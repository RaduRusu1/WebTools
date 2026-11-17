'use client'

import { useState, useCallback, useEffect } from 'react'
import { toast } from 'sonner'

/* ================================================================
   SQL INDENTATION FIXER — pure function, no line joins/splits
   ================================================================ */

type IndentUnit = '  ' | '    ' | '        ' | '\t'

interface FormatState {
  indentLevel: number
  stack: string[] // tracks block types: 'BEGIN','IF','CASE','PAREN','WHILE','LOOP','TRY','CATCH'
  inBlockComment: boolean
  pendingSingleIndent: boolean // for single-statement IF/ELSE bodies
}

/** Strip leading whitespace and return trimmed + original leading ws length */
function stripLeading(line: string): [string, number] {
  const m = line.match(/^(\s*)/)
  const ws = m?.[1] ?? ''
  return [line.slice(ws.length), ws.length]
}

/** Remove string literals, quoted identifiers, and comments from a line for keyword detection.
 *  Returns the "code-only" portion. Handles multi-line block comment state. */
function extractCode(
  line: string,
  inBlockComment: boolean
): { code: string; stillInBlockComment: boolean } {
  let result = ''
  let i = 0
  let inBC = inBlockComment

  while (i < line.length) {
    if (inBC) {
      const endIdx = line.indexOf('*/', i)
      if (endIdx === -1) {
        return { code: result, stillInBlockComment: true }
      }
      i = endIdx + 2
      inBC = false
      continue
    }

    const ch = line[i]

    // line comment
    if (ch === '-' && line[i + 1] === '-') {
      return { code: result, stillInBlockComment: false }
    }

    // block comment start
    if (ch === '/' && line[i + 1] === '*') {
      const endIdx = line.indexOf('*/', i + 2)
      if (endIdx === -1) {
        return { code: result, stillInBlockComment: true }
      }
      i = endIdx + 2
      continue
    }

    // single-quoted string
    if (ch === "'") {
      i++
      while (i < line.length) {
        if (line[i] === "'" && line[i + 1] === "'") { i += 2; continue }
        if (line[i] === "'") { i++; break }
        i++
      }
      result += "'x'"
      continue
    }

    // double-quoted identifier
    if (ch === '"') {
      i++
      while (i < line.length && line[i] !== '"') i++
      if (i < line.length) i++
      result += '"x"'
      continue
    }

    // bracket-quoted identifier [xxx]
    if (ch === '[') {
      i++
      while (i < line.length && line[i] !== ']') i++
      if (i < line.length) i++
      result += '[x]'
      continue
    }

    result += ch
    i++
  }

  return { code: result, stillInBlockComment: inBC }
}

/** Normalize code for keyword matching */
function norm(code: string): string {
  return code.replace(/\s+/g, ' ').trim().toUpperCase()
}

/** Check if normalized code matches a pattern at word boundary */
function matchKw(normalized: string, kw: string): boolean {
  // Match keyword as whole word (not part of a larger identifier)
  const regex = new RegExp('\\b' + kw.replace(/\s+/g, '\\s+') + '\\b')
  return regex.test(normalized)
}

function formatSQL(input: string, indentStr: IndentUnit): string {
  const lines = input.split(/\r?\n/)
  const result: string[] = []
  const state: FormatState = {
    indentLevel: 0,
    stack: [],
    inBlockComment: false,
    pendingSingleIndent: false,
  }

  for (let li = 0; li < lines.length; li++) {
    const rawLine = lines[li]
    const [trimmed] = stripLeading(rawLine)

    // Blank or whitespace-only line: preserve as empty
    if (trimmed.length === 0) {
      result.push('')
      // If we had a pending single indent, a blank line doesn't consume it
      continue
    }

    // If we're fully inside a block comment, leave line untouched for content
    // but still track if the comment ends
    if (state.inBlockComment) {
      const { stillInBlockComment } = extractCode(trimmed, true)
      state.inBlockComment = stillInBlockComment
      // Indent block comment content at current level
      result.push(indentStr.repeat(Math.max(0, state.indentLevel)) + trimmed)
      continue
    }

    // Extract code portion for keyword analysis
    const { code, stillInBlockComment } = extractCode(trimmed, false)
    state.inBlockComment = stillInBlockComment
    const n = norm(code)

    // --- Determine indent adjustments ---
    let dedentBefore = 0
    let indentAfter = 0
    let consumedPending = false

    // Count open/close parens in this line
    const openParens = (code.match(/\(/g) ?? []).length
    const closeParens = (code.match(/\)/g) ?? []).length
    const netParens = openParens - closeParens

    // Closing parens at start of line: dedent before
    if (/^\s*\)/.test(code)) {
      // Pop paren levels from stack
      let popping = closeParens - openParens
      while (popping > 0 && state.stack.length > 0) {
        const top = state.stack[state.stack.length - 1]
        if (top === 'PAREN') {
          state.stack.pop()
          dedentBefore++
          popping--
        } else {
          break
        }
      }
    }

    // END (various forms) — dedent for the END line itself
    if (matchKw(n, 'END') || matchKw(n, 'END;') || /^END\b/.test(n)) {
      // Check what we're ending
      if (matchKw(n, 'END TRY')) {
        // pop until TRY
        while (state.stack.length > 0 && state.stack[state.stack.length - 1] !== 'TRY') state.stack.pop()
        if (state.stack.length > 0) state.stack.pop()
        dedentBefore++
      } else if (matchKw(n, 'END CATCH')) {
        while (state.stack.length > 0 && state.stack[state.stack.length - 1] !== 'CATCH') state.stack.pop()
        if (state.stack.length > 0) state.stack.pop()
        dedentBefore++
      } else if (matchKw(n, 'END IF')) {
        while (state.stack.length > 0 && state.stack[state.stack.length - 1] !== 'IF') state.stack.pop()
        if (state.stack.length > 0) state.stack.pop()
        dedentBefore++
      } else if (matchKw(n, 'END LOOP')) {
        while (state.stack.length > 0 && state.stack[state.stack.length - 1] !== 'LOOP') state.stack.pop()
        if (state.stack.length > 0) state.stack.pop()
        dedentBefore++
      } else if (/^END\b/.test(n)) {
        // Generic END — pop to nearest BEGIN
        while (state.stack.length > 0 && state.stack[state.stack.length - 1] !== 'BEGIN') state.stack.pop()
        if (state.stack.length > 0) state.stack.pop()
        dedentBefore++
      }
    }

    // ELSE — dedent for ELSE line, then indent after
    if (/^ELSE\b/.test(n) && !matchKw(n, 'ELSEIF') && !matchKw(n, 'ELSIF')) {
      // If the top of stack is a single-statement IF body, pop it
      dedentBefore++
      // Check if next line has BEGIN; if not, set pending single indent
      // Actually for ELSE, we dedent to IF level, then indent contents
      // Look ahead: if the ELSE has BEGIN on same line, indent after is from BEGIN
      if (matchKw(n, 'ELSE') && !matchKw(n, 'BEGIN')) {
        // Single statement ELSE — indent next line
        state.pendingSingleIndent = true
      }
    }

    // ELSIF/ELSEIF — dedent for this line, then indent contents
    if (/^(ELSIF|ELSEIF)\b/.test(n)) {
      dedentBefore++
      // These act like IF — indent the next block
      if (matchKw(n, 'THEN')) {
        // ELSIF ... THEN on same line
        state.pendingSingleIndent = true
      }
    }

    // WHEN inside CASE — dedent/indent tracking
    if (/^WHEN\b/.test(n)) {
      // WHEN is at CASE+1 level, it's already indented by CASE
      // No change needed — it stays at current level within CASE
    }

    // CASE END — handled by generic END above but let's check for inline END in CASE context
    // This is handled by the generic END block above

    // BEGIN CATCH — dedent END TRY is handled above, now indent for CATCH
    if (matchKw(n, 'BEGIN CATCH')) {
      dedentBefore++ // align with BEGIN TRY
      state.stack.push('CATCH')
      indentAfter++
    }
    // BEGIN TRY
    else if (matchKw(n, 'BEGIN TRY')) {
      state.stack.push('TRY')
      indentAfter++
    }
    // BEGIN (generic)
    else if (/^BEGIN\b/.test(n) && !matchKw(n, 'BEGIN TRY') && !matchKw(n, 'BEGIN CATCH')) {
      // If we had a pending single indent from IF/ELSE, cancel it
      state.pendingSingleIndent = false
      state.stack.push('BEGIN')
      indentAfter++
    }

    // IF ... THEN (PL/SQL style) or standalone IF
    if (/^IF\b/.test(n) && !matchKw(n, 'END IF')) {
      state.stack.push('IF')
      if (matchKw(n, 'THEN')) {
        // IF ... THEN on same line — indent contents
        indentAfter++
      } else {
        // T-SQL style IF — if next line isn't BEGIN, single indent
        // We'll check: set pending, and cancel if BEGIN comes
        state.pendingSingleIndent = true
      }
    }

    // WHILE
    if (/^WHILE\b/.test(n)) {
      // If no BEGIN follows on same line, single indent
      if (!matchKw(n, 'BEGIN')) {
        state.pendingSingleIndent = true
      }
    }

    // LOOP (PL/SQL)
    if (/\bLOOP\s*$/.test(n) && !matchKw(n, 'END LOOP')) {
      state.stack.push('LOOP')
      indentAfter++
    }

    // CASE
    if (/\bCASE\b/.test(n) && !/\bEND\b/.test(n)) {
      state.stack.push('CASE')
      indentAfter++
    }
    // END (for CASE) when line is just END or END as part of expression
    // Already handled by generic END above

    // Handle pending single indent from previous IF/ELSE/WHILE
    if (state.pendingSingleIndent && !/^(BEGIN|IF|ELSE|ELSIF|ELSEIF|WHILE)\b/.test(n)) {
      // This line is the single indented statement
      consumedPending = true
    }

    // Apply net parens for indent after
    if (netParens > 0) {
      for (let p = 0; p < netParens; p++) {
        state.stack.push('PAREN')
      }
      indentAfter += netParens
    } else if (netParens < 0 && !/^\s*\)/.test(code)) {
      // Closing parens not at start — just adjust stack
      let rem = -netParens
      while (rem > 0 && state.stack.length > 0 && state.stack[state.stack.length - 1] === 'PAREN') {
        state.stack.pop()
        rem--
      }
    }

    // Calculate this line's indent
    let thisLineIndent = state.indentLevel - dedentBefore
    if (state.pendingSingleIndent && !consumedPending && !/^(BEGIN|ELSE|ELSIF|ELSEIF|END)\b/.test(n)) {
      // Don't add pending indent yet
    }
    if (consumedPending) {
      thisLineIndent = state.indentLevel // already has the +1 from pending
    }

    thisLineIndent = Math.max(0, thisLineIndent)

    // Output the line
    result.push(indentStr.repeat(thisLineIndent) + trimmed)

    // Update indent level for next line
    state.indentLevel = Math.max(0, state.indentLevel - dedentBefore + indentAfter)

    // Handle pending indent
    if (consumedPending) {
      state.pendingSingleIndent = false
      // After the single statement, go back to previous indent
      // The indentLevel should already be correct from the IF/WHILE line
    } else if (state.pendingSingleIndent && !/^(IF|ELSE|ELSIF|ELSEIF|WHILE|BEGIN)\b/.test(n)) {
      // Apply the pending +1 for the next line
      state.indentLevel++
    }
  }

  return result.join('\n')
}

/* ================================================================
   XML-AWARE WRAPPER
   ================================================================ */

function isXmlLine(line: string): boolean {
  const t = line.trim()
  return /^<[?!/]|^<[a-zA-Z]/.test(t) || /^<\/[a-zA-Z]/.test(t) || t === ']]>' || t === '-->'
}

function containsXml(input: string): boolean {
  return /<\?xml|<!\/|<!\[CDATA\[|<\/[a-zA-Z]|<[a-zA-Z][^>]*>/.test(input)
}

function formatWithXmlAwareness(input: string, indentStr: IndentUnit): string {
  if (!containsXml(input)) {
    return formatSQL(input, indentStr)
  }

  const lines = input.split(/\r?\n/)
  const result: string[] = []
  let sqlBuffer: string[] = []
  let sqlBaseIndent = ''
  let inCdata = false

  function flushSql() {
    if (sqlBuffer.length === 0) return
    const formatted = formatSQL(sqlBuffer.join('\n'), indentStr)
    const fmtLines = formatted.split('\n')
    for (const fl of fmtLines) {
      result.push(sqlBaseIndent + fl)
    }
    sqlBuffer = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // Check for CDATA start
    if (trimmed.includes('<![CDATA[')) {
      flushSql()
      // If CDATA start is on its own line or with XML
      if (trimmed === '<![CDATA[' || !trimmed.includes(']]>')) {
        result.push(line)
        inCdata = true
        // Extract base indent for SQL inside CDATA
        const m = line.match(/^(\s*)/)
        sqlBaseIndent = (m?.[1] ?? '') + indentStr
        continue
      } else {
        // CDATA start and end on same line
        result.push(line)
        continue
      }
    }

    // Check for CDATA end
    if (inCdata && trimmed.includes(']]>')) {
      flushSql()
      inCdata = false
      result.push(line)
      continue
    }

    if (inCdata) {
      // Inside CDATA — collect as SQL
      sqlBuffer.push(trimmed)
      continue
    }

    // Outside CDATA — check if this is an XML line
    if (isXmlLine(line)) {
      flushSql()
      result.push(line) // leave XML lines byte-for-byte unchanged
    } else if (containsXml(line)) {
      flushSql()
      result.push(line) // mixed XML/content line — leave unchanged
    } else {
      // Non-XML, non-CDATA — could be SQL between XML tags
      // If we're between XML elements, treat as SQL
      sqlBuffer.push(line)
    }
  }

  flushSql()
  return result.join('\n')
}

/* ================================================================
   SELF-TESTS (run on mount, logged to console)
   ================================================================ */

function runSelfTests(indent: IndentUnit) {
  const tests: { name: string; input: string }[] = [
    {
      name: 'IF/ELSE with BEGIN/END',
      input:
        'IF @x > 0\nBEGIN\nSELECT 1\nEND\nELSE\nBEGIN\nSELECT 2\nEND',
    },
    {
      name: 'TRY/CATCH',
      input:
        'BEGIN TRY\nSELECT 1/0\nEND TRY\nBEGIN CATCH\nSELECT ERROR_MESSAGE()\nEND CATCH',
    },
    {
      name: 'Nested CASE',
      input:
        'SELECT\nCASE\nWHEN a = 1 THEN\nCASE\nWHEN b = 2 THEN \'x\'\nELSE \'y\'\nEND\nELSE \'z\'\nEND AS val\nFROM t',
    },
    {
      name: 'XML-wrapped SQL',
      input:
        '<?xml version="1.0"?>\n<root>\n<![CDATA[\nSELECT *\nFROM users\nWHERE id = 1\n]]>\n</root>',
    },
  ]

  let allPassed = true
  for (const t of tests) {
    const output = formatWithXmlAwareness(t.input, indent)
    const inLines = t.input.split(/\r?\n/)
    const outLines = output.split(/\r?\n/)

    // Check line count preserved
    const lineCountOk = inLines.length === outLines.length

    // Check non-whitespace content preserved on each line
    let contentOk = true
    for (let i = 0; i < inLines.length; i++) {
      const inContent = (inLines[i] ?? '').trim()
      const outContent = (outLines[i] ?? '').trim()
      if (inContent !== outContent) {
        contentOk = false
        console.warn(
          `[SQLFormatter self-test "${t.name}"] line ${i + 1} content mismatch:`,
          { expected: inContent, got: outContent }
        )
      }
    }

    const passed = lineCountOk && contentOk
    if (!passed) allPassed = false
    console.log(
      `[SQLFormatter self-test] ${passed ? '✓' : '✗'} ${t.name} — lines: ${inLines.length}→${outLines.length}, content: ${contentOk ? 'OK' : 'MISMATCH'}`
    )
  }
  console.log(
    allPassed
      ? '[SQLFormatter] All self-tests passed ✓'
      : '[SQLFormatter] Some self-tests FAILED ✗'
  )
}

/* ================================================================
   UI COMPONENT
   ================================================================ */

const INDENT_OPTIONS: { label: string; value: IndentUnit }[] = [
  { label: '2 spaces', value: '  ' },
  { label: '4 spaces', value: '    ' },
  { label: '8 spaces', value: '        ' },
  { label: 'TAB', value: '\t' },
]

export default function SqlFormatterClient() {
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [indentUnit, setIndentUnit] = useState<IndentUnit>('    ')
  const [copied, setCopied] = useState(false)

  // Run self-tests on mount
  useEffect(() => {
    runSelfTests('    ')
  }, [])

  const handleFormat = useCallback(() => {
    if (!input.trim()) {
      toast.error('Paste some SQL first.')
      return
    }
    try {
      const formatted = formatWithXmlAwareness(input, indentUnit)
      setOutput(formatted)
    } catch (err: any) {
      console.error('Formatting error:', err)
      toast.error('Formatting failed — see console for details.')
    }
  }, [input, indentUnit])

  const handleCopy = useCallback(async () => {
    if (!output) return
    try {
      await navigator.clipboard.writeText(output)
      setCopied(true)
      toast.success('Copied to clipboard!')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Copy failed — try selecting and copying manually.')
    }
  }, [output])

  return (
    <div className="min-h-screen bg-background py-10 px-4 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1200px]">
        {/* Title */}
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-3 mb-3">
            <svg
              width="36"
              height="36"
              viewBox="0 0 36 36"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="text-primary"
            >
              <rect width="36" height="36" rx="8" className="fill-primary/10" />
              <path
                d="M10 11h4l2 3-2 3h-4l2-3-2-3zM20 11h4l2 3-2 3h-4l2-3-2-3zM10 20h4l2 3-2 3h-4l2-3-2-3zM20 20h4l2 3-2 3h-4l2-3-2-3z"
                className="fill-primary"
              />
            </svg>
            <h1 className="text-3xl sm:text-4xl font-display font-bold tracking-tight text-foreground">
              SQL Formatter
            </h1>
          </div>
          <p className="text-muted-foreground text-sm sm:text-base max-w-xl mx-auto">
            Paste your SQL (or XML containing SQL), choose an indent style, and
            fix the indentation. Line count and content are never changed.
          </p>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <label
            htmlFor="indent-select"
            className="text-sm font-medium text-foreground"
          >
            Indent:
          </label>
          <select
            id="indent-select"
            value={indentUnit}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
              setIndentUnit(e.target.value as IndentUnit)
            }
            className="rounded-md border border-input bg-card text-card-foreground px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {INDENT_OPTIONS.map((o) => (
              <option key={o.label} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <button
            onClick={handleFormat}
            className="ml-auto rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 active:scale-[0.98]"
          >
            Fix Indentation
          </button>
        </div>

        {/* Text areas */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Input */}
          <div className="flex flex-col">
            <span className="text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wide">
              Input
            </span>
            <textarea
              className="code-area flex-1 min-h-[420px] w-full rounded-lg border border-input bg-card text-card-foreground p-4 shadow-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground/50"
              placeholder="Paste SQL here…"
              value={input}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                setInput(e.target.value)
              }
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
            />
          </div>

          {/* Output */}
          <div className="flex flex-col">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Output
              </span>
              {output && (
                <button
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground transition hover:bg-secondary/80 focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {copied ? (
                    <>
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                      Copied
                    </>
                  ) : (
                    <>
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                      Copy
                    </>
                  )}
                </button>
              )}
            </div>
            <textarea
              className="code-area flex-1 min-h-[420px] w-full rounded-lg border border-input bg-muted/40 text-card-foreground p-4 shadow-sm focus:outline-none"
              value={output}
              readOnly
              spellCheck={false}
              tabIndex={-1}
            />
          </div>
        </div>

        {/* Footer hint */}
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Supports BEGIN/END, IF/ELSE, TRY/CATCH, CASE/WHEN, WHILE, LOOP,
          subqueries, and XML-wrapped SQL.
        </p>
      </div>
    </div>
  )
}
