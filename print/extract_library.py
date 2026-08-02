#!/usr/bin/env python3
"""
extract_library.py — lift boilerplate figures out of a legacy firm .docx into a
tokenized library JSON.

Principle: paragraphs are stored as VERBATIM OOXML (preserving [0xxx] numbering,
math/OMML, indents, fonts). Only reference numbers inside <w:t> text are replaced
with tokens. Math (<m:t>) is never touched.

Tokens:
  {{fig}}SS            -> this figure's number + literal 2-digit suffix
  {{figref:N}}SS       -> a cross-referenced source figure N's number + suffix
  {{FIG:N}}            -> textual "FIG. 4" cross reference
"""
import re, json, sys, os, zipfile

WP = re.compile(r'<w:p\b(?:(?!</w:p>)[\s\S])*?</w:p>')
WT = re.compile(r'(<w:t(?:\s[^>]*)?>)(.*?)(</w:t>)', re.S)
NUM = re.compile(r'\b(\d{3,4})\b')

RUN = re.compile(r'<w:r\b(?![a-zA-Z])(?:(?!</w:r>)[\s\S])*?</w:r>')
RPR = re.compile(r'<w:rPr>[\s\S]*?</w:rPr>')
SIMPLE_T = re.compile(r'^<w:r\b[^>]*>(?:<w:rPr>[\s\S]*?</w:rPr>)?<w:t(?:\s[^>]*)?>[\s\S]*?</w:t></w:r>$')

def coalesce_runs(p):
    """Merge adjacent simple text runs sharing identical rPr, so tokens/numbers
    split across runs (e.g. '14'+'00') become contiguous. Runs containing tabs,
    breaks, fields, math or drawings are left untouched."""
    runs = list(RUN.finditer(p))
    if not runs:
        return p
    out, i = [], 0
    last_end = 0
    merged = []
    for m in runs:
        merged.append(m)
    result = p
    # rebuild paragraph by walking runs and merging neighbours that are adjacent in the string
    pieces = []
    cursor = 0
    group = []   # list of (rpr, text, match)
    def flush(group, pieces):
        if not group:
            return
        rpr = group[0][0]
        text = ''.join(g[1] for g in group)
        sp = ' xml:space="preserve"'
        pieces.append('<w:r>' + (rpr or '') + '<w:t' + sp + '>' + text + '</w:t></w:r>')
    for m in runs:
        run = m.group(0)
        if m.start() > cursor:
            flush(group, pieces); group = []
            pieces.append(p[cursor:m.start()])
        if SIMPLE_T.match(run):
            rpr_m = RPR.search(run)
            rpr = rpr_m.group(0) if rpr_m else ''
            t = re.search(r'<w:t(?:\s[^>]*)?>([\s\S]*?)</w:t>', run).group(1)
            if group and group[0][0] == rpr:
                group.append((rpr, t, m))
            else:
                flush(group, pieces); group = [(rpr, t, m)]
        else:
            flush(group, pieces); group = []
            pieces.append(run)
        cursor = m.end()
    flush(group, pieces)
    pieces.append(p[cursor:])
    return ''.join(pieces)


def paragraphs(document_xml):
    body = re.search(r'<w:body>([\s\S]*)</w:body>', document_xml).group(1)
    return WP.findall(body)

def wt_text(p):
    return ''.join(m.group(2) for m in WT.finditer(p))

def own_sets(paras):
    paras = [coalesce_runs(p) for p in paras]
    """Map figure number -> set of its own reference numbers, from Detailed Description."""
    starts = []
    for i, p in enumerate(paras):
        m = re.match(r'FIG\. (\d+)\b', re.sub(r'\s+', ' ', wt_text(p)).strip())
        if m:
            starts.append((i, int(m.group(1))))
    # keep only the Detailed Description run (last contiguous ascending pass)
    dd = [s for s in starts if s[0] > len(paras) * 0.2]
    blocks = {}
    for k, (idx, fig) in enumerate(dd):
        end = dd[k + 1][0] if k + 1 < len(dd) else len(paras)
        blocks.setdefault(fig, (idx, end))
    owns = {}
    for fig, (a, b) in blocks.items():
        s = set()
        for p in paras[a:b]:
            for n in NUM.findall(wt_text(p)):
                if int(n[:-2]) == fig:
                    s.add(n)
        owns[fig] = s
    return blocks, owns

MATTER_FIGS = {1, 2}   # matter-specific figures: never hard-code their numbers into boilerplate

SPLIT_FIG = re.compile(
    r'(FIGs?\.\s*)'                                     # "FIG. " possibly ending a run
    r'((?:</w:t></w:r>(?:<w:r\b[^>]*>)(?:<w:rPr>[\s\S]*?</w:rPr>)?<w:t(?:\s[^>]*)?>)?)'
    r'(\d+)')                                           # the figure number

def tokenize_split_fig_refs(p):
    """Tokenize 'FIG. 14' even when Word split it across two runs."""
    return SPLIT_FIG.sub(lambda m: m.group(1) + m.group(2) + '{{FIG:%s}}' % m.group(3), p)


