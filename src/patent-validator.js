/**
 * Patent document validator — pure JS, no dependencies, browser-compatible.
 * Takes raw text from mammoth.extractRawText and checks if it looks like
 * a US patent application.
 */

const CLAIMS_PATTERNS = [
  /^\s*claims\s*$/im,
  /^\s*what\s+is\s+claimed\s+is\s*:/im,
  /^\s*what\s+is\s+claimed\s*:/im,
  /^\s*i\s+claim\s*:/im,
  /^\s*we\s+claim\s*:/im,
];

const SECTION_CHECKS = [
  {
    key: 'hasAbstract',
    name: 'Abstract',
    patterns: [/abstract\s+of\s+the\s+disclosure/i, /\babstract\b/i],
  },
  {
    key: 'hasBackground',
    name: 'Background',
    patterns: [
      /background\s+of\s+the\s+invention/i,
      /field\s+of\s+the\s+invention/i,
      /technical\s+field/i,
      /\bbackground\b/i,
    ],
  },
  {
    key: 'hasSummary',
    name: 'Summary',
    patterns: [/summary\s+of\s+the\s+invention/i, /\bsummary\b/i],
  },
  {
    key: 'hasBriefDescription',
    name: 'Brief Description of Drawings',
    patterns: [
      /brief\s+description\s+of\s+the\s+drawings/i,
      /brief\s+description\s+of\s+the\s+figures/i,
      /description\s+of\s+the\s+drawings/i,
    ],
  },
  {
    key: 'hasDetailedDescription',
    name: 'Detailed Description',
    patterns: [
      /detailed\s+description\s+of\s+the\s+invention/i,
      /description\s+of\s+embodiments/i,
      /description\s+of\s+the\s+preferred\s+embodiment/i,
      /detailed\s+description/i,
    ],
  },
];

const PARAGRAPH_MARKER_RE = /\[0{0,3}\d+\]/g;

/**
 * Check whether rawText contains a section heading. Patterns are tested
 * against each line of the text (trimmed) so we don't false-positive on
 * mid-paragraph occurrences of generic words like "summary".
 */
function detectSection(lines, patterns) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const pat of patterns) {
      if (pat.test(trimmed)) return true;
    }
  }
  return false;
}

function detectClaims(lines) {
  for (const line of lines) {
    for (const pat of CLAIMS_PATTERNS) {
      if (pat.test(line)) return true;
    }
  }
  return false;
}

function extractTitle(lines) {
  // Look for a non-empty line before any section heading or paragraph marker.
  // Heuristic: first non-empty line that doesn't look like a section heading
  // and isn't a paragraph marker.
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (PARAGRAPH_MARKER_RE.test(trimmed)) {
      PARAGRAPH_MARKER_RE.lastIndex = 0;
      continue;
    }
    PARAGRAPH_MARKER_RE.lastIndex = 0;
    // Skip common section headings
    if (/^(abstract|background|summary|claims|field|technical\s+field|detailed\s+description|brief\s+description)/i.test(trimmed)) continue;
    return trimmed;
  }
  return null;
}

/**
 * @param {string} rawText
 * @returns {{ isValid: boolean, errors: string[], warnings: string[], metadata: object }}
 */
export function validatePatentDocument(rawText) {
  const errors = [];
  const warnings = [];

  const trimmed = typeof rawText === 'string' ? rawText.trim() : '';

  // --- Hard errors ---
  if (trimmed.length < 500) {
    errors.push('Document is too short to be a patent application (less than 500 characters).');
    return {
      isValid: false,
      errors,
      warnings,
      metadata: {
        title: null,
        paragraphCount: 0,
        hasClaimsSection: false,
        hasAbstract: false,
        hasDetailedDescription: false,
        hasSummary: false,
        hasBackground: false,
        hasBriefDescription: false,
        estimatedTokenCount: Math.ceil(trimmed.length / 4),
      },
    };
  }

  const lines = trimmed.split('\n');

  const hasClaimsSection = detectClaims(lines);
  if (!hasClaimsSection) {
    errors.push('No claims section detected. A patent application must include a claims section.');
  }

  // --- Paragraph markers ---
  const markerMatches = trimmed.match(PARAGRAPH_MARKER_RE) || [];
  const paragraphCount = markerMatches.length;
  if (paragraphCount === 0) {
    warnings.push('No numbered paragraphs ([XXXX]) detected. Paragraph-level feedback will not be available.');
  }

  // --- Optional sections ---
  const sectionResults = {};
  for (const section of SECTION_CHECKS) {
    const found = detectSection(lines, section.patterns);
    sectionResults[section.key] = found;
    if (!found) {
      warnings.push(`No ${section.name} section detected.`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    metadata: {
      title: extractTitle(lines),
      paragraphCount,
      hasClaimsSection,
      hasAbstract: sectionResults.hasAbstract,
      hasDetailedDescription: sectionResults.hasDetailedDescription,
      hasSummary: sectionResults.hasSummary,
      hasBackground: sectionResults.hasBackground,
      hasBriefDescription: sectionResults.hasBriefDescription,
      estimatedTokenCount: Math.ceil(trimmed.length / 4),
    },
  };
}
