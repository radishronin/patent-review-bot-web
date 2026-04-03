/**
 * docx-parser.test.js
 *
 * Tests the exported helper functions from docx-parser.js using Node's
 * built-in test runner. @xmldom/xmldom polyfills DOMParser so the module's
 * XML parsing works in Node.
 *
 * Run: node --test src/docx-parser.test.js
 */

// ── DOMParser polyfill (must happen before importing the module) ───────────
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';
globalThis.DOMParser = XmlDomParser;

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveNumbering,
  extractParagraphText,
  classifySections,
  parseClaims,
  parseFrontMatter,
} from './docx-parser.js';

// ─── XML Fixtures ─────────────────────────────────────────────────────────
// Minimal but structurally accurate OOXML fragments that mirror the real
// numbering.xml / styles.xml patterns documented in the task brief.

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

/** Build a minimal numbering.xml with bracket-format level text. */
function makeNumberingXml(abstractNumId = '2', numId = '2', lvlText = '[%1]') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:numbering xmlns:w="${W}">
  <w:abstractNum w:abstractNumId="${abstractNumId}">
    <w:multiLevelType w:val="multilevel"/>
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:lvlText w:val="${lvlText}"/>
      <w:lvlJc w:val="left"/>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="${numId}">
    <w:abstractNumId w:val="${abstractNumId}"/>
  </w:num>
</w:numbering>`;
}

/** Build a minimal styles.xml with a "Numbering" custom style that uses numId. */
function makeStylesXml(numId = '2') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="${W}">
  <w:style w:type="paragraph" w:styleId="Numbering" w:customStyle="1">
    <w:name w:val="Numbering"/>
    <w:pPr>
      <w:numPr>
        <w:ilvl w:val="0"/>
        <w:numId w:val="${numId}"/>
      </w:numPr>
    </w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
</w:styles>`;
}

/** Build a <w:p> XML string — inline numPr (Pattern B). */
function makeNumberedParaXml(text, numId = '2') {
  return `<w:p xmlns:w="${W}">
  <w:pPr>
    <w:pStyle w:val="Normal"/>
    <w:numPr>
      <w:ilvl w:val="0"/>
      <w:numId w:val="${numId}"/>
    </w:numPr>
  </w:pPr>
  <w:r><w:t>${text}</w:t></w:r>
</w:p>`;
}

/** Build an unnumbered <w:p> with the "Numbering" style but numId overridden to 0. */
function makeUnNumberedOverrideXml(text) {
  return `<w:p xmlns:w="${W}">
  <w:pPr>
    <w:pStyle w:val="Numbering"/>
    <w:numPr>
      <w:ilvl w:val="0"/>
      <w:numId w:val="0"/>
    </w:numPr>
  </w:pPr>
  <w:r><w:t>${text}</w:t></w:r>
</w:p>`;
}

/** Build a paragraph with mixed <w:t> and <m:t> inline math. */
function makeMathParaXml(prefix, mathSymbol, suffix) {
  return `<w:p xmlns:w="${W}" xmlns:m="${M}">
  <w:pPr><w:pStyle w:val="Normal"/></w:pPr>
  <w:r><w:t xml:space="preserve">${prefix}</w:t></w:r>
  <m:oMath>
    <m:r><m:t xml:space="preserve">${mathSymbol}</m:t></m:r>
  </m:oMath>
  <w:r><w:t xml:space="preserve">${suffix}</w:t></w:r>
</w:p>`;
}

/** Parse an XML fragment string into an Element using the polyfilled DOMParser. */
function parseEl(xmlStr) {
  return new DOMParser().parseFromString(xmlStr, 'application/xml').documentElement;
}

// ─── Tests: resolveNumbering ──────────────────────────────────────────────