def tokenize_paragraph(p, fig, owns):
    """Replace refnums inside <w:t> only. Leave <m:t> (math) untouched."""
    def fix_run(m):
        open_, text, close = m.group(1), m.group(2), m.group(3)

        def repl(nm):
            n = nm.group(1)
            prefix, suffix = int(n[:-2]), n[-2:]
            if prefix == fig:
                return '{{fig}}' + suffix
            # matter-specific figures (FIG 1/2): drop the number entirely, keep the prose
            if prefix in MATTER_FIGS and prefix in owns and n in owns[prefix]:
                return '\x00'          # sentinel: removed with its leading space below
            # cross-figure boilerplate: tokenize if that figure genuinely owns this number
            if prefix in owns and n in owns[prefix]:
                return '{{figref:%d}}%s' % (prefix, suffix)
            return n  # not a reference number (e.g. "1024" hidden dim) -> leave alone

        text = NUM.sub(repl, text)
        text = re.sub(r'\s*\x00', '', text)      # drop matter-specific refnums + their space
        # textual cross references: "FIG. 4" / "FIGs. 1 and 2"
        text = re.sub(r'FIGs\. ([\d, and]+)',
                      lambda m2: 'FIGs. ' + re.sub(r'(\d+)', lambda m3: '{{FIG:%s}}' % m3.group(1), m2.group(1)),
                      text)
        return open_ + text + close

    return WT.sub(fix_run, p)

CORRECTIONS = {
    14: [
        # spec said "initial values (block 1414)"; drawing says 1416. And hyperparameters had no number.
        (r'setting initial values of the machine-learning model \(block \{\{fig\}\}14\)',
         'setting initial values of the machine-learning model (block {{fig}}16)'),
        (r'Hyperparameters are also set that are used to control training',
         'Hyperparameters are also set (block {{fig}}14) that are used to control training'),
    ],
}

CLAIM_PLACEHOLDER = '// CLAIM 1 FEATURES //'

def apply_corrections(tok, fig):
    out = []
    for p in tok:
        for pat, rep in CORRECTIONS.get(fig, []):
            def fix(m):
                return m.group(1) + rep + m.group(3)
            p = WT.sub(lambda m: m.group(1) + re.sub(pat, rep, m.group(2)) + m.group(3), p)
        out.append(p)
    return out

def install_claim_placeholder(tok):
    """FIG16: replace the claim-1 body with the firm's standing placeholder.
    Rebuilds the paragraph as a single run (prose only, no math) so the cut point
    is not sensitive to how Word split the runs."""
    PHRASE = 'configured to execute instructions stored in memory subsystem'
    out = []
    for p in tok:
        full = wt_text(p)
        i = full.find(PHRASE)
        if i < 0:
            out.append(p); continue
        j = full.find(' to ', i + len(PHRASE))
        if j < 0:
            out.append(p); continue
        kept = full[:j + 4] + CLAIM_PLACEHOLDER + '.'
        ppr = re.search(r'<w:pPr>[\s\S]*?</w:pPr>', p)
        rpr = re.search(r'<w:rPr>[\s\S]*?</w:rPr>', p)
        p2 = ('<w:p>' + (ppr.group(0) if ppr else '')
              + '<w:r>' + (rpr.group(0) if rpr else '')
              + '<w:t xml:space="preserve">' + kept + '</w:t></w:r></w:p>')
        out.append(p2)
    return out


def extract(docx_path, figures, out_path, pack_name):
    with zipfile.ZipFile(docx_path) as z:
        doc = z.read('word/document.xml').decode('utf-8')
    paras = paragraphs(doc)
    blocks, owns = own_sets(paras)

    items = []
    for fig in figures:
        if fig not in blocks:
            print('  ! FIG %d not found' % fig); continue
        a, b = blocks[fig]
        seg = paras[a:b]
        seg = [coalesce_runs(p) for p in seg]
        tok = [tokenize_paragraph(p, fig, owns) for p in seg]
        tok = [tokenize_split_fig_refs(p) for p in tok]
        tok = apply_corrections(tok, fig)
        if fig == 16:
            tok = install_claim_placeholder(tok)
        intro = re.sub(r'\s+', ' ', wt_text(seg[0])).strip()
        m = re.match(r'FIG\. \d+ (?:shows an example of|shows|is|depicts) (.*?)(?: according to| in an example)', intro)
        if not m:
            m = re.match(r'FIG\. \d+ is a flow diagram depicting (.*?)(?: in an example| according to)', intro)
        name = m.group(1).strip() if m else intro[:60]
        name = re.sub(r'\s*\b\d{3,4}\b', '', name).strip()   # drop embedded refnums
        name = re.sub(r'^an? ', 'a ', name) if name.startswith(('a ','an ')) else name
        # external figures this block depends on
        ext = sorted({int(m) for p in tok for m in re.findall(r'\{\{figref:(\d+)\}\}', p)})
        items.append({
            'kind': 'figure',
            'id': 'fig%d-%s' % (fig, re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:40]),
            'sourceFig': fig,
            'name': name,
            'category': 'diagram',
            'refnums': sorted(owns[fig]),
            'dependsOnFigures': ext,
            'paragraphs': tok,
        })
        print('  FIG %-2d %-46s paras=%-3d refs=%-3d math=%-3d deps=%s'
              % (fig, name[:46], len(tok), len(owns[fig]),
                 sum(p.count('<m:oMath>') for p in tok), ext or '-'))

    lib = {'schema': 'fenix-library@1', 'name': pack_name, 'items': items}
    json.dump(lib, open(out_path, 'w'), indent=1)
    print('\nwrote %s (%.0f KB, %d items)' % (out_path, os.path.getsize(out_path) / 1024, len(items)))
    return lib

if __name__ == '__main__':
    extract(sys.argv[1], [int(x) for x in sys.argv[2].split(',')], sys.argv[3],
            sys.argv[4] if len(sys.argv) > 4 else 'Untitled pack')
