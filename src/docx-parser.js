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
 * Read the w:val attribute, trying the prefixed form then the namespaced form.
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
 */
export function resolveNumbering(numberingXml, stylesXml) {
  const numDoc    = parseXml(numberingXml);
  const stylesDoc = parseXml(stylesXml);

  // Step 1: find the abstractNumId whose level-0 lvlText contains [%1]
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

  // Step 2: find the concrete numId that references this abstractNumId
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

  // Step 3: find styles that inherit this numId via their pPr/numPr
  const styleNames = new Set();

  for (const style of stylesDoc.getElementsByTagNameNS(W_NS, 'style')) {
    const pPr   = firstChild(style, 'pPr');
    const numPr = pPr ? firstChild(pPr, 'numPr') : null;
    if (!numPr) continue;
    const numIdEl = firstChild(numPr, 'numId');
    if (wVal(numIdEl) !== targetNumId) continue;

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
 * @param {Element} paragraphEl
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

    if (skipPPr && (ln === 'pPr' || ln === 'rPr')) continue;
    if (ln === 'rPr') continue;

    if (ln === 't') {
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

    if (/^(what\s+is\s+claimed\s+is\s*:|claims?\s*$|i\s+claim\s*:|we\s+claim\s*:)/i.test(text)) {
      continue;
    }

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
      current.text += '\n' + text;
    }
  }

  if (current) claims.push(current);
  return claims;
}

