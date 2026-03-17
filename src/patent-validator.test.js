import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validatePatentDocument } from './patent-validator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_PATENT = `TITLE OF THE INVENTION
System and Method for Generating Patent Reviews

FIELD OF THE INVENTION
[0001] The present invention relates to automated analysis of patent documents,
and more particularly to systems and methods for generating structured reviews.

BACKGROUND OF THE INVENTION
[0002] Patent applications require careful review to ensure compliance with
statutory requirements. Existing methods are time-consuming and error-prone.
[0003] There is a need for automated tools that can assist patent practitioners
in identifying potential issues before filing.

SUMMARY OF THE INVENTION
[0004] In one embodiment, a computer-implemented method for analyzing patent
documents is provided. The method comprises receiving a document, extracting
text, and generating a structured review report.

BRIEF DESCRIPTION OF THE DRAWINGS
[0005] FIG. 1 is a block diagram illustrating the overall system architecture.
[0006] FIG. 2 is a flowchart illustrating the text extraction process.

DETAILED DESCRIPTION OF THE INVENTION
[0007] Referring now to FIG. 1, the system 100 comprises a document ingestion
module 102, a text extraction engine 104, and a review generation component 106.
[0008] In some embodiments, the text extraction engine 104 uses optical character
recognition to process scanned documents.
[0009] The review generation component 106 applies a set of heuristic rules
derived from USPTO examination guidelines to produce a structured report.

CLAIMS
What is claimed is:
1. A method for analyzing patent documents comprising:
   receiving a digital document from a user;
   extracting raw text from the digital document; and
   generating a structured review report based on the extracted text.

2. The method of claim 1, wherein extracting raw text comprises applying
   an optical character recognition algorithm.

ABSTRACT
A system and method for automated patent review that extracts text from a
submitted document and generates a structured analysis report identifying
potential issues with claims, description, and formal requirements.
`;

const NO_CLAIMS_TEXT = `TITLE OF THE INVENTION
A Widget Manufacturing Process

FIELD OF THE INVENTION
[0001] This invention relates to manufacturing processes for widgets.

BACKGROUND OF THE INVENTION
[0002] Widget manufacturing has historically involved manual labor.
[0003] Automated processes have been explored but not perfected.

SUMMARY OF THE INVENTION
[0004] The present invention provides an improved widget manufacturing process.

DETAILED DESCRIPTION OF THE INVENTION
[0005] The process involves heating a raw material to 400 degrees Celsius.
[0006] The heated material is then pressed into a mold of the desired shape.
[0007] After cooling, the widget is inspected for defects using optical sensors.
`;

const MISSING_OPTIONAL_SECTIONS = `TITLE OF THE INVENTION
A Simple Apparatus

DETAILED DESCRIPTION OF THE INVENTION
[0001] The apparatus comprises a housing and an internal mechanism.
[0002] The housing is formed from a rigid material such as aluminum.
[0003] The internal mechanism includes a gear train operably connected to a motor.
[0004] In operation, the motor drives the gear train to produce rotational output.
[0005] The rotational output may be coupled to an external load via a shaft.

CLAIMS
What is claimed is:
1. An apparatus comprising:
   a housing; and
   an internal mechanism disposed within the housing.

2. The apparatus of claim 1, wherein the internal mechanism includes a gear train.
`;

const NO_PARAGRAPH_MARKERS = `TITLE OF THE INVENTION
A Robust System

FIELD OF THE INVENTION
This invention relates to robust systems.

BACKGROUND OF THE INVENTION
Prior systems lacked robustness. There is a need for improved robustness.
This invention addresses that need by providing a novel architecture.

SUMMARY OF THE INVENTION
The present invention provides a robust system comprising several components.
Each component contributes to the overall robustness of the system.

BRIEF DESCRIPTION OF THE DRAWINGS
FIG. 1 shows the overall architecture of the robust system.

DETAILED DESCRIPTION OF THE INVENTION
The system includes a primary module and a secondary module. The primary module
handles input processing while the secondary module handles output rendering.
Both modules communicate via a message-passing interface defined herein.

CLAIMS
What is claimed is:
1. A robust system comprising:
   a primary module configured to process inputs; and
   a secondary module configured to render outputs.

ABSTRACT
A robust system with primary and secondary modules providing reliable operation.
`;

const WHAT_IS_CLAIMED_VARIANT = `TITLE OF THE INVENTION
Another Invention