describe('resolveNumbering', () => {

  test('finds numId and styleNames for standard patent numbering scheme', () => {
    const result = resolveNumbering(makeNumberingXml(), makeStylesXml());
    assert.ok(result !== null, 'Should return a result object, not null');
    assert.equal(result.numId, '2');
    assert.ok(result.styleNames.has('Numbering'), 'Should include the "Numbering" style');
    assert.ok(result.styleNames.has('Numbering'), 'Should include styleId "Numbering"');
  });

  test('returns null when no bracket lvlText [%1] is present', () => {
    const nonBracketNumbering = makeNumberingXml('1', '1', '%1.');
    const result = resolveNumbering(nonBracketNumbering, makeStylesXml('1'));
    assert.equal(result, null);
  });

  test('returns null when no num references the abstractNum', () => {
    // abstractNumId="2" but num references "99"
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<w:numbering xmlns:w="${W}">
  <w:abstractNum w:abstractNumId="2">
    <w:lvl w:ilvl="0">
      <w:lvlText w:val="[%1]"/>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="2">
    <w:abstractNumId w:val="99"/>
  </w:num>
</w:numbering>`;
    const result = resolveNumbering(xml, makeStylesXml());
    assert.equal(result, null);
  });

  test('works when abstractNumId and numId differ', () => {
    // abstractNumId=5, numId=3
    const result = resolveNumbering(makeNumberingXml('5', '3'), makeStylesXml('3'));
    assert.ok(result !== null);
    assert.equal(result.numId, '3');
    assert.ok(result.styleNames.has('Numbering'));
  });

  test('styleNames is empty when no styles reference the numId', () => {
    // styles.xml uses numId=9 but numbering uses numId=2
    const result = resolveNumbering(makeNumberingXml(), makeStylesXml('9'));
    assert.ok(result !== null);
    assert.equal(result.numId, '2');
    assert.equal(result.styleNames.size, 0);
  });

});

// ─── Tests: extractParagraphText ─────────────────────────────────────────

describe('extractParagraphText', () => {

  test('extracts text from a simple <w:r><w:t> run', () => {
    const el = parseEl(makeNumberedParaXml('Hello, world'));
    assert.equal(extractParagraphText(el), 'Hello, world');
  });

  test('extracts inline math symbols from <m:t> interleaved with <w:t>', () => {
    const el = parseEl(makeMathParaXml('where ', 'σ', ' refers to'));
    const text = extractParagraphText(el);
    assert.ok(text.includes('where '), 'Should include prefix text');
    assert.ok(text.includes('σ'),      'Should include math symbol');
    assert.ok(text.includes(' refers to'), 'Should include suffix text');
  });

  test('inserts tab character for <w:tab/>', () => {
    const xml = `<w:p xmlns:w="${W}">
      <w:pPr><w:pStyle w:val="Normal"/></w:pPr>
      <w:r><w:t>1.</w:t><w:tab/><w:t>A method comprising:</w:t></w:r>
    </w:p>`;
    const text = extractParagraphText(parseEl(xml));
    assert.ok(text.includes('\t'), 'Should contain a tab character');
    assert.ok(text.includes('1.'), 'Should include claim number text');
    assert.ok(text.includes('A method comprising:'));
  });

  test('returns empty string for a paragraph with no text nodes', () => {
    const xml = `<w:p xmlns:w="${W}"><w:pPr><w:pStyle w:val="Normal"/></w:pPr></w:p>`;
    assert.equal(extractParagraphText(parseEl(xml)), '');
  });

  test('does not include pPr content in extracted text', () => {
    // The pStyle value "Normal" should NOT appear in the extracted text
    const el = parseEl(makeNumberedParaXml('Actual content'));
    const text = extractParagraphText(el);
    assert.ok(!text.includes('Normal'), 'Should not include pStyle value');
    assert.equal(text, 'Actual content');
  });

  test('concatenates multiple <w:r> runs in order', () => {
    const xml = `<w:p xmlns:w="${W}">
      <w:pPr><w:pStyle w:val="Normal"/></w:pPr>
      <w:r><w:t xml:space="preserve">First </w:t></w:r>
      <w:r><w:t xml:space="preserve">second </w:t></w:r>
      <w:r><w:t>third</w:t></w:r>
    </w:p>`;
    assert.equal(extractParagraphText(parseEl(xml)), 'First second third');
  });

});

// ─── Tests: parseClaims ───────────────────────────────────────────────────

describe('parseClaims', () => {

  const header = { number: null, text: 'What is claimed is:', style: 'Normal', isCentered: false };
  const c1     = { number: null, text: '1.\tA method comprising:', style: 'Normal', isCentered: false };
  const c1cont = { number: null, text: '   extracting text from a document;', style: 'Normal', isCentered: false };
  const c2     = { number: null, text: '2.\tThe method of claim 1, wherein the text is extracted via OCR.', style: 'Normal', isCentered: false };
  const c3     = { number: null, text: '3.\tThe method of claims 1 and 2, further comprising:', style: 'Normal', isCentered: false };
  const c4ind  = { number: null, text: '4.\tAn apparatus comprising a housing.', style: 'Normal', isCentered: false };

  test('parses a single independent claim', () => {
    const claims = parseClaims([header, c1]);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].number, 1);
    assert.ok(claims[0].text.includes('method comprising'));
    assert.equal(claims[0].dependsOn, null);
  });

  test('skips the "What is claimed is:" header', () => {
    const claims = parseClaims([header, c1, c2]);
    assert.equal(claims.length, 2);
    assert.equal(claims[0].number, 1);
  });

  test('claim continuation lines are appended to claim text', () => {
    const claims = parseClaims([header, c1, c1cont, c2]);
    assert.equal(claims.length, 2);
    assert.ok(claims[0].text.includes('extracting text'), 'Continuation should be appended');
  });

  test('parses dependsOn from "claim X" reference', () => {
    const claims = parseClaims([header, c1, c2]);
    assert.equal(claims[1].number, 2);
    assert.equal(claims[1].dependsOn, 1);
  });

  test('parses dependsOn from "claims X and Y" — takes first number', () => {
    const claims = parseClaims([header, c1, c2, c3]);
    const claim3 = claims.find(c => c.number === 3);
    assert.equal(claim3.dependsOn, 1);
  });

  test('independent claim has dependsOn null', () => {
    const claims = parseClaims([header, c4ind]);
    assert.equal(claims[0].dependsOn, null);
  });

  test('handles empty input', () => {
    assert.deepEqual(parseClaims([]), []);
  });

  test('handles input with only the header', () => {
    assert.deepEqual(parseClaims([header]), []);
  });

  test('handles multiple claims without header', () => {
    const claims = parseClaims([c1, c2, c4ind]);
    assert.equal(claims.length, 3);
    assert.equal(claims[0].number, 1);
    assert.equal(claims[1].number, 2);
    assert.equal(claims[2].number, 4);
  });

});

// ─── Tests: classifySections ──────────────────────────────────────────────

describe('classifySections', () => {

  /** Convenience factory for a RawParagraph */
  const p = (text, number = null, style = 'Normal', isCentered = false) =>
    ({ text, number, style, isCentered });

  const titlePara       = p('System and Method for Patent Review');
  const fieldHeading    = p('FIELD OF THE INVENTION', null, 'SECTION');
  const fieldBody       = p('The invention relates to patent review.', '[0001]');
  const bgHeading       = p('BACKGROUND OF THE INVENTION', null, 'SECTION');
  const bgBody          = p('Prior art lacks automated review.', '[0002]');
  const claimsHeader    = p('What is claimed is:');
  const claim1          = p('1.\tA method comprising:');
  const claim2          = p('2.\tThe method of claim 1, wherein:');
  const abstractHeading = p('Abstract', null, 'Normal', /* isCentered */ true);
  const abstractBody    = p('A system for automated patent review.');

  test('front-matter section contains paragraphs before first heading', () => {
    const sections = classifySections([titlePara, fieldHeading, fieldBody]);
    const fm = sections.find(s => s.type === 'front-matter');
    assert.ok(fm, 'Should have a front-matter section');
    assert.ok(fm.paragraphs.some(para => para.text === titlePara.text));
  });

  test('section headings create new sections', () => {
    const sections = classifySections([titlePara, fieldHeading, fieldBody, bgHeading, bgBody]);
    const sectionTypes = sections.filter(s => s.type === 'section');
    assert.equal(sectionTypes.length, 2);
    assert.equal(sectionTypes[0].heading, 'FIELD OF THE INVENTION');
    assert.equal(sectionTypes[1].heading, 'BACKGROUND OF THE INVENTION');
  });

  test('section paragraphs are placed under correct heading', () => {
    const sections = classifySections([fieldHeading, fieldBody, bgHeading, bgBody]);
    const fieldSection = sections.find(s => s.heading === 'FIELD OF THE INVENTION');
    assert.ok(fieldSection);
    assert.equal(fieldSection.paragraphs.length, 1);
    assert.equal(fieldSection.paragraphs[0].text, fieldBody.text);
  });

  test('claims section is created on "What is claimed is:"', () => {
    const sections = classifySections([fieldHeading, fieldBody, claimsHeader, claim1, claim2]);
    const claimsSection = sections.find(s => s.type === 'claims');
    assert.ok(claimsSection, 'Should have a claims section');
    assert.ok(Array.isArray(claimsSection.claims));
    assert.ok(claimsSection.claims.length >= 1);
  });

  test('claims are parsed within claims section', () => {
    const sections = classifySections([claimsHeader, claim1, claim2]);
    const claimsSection = sections.find(s => s.type === 'claims');
    assert.ok(claimsSection.claims.find(c => c.number === 1));
    assert.ok(claimsSection.claims.find(c => c.number === 2));
  });

  test('abstract section is created on centered "Abstract" paragraph', () => {
    const sections = classifySections([claimsHeader, claim1, abstractHeading, abstractBody]);
    const abs = sections.find(s => s.type === 'abstract');
    assert.ok(abs, 'Should have an abstract section');
    assert.ok(abs.text.includes('automated patent review'));
  });

  test('non-centered "abstract" text does not trigger abstract section', () => {
    const nonCentered = p('abstract discussion', null, 'Normal', false);
    const sections = classifySections([fieldHeading, nonCentered]);
    const abs = sections.find(s => s.type === 'abstract');
    assert.equal(abs, undefined, 'Should NOT create abstract section for non-centered para');
  });

  test('SECTION style paragraphs trigger section creation', () => {
    const sections = classifySections([p('SUMMARY', null, 'SECTION'), fieldBody]);
    const sec = sections.find(s => s.type === 'section' && s.heading === 'SUMMARY');
    assert.ok(sec);
  });

  test('empty paragraph list returns empty sections', () => {
    assert.deepEqual(classifySections([]), []);
  });

  test('full document produces all four section types', () => {
    const paragraphs = [
      titlePara,
      fieldHeading, fieldBody,
      bgHeading, bgBody,
      claimsHeader, claim1, claim2,
      abstractHeading, abstractBody,
    ];
    const sections = classifySections(paragraphs);
    const types = sections.map(s => s.type);
    assert.ok(types.includes('front-matter'));
    assert.ok(types.includes('section'));
    assert.ok(types.includes('claims'));
    assert.ok(types.includes('abstract'));
  });

  test('numbered paragraphs retain their [XXXX] number in sections', () => {
    const sections = classifySections([fieldHeading, fieldBody]);
    const fieldSection = sections.find(s => s.type === 'section');
    assert.equal(fieldSection.paragraphs[0].number, '[0001]');
  });

  test('front-matter section is enriched with parseFrontMatter metadata', () => {
    const pb = (text, isCentered = false, isBold = false) =>
      ({ text, number: null, style: 'Normal', isCentered, isBold });
    const paragraphs = [
      pb('UNITED STATES PATENT APPLICATION', true, true),
      pb('FOR', true, true),
      pb('Method for Automated Review', true, true), // title
      { text: 'FIELD OF THE INVENTION', number: null, style: 'SECTION', isCentered: false, isBold: false },
    ];
    const sections = classifySections(paragraphs);
    const fm = sections.find(s => s.type === 'front-matter');
    assert.ok(fm, 'Should have a front-matter section');
    assert.equal(fm.title, 'Method for Automated Review');
  });

});

// ─── Tests: parseFrontMatter ──────────────────────────────────────────────

describe('parseFrontMatter', () => {

  /** Convenience factory for a RawParagraph with bold/centered flags */
  const p = (text, isCentered = false, isBold = false) =>
    ({ text, number: null, style: 'Normal', isCentered, isBold });

  // Cover-page boilerplate paragraphs
  const usApp       = p('UNITED STATES PATENT APPLICATION', true, true);
  const forPara     = p('FOR', true, true);
  const titlePara   = p('System for Automated Patent Review', true, true);
  const titlePara2  = p('Style Transfer for Multi-layer Documents', true, true);
  const emptyPara   = p('');

  // Inventor section
  const invLabel    = p('Inventors:', true, false);
  const inventor1   = p('John Doe', true, false);
  const inventor2   = p('Jane Smith', true, false);

  // Docket / client ref
  const docketPara  = p('Attorney Docket No.: 8828-604', true, false);
  const clientPara  = p('Client Reference No.: P14254-US', true, false);

  test('extracts title as first centered+bold paragraph after "FOR"', () => {
    const fm = parseFrontMatter([usApp, forPara, titlePara]);
    assert.equal(fm.title, 'System for Automated Patent Review');
  });

  test('skips empty paragraphs between "FOR" and title', () => {
    const fm = parseFrontMatter([forPara, emptyPara, emptyPara, titlePara]);
    assert.equal(fm.title, 'System for Automated Patent Review');
  });

  test('"UNITED STATES PATENT APPLICATION" is NOT returned as title', () => {
    const fm = parseFrontMatter([usApp, forPara, titlePara]);
    assert.notEqual(fm.title, 'UNITED STATES PATENT APPLICATION');
    assert.notEqual(fm.title, 'FOR');
  });

  test('returns null title when "FOR" anchor is absent', () => {
    // Without the "FOR" anchor, no title is extracted
    const fm = parseFrontMatter([usApp, titlePara]);
    assert.equal(fm.title, null);
  });

  test('returns null title when nothing after "FOR" is centered+bold', () => {
    const notBold = p('Some text', true, false);
    const fm = parseFrontMatter([forPara, notBold]);
    assert.equal(fm.title, null);
  });

  test('extracts inventor names after "Inventors:" label', () => {
    const fm = parseFrontMatter([forPara, titlePara, invLabel, inventor1, inventor2, docketPara]);
    assert.deepEqual(fm.inventors, ['John Doe', 'Jane Smith']);
  });

  test('stops inventor extraction at docket line', () => {
    const fm = parseFrontMatter([invLabel, inventor1, docketPara, inventor2]);
    assert.equal(fm.inventors.length, 1);
    assert.equal(fm.inventors[0], 'John Doe');
  });

  test('skips empty lines within inventor section', () => {
    const fm = parseFrontMatter([invLabel, emptyPara, inventor1, emptyPara, inventor2, docketPara]);
    assert.deepEqual(fm.inventors, ['John Doe', 'Jane Smith']);
  });

  test('extracts attorney docket number', () => {
    const fm = parseFrontMatter([docketPara]);
    assert.equal(fm.docketNumber, '8828-604');
  });

  test('extracts client reference number', () => {
    const fm = parseFrontMatter([clientPara]);
    assert.equal(fm.clientRef, 'P14254-US');
  });

  test('handles combined docket + clientRef on separate lines', () => {
    const fm = parseFrontMatter([docketPara, clientPara]);
    assert.equal(fm.docketNumber, '8828-604');
    assert.equal(fm.clientRef, 'P14254-US');
  });

  test('returns empty inventors array when no "Inventors:" heading present', () => {
    const fm = parseFrontMatter([usApp, forPara, titlePara]);
    assert.deepEqual(fm.inventors, []);
  });

  test('all fields null/empty for empty paragraph list', () => {
    const fm = parseFrontMatter([]);
    assert.equal(fm.title, null);
    assert.deepEqual(fm.inventors, []);
    assert.equal(fm.docketNumber, null);
    assert.equal(fm.clientRef, null);
  });

  test('title repeat pattern: second title occurrence still extracted correctly', () => {
    // Template repeats the title before the first section heading
    const fm = parseFrontMatter([usApp, forPara, titlePara2, invLabel, inventor1, docketPara, titlePara2]);
    // Should still get the first occurrence after FOR
    assert.equal(fm.title, 'Style Transfer for Multi-layer Documents');
  });

});
