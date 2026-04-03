/**
 * docx-parser.js — browser-compatible OOXML patent document parser.
 *
 * Parses a .docx ArrayBuffer directly from its XML to reconstruct patent
 * paragraph numbers ([0001], [0002], …) that mammoth.extractRawText() drops
 * because they are produced by Word's autonumbering engine, not literal text.
 *
 * Requires JSZip (global window.JSZip in browser, or the 'jszip' npm package
 * in Node). Uses DOMParser + getElementsByTagNameNS for XML parsing.
 *
 * Canonical source — do not copy-paste; import or inline where needed.
 */

// ─── Namespace URIs ────────────────────────────────────────────────────────

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

// ─── XML helpers ───────────────────────────────────────────────────────────

function parseXml(xmlString) {
  if (typeof DOMParser === 'undefined') {
    throw new Error(
      'DOMParser is not available in this environment. ' +
      'In Node.js, polyfill globalThis.DOMParser before importing this module.'
    );
  }
  return new DOMParser().parseFromString(xmlString, 'application/xml');
}

/** First child element with the given localName (namespace-agnostic). */
function firstChild(el, localName) {
  for (const node of el.childNodes) {
    if (node.nodeType === 1 && node.localName === localName) return node;
  }
  return null;
}

/** All child elements with the given localName. */
function children(el, localName) {
  const result = [];
  for (const node of el.childNodes) {
    if (node.nodeType === 1 && node.localName === localName) result.push(node);
  }
  return result;
}

/**
 * Read the w:val attribute from an element, trying both the prefixed form
 * (getAttribute) and the namespaced form as a fallback.
 */
function wVal(el) {
  if (!el) return null;
  return el.getAttribute('w:val') ?? el.getAttributeNS(W_NS, 'val') ?? null;
}

// ─── Exported helper: resolveNumbering ────────────────────────────────────

/**
 * Parse numbering.xml and styles.xml to discover which concrete numId uses
 * bracket-style paragraph numbering ([%1]) and which style names inherit it.
 *
 * @param {string} numberingXml
 * @param {string} stylesXml
 * @returns {{ numId: string, styleNames: Set<string> } | null}
 *   null means no bracket-numbering scheme was found — caller should fall back.
 */
export function resolveNumbering(numberingXml, stylesXml) {
  const numDoc    = parseXml(numberingXml);
  const stylesDoc = parseXml(stylesXml);

  // ── Step 1: find the abstractNumId whose level-0 lvlText contains [%1] ──
  let targetAbstractNumId = null;

  for (const abstractNum of numDoc.getElementsByTagNameNS(W_NS, 'abstractNum')) {
    for (const lvl of abstractNum.getElementsByTagNameNS(W_NS, 'lvl')) {
      const ilvl = lvl.getAttribute('w:ilvl') ?? lvl.getAttributeNS(W_NS, 'ilvl');
      if (ilvl !== '0') continue;
      const lvlText = firstChild(lvl, 'lvlText');
      const val     = wVal(lvlText);
      if (val && val.includes('[%1]')) {
        targetAbstractNumId =
          abstractNum.getAttribute('w:abstractNumId') ??
          abstractNum.getAttributeNS(W_NS, 'abstractNumId');
        break;
      }
    }
    if (targetAbstractNumId !== null) break;
  }

  if (targetAbstractNumId === null) return null;

  // ── Step 2: find the concrete numId that references this abstractNumId ──
  let targetNumId = null;

  for (const num of numDoc.getElementsByTagNameNS(W_NS, 'num')) {
    const abstractNumIdEl = firstChild(num, 'abstractNumId');
    if (wVal(abstractNumIdEl) === targetAbstractNumId) {
      targetNumId =
        num.getAttribute('w:numId') ?? num.getAttributeNS(W_NS, 'numId');
      break;
    }
  }

  if (targetNumId === null) return null;

  // ── Step 3: find styles that inherit this numId via their pPr/numPr ──
  const styleNames = new Set();

  for (const style of stylesDoc.getElementsByTagNameNS(W_NS, 'style')) {
    const pPr   = firstChild(style, 'pPr');
    const numPr = pPr ? firstChild(pPr, 'numPr') : null;
    if (!numPr) continue;
    const numIdEl = firstChild(numPr, 'numId');
    if (wVal(numIdEl) !== targetNumId) continue;

    // Record both the human-readable name and the style ID
    const nameEl  = firstChild(style, 'name');
    const nameVal = wVal(nameEl);
    if (nameVal) styleNames.add(nameVal);

    const styleId =
      style.getAttribute('w:styleId') ??
      style.getAttributeNS(W_NS, 'styleId');
    if (styleId) styleNames.add(styleId);
  }

  return { numId: targetNumId, styleNames };
}