FIELD OF THE INVENTION
[0001] This invention is in the field of computing.

BACKGROUND OF THE INVENTION
[0002] Computing devices have evolved significantly.
[0003] New approaches are needed to handle modern workloads.

SUMMARY OF THE INVENTION
[0004] The present invention provides a novel computing architecture.

DETAILED DESCRIPTION OF THE INVENTION
[0005] The architecture comprises multiple processing cores.
[0006] Each core is independently schedulable by the operating system.

What is claimed is:
1. A computing device comprising a plurality of independently schedulable cores.

ABSTRACT
A novel multi-core computing architecture for modern workloads.
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validatePatentDocument', () => {

  test('valid patent — all sections present, paragraph markers, correct metadata', () => {
    const result = validatePatentDocument(VALID_PATENT);

    assert.equal(result.isValid, true);
    assert.deepEqual(result.errors, []);

    assert.equal(result.metadata.hasClaimsSection, true);
    assert.equal(result.metadata.hasAbstract, true);
    assert.equal(result.metadata.hasBackground, true);
    assert.equal(result.metadata.hasSummary, true);
    assert.equal(result.metadata.hasBriefDescription, true);
    assert.equal(result.metadata.hasDetailedDescription, true);
    assert.equal(result.metadata.paragraphCount, 9);
    assert.ok(result.metadata.estimatedTokenCount > 0);
    assert.ok(result.metadata.title !== null);
    assert.ok(result.warnings.length === 0, `Unexpected warnings: ${result.warnings.join(', ')}`);
  });

  test('missing claims — isValid false, error about claims', () => {
    const result = validatePatentDocument(NO_CLAIMS_TEXT);

    assert.equal(result.isValid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(
      result.errors.some(e => /claims/i.test(e)),
      'Expected a claims-related error'
    );
    assert.equal(result.metadata.hasClaimsSection, false);
  });

  test('too short — isValid false, error about length', () => {
    const result = validatePatentDocument('This is way too short.');

    assert.equal(result.isValid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(
      result.errors.some(e => /too short/i.test(e)),
      'Expected a length-related error'
    );
  });

  test('valid but missing optional sections — warnings present, isValid true', () => {
    const result = validatePatentDocument(MISSING_OPTIONAL_SECTIONS);

    assert.equal(result.isValid, true);
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.length > 0, 'Expected at least one warning');
    assert.ok(
      result.warnings.some(w => /abstract/i.test(w)),
      'Expected warning about missing abstract'
    );
    assert.ok(
      result.warnings.some(w => /background/i.test(w)),
      'Expected warning about missing background'
    );

    assert.equal(result.metadata.hasClaimsSection, true);
    assert.equal(result.metadata.hasAbstract, false);
    assert.equal(result.metadata.hasBackground, false);
    assert.equal(result.metadata.hasDetailedDescription, true);
    assert.ok(result.metadata.paragraphCount > 0);
  });

  test('no paragraph markers — isValid true, warning about missing markers, paragraphCount 0', () => {
    const result = validatePatentDocument(NO_PARAGRAPH_MARKERS);

    assert.equal(result.isValid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.metadata.paragraphCount, 0);
    assert.ok(
      result.warnings.some(w => /numbered paragraphs/i.test(w)),
      'Expected warning about missing paragraph markers'
    );
  });

  test('"What is claimed is:" variant — claims section detected', () => {
    const result = validatePatentDocument(WHAT_IS_CLAIMED_VARIANT);

    assert.equal(result.isValid, true);
    assert.equal(result.metadata.hasClaimsSection, true);
    assert.ok(!result.errors.some(e => /claims/i.test(e)));
  });

  test('empty string — isValid false', () => {
    const result = validatePatentDocument('');

    assert.equal(result.isValid, false);
    assert.ok(result.errors.length > 0);
  });

  test('whitespace-only string — isValid false', () => {
    const result = validatePatentDocument('   \n\t  \n  ');

    assert.equal(result.isValid, false);
    assert.ok(result.errors.length > 0);
  });

  test('estimatedTokenCount is roughly length/4', () => {
    const result = validatePatentDocument(VALID_PATENT);
    const expected = Math.ceil(VALID_PATENT.trim().length / 4);
    assert.equal(result.metadata.estimatedTokenCount, expected);
  });

});