function _parseDependsOn(text) {
  const m = text.match(/\bclaims?\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// ─── Bold detection helpers ────────────────────────────────────────────────

/**
 * True if an rPr element contains an active <w:b/> element.
 * <w:b/> with no val or val="true"/"1" → bold.
 * <w:b w:val="false"/"0" → explicitly not bold.
 */
function _hasBold(rPrEl) {
  const b = firstChild(rPrEl, 'b');
  if (!b) return false;
  const val = wVal(b);
  return val === null || val === '' || val === 'true' || val === '1';
}

/**
 * True if the paragraph has bold formatting in its paragraph default rPr
 * or in any of its runs.
 */
function _isBoldPara(pEl) {
  const pPr = firstChild(pEl, 'pPr');
  if (pPr) {
    const rPr = firstChild(pPr, 'rPr');
    if (rPr && _hasBold(rPr)) return true;
  }
  for (const node of pEl.childNodes) {
    if (node.nodeType === 1 && node.localName === 'r') {
      const rPr = firstChild(node, 'rPr');
      if (rPr && _hasBold(rPr)) return true;
    }
  }
  return false;
}

// ─── Exported helper: parseFrontMatter ────────────────────────────────────

/**
 * @typedef {{ number: string|null, text: string, style: string, isCentered: boolean, isBold: boolean }} RawParagraph
 */

/**
 * Extract structured metadata from front-matter RawParagraph objects.
 *
 * Uses the fixed cover-page structure of our firm's patent template:
 *   "UNITED STATES PATENT APPLICATION" → "FOR" → title → inventors → docket info
 *
 * Title heuristic: first centered+bold paragraph after the "FOR" anchor
 * (skipping any empty paragraphs). Robust against boilerplate that appears
 * before "FOR".
 *
 * @param {RawParagraph[]} paragraphs
 * @returns {{ title: string|null, inventors: string[], docketNumber: string|null, clientRef: string|null }}
 */
export function parseFrontMatter(paragraphs) {
  let title        = null;
  const inventors  = [];
  let docketNumber = null;
  let clientRef    = null;

  // ── Title: first centered+bold paragraph after the centered "FOR" line ──
  let forIdx = -1;
  for (let i = 0; i < paragraphs.length; i++) {
    if (/^for$/i.test(paragraphs[i].text.trim()) && paragraphs[i].isCentered) {
      forIdx = i;
      break;
    }
  }

  if (forIdx >= 0) {
    for (let i = forIdx + 1; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      if (!p.text.trim()) continue;
      if (p.isCentered && p.isBold) {
        title = p.text.trim();
        break;
      }
    }
  }

  // ── Inventors: centered non-bold paragraphs after an "Inventor(s):" label ──
  let inventorAnchorIdx = -1;
  for (let i = 0; i < paragraphs.length; i++) {
    if (/^inventors?:\s*$/i.test(paragraphs[i].text.trim())) {
      inventorAnchorIdx = i;
      break;
    }
  }

  if (inventorAnchorIdx >= 0) {
    for (let i = inventorAnchorIdx + 1; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      const t = p.text.trim();
      if (!t) continue;
      // Stop at docket/attorney/phone lines or any bold label ending with ":"
      if (/attorney\s+docket|client\s+ref|docket\s+no|phone|fax|email|\d{3}[-.\s]\d{3}/i.test(t)) break;
      if (p.isBold && /:\s*$/.test(t)) break;
      if (p.isCentered && !p.isBold) inventors.push(t);
    }
  }

  // ── Docket / client ref: scan all paragraphs ──
  for (const p of paragraphs) {
    const t = p.text.trim();
    if (!docketNumber) {
      const dm = t.match(/attorney\s+docket\s+(?:no\.?|number)?\s*:?\s*(.+)/i);
      if (dm) docketNumber = dm[1].trim();
    }
    if (!clientRef) {
      const cm = t.match(/client\s+ref(?:erence)?\s+(?:no\.?|number)?\s*:?\s*(.+)/i);
      if (cm) clientRef = cm[1].trim();
    }
  }

  return { title, inventors, docketNumber, clientRef };
}

// ─── Exported helper: classifySections ────────────────────────────────────

/**
 * Group a flat array of RawParagraph objects into the document's section
 * structure (front-matter → sections → claims → abstract).
 *
 * Front-matter sections are enriched with parsed metadata via parseFrontMatter.
 *
 * @param {RawParagraph[]} paragraphs
 * @returns {Array}
 */
export function classifySections(paragraphs) {
  const sections     = [];
  let currentSection = null;
  let mode           = 'start';
  let claimParas     = [];

  const pushSection = () => {
    if (!currentSection) return;
    if (currentSection.type === 'front-matter') {
      const fm = parseFrontMatter(currentSection.paragraphs);
      currentSection.title        = fm.title;
      currentSection.inventors    = fm.inventors;
      currentSection.docketNumber = fm.docketNumber;
      currentSection.clientRef    = fm.clientRef;
    }
    sections.push(currentSection);
    currentSection = null;
  };

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

  const flushActive = () => {
    if (mode === 'claims') pushClaims(); else pushSection();
  };

  for (const para of paragraphs) {
    const text = para.text.trim();
    if (!text) continue;

    // ── Claims section opener ─────────────────────────────────
    if (
      /^what\s+is\s+claimed\s+is\s*:/i.test(text) ||
      /^\s*claims\s*$/i.test(text)                 ||
      /^\s*i\s+claim\s*:/i.test(text)              ||
      /^\s*we\s+claim\s*:/i.test(text)
    ) {
      flushActive();
      mode       = 'claims';
      claimParas = [para];
      continue;
    }

    // ── Abstract heading ──────────────────────────────────────
    if (/^abstract$/i.test(text) && para.isCentered) {
      flushActive();
      mode           = 'abstract';
      currentSection = { type: 'abstract', heading: null, paragraphs: undefined, claims: undefined, text: '' };
      continue;
    }

    if (mode === 'claims')   { claimParas.push(para); continue; }
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

  if (mode === 'claims') pushClaims(); else pushSection();
  return sections;
}

function _isSectionHeadingPara(para) {
  const style = (para.style || '').toLowerCase();
  if (style === 'section' || style === 'sectionheading' || style.includes('section')) return true;

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

  const pStyle    = firstChild(pPr, 'pStyle');
  const styleName = wVal(pStyle);

  if (styleName && styleNames.has(styleName)) {
    const numPr   = firstChild(pPr, 'numPr');
    const numIdEl = numPr ? firstChild(numPr, 'numId') : null;
    if (numIdEl && wVal(numIdEl) === '0') return false;
    return true;
  }

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

// ─── Internal: title from front-matter ────────────────────────────────────

function _extractTitle(sections) {
  const fm = sections.find(s => s.type === 'front-matter');
  return (fm && fm.title) ? fm.title : null;
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

  const numberingInfo =
    numberingXml && stylesXml ? resolveNumbering(numberingXml, stylesXml) : null;
  if (!numberingInfo) return null;

  const { numId, styleNames } = numberingInfo;

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
        isBold:     _isBoldPara(child),
      });
    } else if (ln === 'tbl') {
      const text = _tableText(child);
      if (text) {
        rawParagraphs.push({ number: null, text, style: 'Table', isCentered: false, isBold: false });
      }
    }
  }

  if (counter === 0) return null;

  const sections            = classifySections(rawParagraphs);
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