// ─── Exported helper: extractParagraphText ────────────────────────────────

/**
 * Extract all text from a <w:p> element, collecting both <w:t> runs and
 * <m:t> math-text nodes in document order. Inserts a tab character for <w:tab>.
 *
 * @param {Element} paragraphEl — a <w:p> DOM element
 * @returns {string}
 */
export function extractParagraphText(paragraphEl) {
  const parts = [];
  _collectText(paragraphEl, parts, /* skipPPr */ true);
  return parts.join('');
}

function _collectText(el, parts, skipPPr) {
  for (const node of el.childNodes) {
    if (node.nodeType !== 1) continue;
    const ln = node.localName;

    // Skip paragraph/run property blocks — they contain no content text
    if (skipPPr && (ln === 'pPr' || ln === 'rPr')) continue;

    if (ln === 'rPr') continue; // always skip run properties

    if (ln === 't') {
      // Both <w:t> and <m:t> have localName 't'
      parts.push(node.textContent);
    } else if (ln === 'tab') {
      parts.push('\t');
    } else {
      _collectText(node, parts, false);
    }
  }
}

// ─── Exported helper: parseClaims ─────────────────────────────────────────

/**
 * Parse a flat array of RawParagraph objects (from the claims region) into
 * structured claim records with dependency tracking.
 *
 * @param {Array<{ number: string|null, text: string, style: string }>} claimParagraphs
 * @returns {Array<{ number: number, text: string, dependsOn: number|null }>}
 */
export function parseClaims(claimParagraphs) {
  const claims = [];
  let current  = null;

  for (const para of claimParagraphs) {
    const text = para.text.trim();
    if (!text) continue;

    // Skip the "What is claimed is:" or similar header lines
    if (/^(what\s+is\s+claimed\s+is\s*:|claims?\s*$|i\s+claim\s*:|we\s+claim\s*:)/i.test(text)) {
      continue;
    }

    // A new claim starts with a digit followed by a period: "1.", "12.", etc.
    const claimStart = text.match(/^(\d+)\.\s*/);
    if (claimStart) {
      if (current) claims.push(current);
      const num      = parseInt(claimStart[1], 10);
      const bodyText = text.slice(claimStart[0].length);
      current = {
        number:    num,
        text:      bodyText,
        dependsOn: _parseDependsOn(bodyText),
      };
    } else if (current) {
      // Continuation / limitation line of the current claim
      current.text += '\n' + text;
    }
  }

  if (current) claims.push(current);
  return claims;
}

function _parseDependsOn(text) {
  // Match "claim 1", "claims 1 and 3" (take the first referenced number)
  const m = text.match(/\bclaims?\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// ─── Exported helper: classifySections ────────────────────────────────────

/**
 * @typedef {{ number: string|null, text: string, style: string, isCentered: boolean }} RawParagraph
 */

/**
 * Group a flat array of RawParagraph objects into the document's section
 * structure (front-matter → sections → claims → abstract).
 *
 * @param {RawParagraph[]} paragraphs
 * @returns {Array}
 */
export function classifySections(paragraphs) {
  const sections    = [];
  let currentSection = null; // non-claims section being built
  let mode          = 'start';
  let claimParas    = [];

  // Push whatever non-claims section is in progress.
  const pushSection = () => {
    if (currentSection) { sections.push(currentSection); currentSection = null; }
  };

  // Resolve the claims buffer into a claims section entry.
  const pushClaims = () => {
    if (claimParas.length > 0) {
      sections.push({
        type:       'claims',
        heading:    null,
        paragraphs: undefined,
        claims:     parseClaims(claimParas),
        text:       null,
      });
      claimParas = [];
    }
  };

  // Flush whichever accumulator is active before switching modes.
  const flushActive = () => {
    if (mode === 'claims') pushClaims(); else pushSection();
  };

  for (const para of paragraphs) {
    const text = para.text.trim();
    if (!text) continue;

    // ── Claims section opener ──────────────────────────────────
    if (
      /^what\s+is\s+claimed\s+is\s*:/i.test(text) ||
      /^\s*claims\s*$/i.test(text)                 ||
      /^\s*i\s+claim\s*:/i.test(text)              ||
      /^\s*we\s+claim\s*:/i.test(text)
    ) {
      flushActive();
      mode       = 'claims';
      claimParas = [para]; // keep opener so parseClaims can skip it
      continue;
    }

    // ── Abstract heading (centered paragraph whose sole text is "Abstract") ─
    if (/^abstract$/i.test(text) && para.isCentered) {
      flushActive();
      mode           = 'abstract';
      currentSection = { type: 'abstract', heading: null, paragraphs: undefined, claims: undefined, text: '' };
      continue;
    }

    if (mode === 'claims')  { claimParas.push(para); continue; }
    if (mode === 'abstract') { currentSection.text = currentSection.text ? currentSection.text + '\n' + text : text; continue; }

    // ── Section heading ───────────────────────────────────────
    if (_isSectionHeadingPara(para)) {
      pushSection();
      mode           = 'section';
      currentSection = { type: 'section', heading: text, paragraphs: [], claims: undefined, text: null };
      continue;
    }

    // ── Regular paragraph ─────────────────────────────────────
    if (!currentSection) {
      mode           = 'front-matter';
      currentSection = { type: 'front-matter', heading: null, paragraphs: [], claims: undefined, text: null };
    }
    currentSection.paragraphs.push(para);
  }

  // Final flush
  if (mode === 'claims') pushClaims(); else pushSection();
  return sections;
}

function _isSectionHeadingPara(para) {
  const style = (para.style || '').toLowerCase();
  if (style === 'section' || style === 'sectionheading' || style.includes('section')) return true;

  // Fall back to content heuristic for centered unnumbered paragraphs
  if (para.isCentered && para.number === null) {
    const text = para.text.trim();
    return /^(background|field|summary|brief description|detailed description|description of|drawings|technical field|cross.reference)/i.test(text);
  }
  return false;
}

// ─── Internal: paragraph analysis helpers ─────────────────────────────────

function _isNumberedPara(pEl, numId, styleNames) {
  const pPr = firstChild(pEl, 'pPr');
  if (!pPr) return false;

  const pStyle   = firstChild(pPr, 'pStyle');
  const styleName = wVal(pStyle);

  // Check if the applied style implies bracket numbering
  if (styleName && styleNames.has(styleName)) {
    // An explicit numId="0" overrides the style and removes numbering
    const numPr   = firstChild(pPr, 'numPr');
    const numIdEl = numPr ? firstChild(numPr, 'numId') : null;
    if (numIdEl && wVal(numIdEl) === '0') return false;
    return true;
  }

  // Check for an inline numPr that references the target numId directly
  const numPr   = firstChild(pPr, 'numPr');
  const numIdEl = numPr ? firstChild(numPr, 'numId') : null;
  return wVal(numIdEl) === numId;
}

function _getParagraphStyle(pEl) {
  const pPr    = firstChild(pEl, 'pPr');
  const pStyle = pPr ? firstChild(pPr, 'pStyle') : null;
  return wVal(pStyle) || 'Normal';
}

function _isCenteredPara(pEl) {
  const pPr = firstChild(pEl, 'pPr');
  if (!pPr) return false;
  const jc  = firstChild(pPr, 'jc');
  return jc ? wVal(jc) === 'center' : false;
}

// ─── Internal: table text extraction ──────────────────────────────────────

function _tableText(tableEl) {
  const parts = [];
  _collectText(tableEl, parts, false);
  return parts.join('').trim();
}

// ─── Internal: title extraction from front-matter ─────────────────────────

function _extractTitle(sections) {
  const fm = sections.find(s => s.type === 'front-matter');
  if (!fm || !fm.paragraphs || fm.paragraphs.length === 0) return null;
  // First unnumbered paragraph is typically the title
  for (const p of fm.paragraphs) {
    if (p.number === null) return p.text.trim();
  }
  return fm.paragraphs[0].text.trim() || null;
}

// ─── Internal: build fullTextWithNumbers ──────────────────────────────────

function _buildFullText(sections) {
  const lines = [];

  for (const section of sections) {
    if (section.type === 'front-matter') {
      for (const p of (section.paragraphs || [])) {
        lines.push(p.number ? p.number + ' ' + p.text : p.text);
      }
    } else if (section.type === 'section') {
      lines.push('');
      lines.push(section.heading || '');
      for (const p of (section.paragraphs || [])) {
        lines.push(p.number ? p.number + ' ' + p.text : p.text);
      }
    } else if (section.type === 'claims') {
      lines.push('');
      lines.push('CLAIMS');
      lines.push('What is claimed is:');
      for (const claim of (section.claims || [])) {
        lines.push(claim.number + '. ' + claim.text);
      }
    } else if (section.type === 'abstract') {
      lines.push('');
      lines.push('ABSTRACT');
      if (section.text) lines.push(section.text);
    }
  }

  return lines.join('\n').trim();
}

// ─── Main exported function ───────────────────────────────────────────────

/**
 * Parse a .docx file's ArrayBuffer and return a structured patent document.
 *
 * Returns null when the document doesn't use bracket-style paragraph
 * autonumbering — the caller should fall back to mammoth in that case.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<object | null>}
 */
export async function parsePatentDocx(arrayBuffer) {
  // Resolve JSZip: global in browser, npm package in Node
  let JSZipCtor;
  if (typeof globalThis.JSZip !== 'undefined') {
    JSZipCtor = globalThis.JSZip;
  } else {
    const mod  = await import('jszip');
    JSZipCtor  = mod.default ?? mod;
  }

  const zip = await JSZipCtor.loadAsync(arrayBuffer);

  const [documentXml, numberingXml, stylesXml] = await Promise.all([
    zip.file('word/document.xml')?.async('string') ?? Promise.resolve(null),
    zip.file('word/numbering.xml')?.async('string') ?? Promise.resolve(null),
    zip.file('word/styles.xml')?.async('string')   ?? Promise.resolve(null),
  ]);

  if (!documentXml) return null;

  // Resolve numbering — null means fall back to mammoth
  const numberingInfo =
    numberingXml && stylesXml ? resolveNumbering(numberingXml, stylesXml) : null;
  if (!numberingInfo) return null;

  const { numId, styleNames } = numberingInfo;

  // Parse document body
  const docDom = parseXml(documentXml);
  const body   = docDom.getElementsByTagNameNS(W_NS, 'body')[0];
  if (!body) return null;

  let counter       = 0;
  const rawParagraphs = [];

  for (const child of body.childNodes) {
    if (child.nodeType !== 1) continue;
    const ln = child.localName;

    if (ln === 'p') {
      const text = extractParagraphText(child);
      if (!text.trim()) continue;

      const numbered = _isNumberedPara(child, numId, styleNames);
      let   number   = null;
      if (numbered) {
        counter++;
        number = '[' + String(counter).padStart(4, '0') + ']';
      }

      rawParagraphs.push({
        number,
        text,
        style:      _getParagraphStyle(child),
        isCentered: _isCenteredPara(child),
      });
    } else if (ln === 'tbl') {
      const text = _tableText(child);
      if (text) {
        rawParagraphs.push({ number: null, text, style: 'Table', isCentered: false });
      }
    }
    // sectPr and other body-level elements are intentionally ignored
  }

  // No numbered paragraphs found — signal caller to use mammoth fallback
  if (counter === 0) return null;

  const sections          = classifySections(rawParagraphs);
  const fullTextWithNumbers = _buildFullText(sections);

  return {
    title: _extractTitle(sections),
    sections,
    metadata: {
      totalNumberedParagraphs: counter,
      estimatedTokenCount:     Math.ceil(fullTextWithNumbers.length / 4),
      hasClaimsSection:        sections.some(s => s.type === 'claims'),
      hasAbstract:             sections.some(s => s.type === 'abstract'),
    },
    fullTextWithNumbers,
  };
}
