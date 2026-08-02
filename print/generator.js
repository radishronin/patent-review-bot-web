/* PatentCore-Local generator: builds .docx and .vsdx from a project model.
   Runs identically under Node (for testing) and in the browser (embedded).
   Requires a global ASSETS object (the embedded firm template package). */
(function (root) {
  "use strict";

  // ---------- tiny utilities ----------
  function strToU8(s) { return new TextEncoder().encode(s); }
  function b64ToU8(b64) {
    var bin = (typeof atob === "function") ? atob(b64)
              : Buffer.from(b64, "base64").toString("binary");
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i) & 0xff;
    return u;
  }
  function xesc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ---------- minimal ZIP (store, no compression) ----------
  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(files) { // files: [{name, data:Uint8Array}]
    var chunks = [], central = [], offset = 0;
    function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
    function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }
    files.forEach(function (f) {
      var nameU8 = strToU8(f.name), crc = crc32(f.data), sz = f.data.length;
      var lh = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0x21), // fixed dos time
        u32(crc), u32(sz), u32(sz), u16(nameU8.length), u16(0));
      chunks.push(new Uint8Array(lh)); chunks.push(nameU8); chunks.push(f.data);
      var cd = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x21),
        u32(crc), u32(sz), u32(sz), u16(nameU8.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(offset));
      central.push(new Uint8Array(cd)); central.push(nameU8);
      offset += lh.length + nameU8.length + sz;
    });
    var cdStart = offset, cdLen = 0;
    central.forEach(function (c) { cdLen += c.length; });
    var eocd = [].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(cdLen), u32(cdStart), u16(0));
    var all = chunks.concat(central); all.push(new Uint8Array(eocd));
    var total = 0; all.forEach(function (a) { total += a.length; });
    var out = new Uint8Array(total), p = 0;
    all.forEach(function (a) { out.set(a, p); p += a.length; });
    return out;
  }

  // ---------- reference numbers (single source of truth) ----------
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  // diagram component j -> j*5 ; flowchart step j -> (j+1)*5
  function refSuffix(idx, isFlow) { return pad2((isFlow ? (idx + 1) : idx) * 5); }
  function docxRef(figNum, idx, isFlow) { return String(figNum) + refSuffix(idx, isFlow); }

  function capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }
  function norm(s) { return String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " "); }
  function stepText(s) { return (s && typeof s === "object") ? (s.text || "") : String(s == null ? "" : s); }
  function figRefPhrase(figs) {
    if (!figs || !figs.length) return "";
    if (figs.length === 1) return "FIG. " + figs[0];
    return "FIGs. " + figs.slice(0, -1).join(", ") + " and " + figs[figs.length - 1];
  }
  // derive shared elements from diagram components: normalized name -> {display, figs:[figNums]}
  function buildElementMap(figures) {
    var map = {};
    (figures || []).forEach(function (fig, i) {
      if (fig.category === "flowchart") return;
      (fig.items || []).forEach(function (name) {
        var k = norm(name); if (!k) return;
        if (!map[k]) map[k] = { display: name, figs: [] };
        if (map[k].figs.indexOf(i + 1) < 0) map[k].figs.push(i + 1);
      });
    });
    return map;
  }
  // Summary paragraphs generated from independent claims (near-verbatim, with light replacements)
  function summaryParas(project) {
    var inds = (project.claims || []).filter(function (c) { return c.independent; });
    if (!inds.length) return [numberingPlaceholder("{SUMMARY}")];
    var field = (project.matter && project.matter.field) || "{FIELD}";
    var pre = "A method, apparatus, non-transitory computer readable medium, and system for " + field
      + " are described. One or more aspects of the method, apparatus, non-transitory computer readable medium, and system include ";
    return inds.map(function (c) {
      var b = (c.limitations || []).map(function (l) { return l.replace(/\bwherein\b/g, "where"); }).join(" ");
      return bodyText(pre + b);
    });
  }

  // ---------- claim parsing ----------
  function parseClaims(raw) {
    var out = [], cur = null;
    (raw || "").split(/\r?\n/).forEach(function (line) {
      var m = line.match(/^\s*(\d+)\s*[\.\)]\s*(.*)$/);
      if (m) { if (cur) out.push(cur); cur = { num: parseInt(m[1], 10), preamble: m[2].trim(), limitations: [] }; }
      else if (line.trim() && cur) cur.limitations.push(line.trim());
    });
    if (cur) out.push(cur);
    out.forEach(function (c) {
      var p = c.preamble;
      c.independent = !/^the\s+(method|system|apparatus|non-transitory|computer)/i.test(p);
      c.type = /system/i.test(p) ? "system"
        : /(non-transitory|computer\s+readable\s+medium)/i.test(p) ? "crm"
        : /apparatus/i.test(p) ? "apparatus" : "method";
    });
    return out;
  }

  // ============================================================
  //  DOCX
  // ============================================================
  var RPR = '<w:rPr><w:sz w:val="24"/><w:rFonts w:ascii="Times New Roman" w:cs="Times New Roman" w:hAnsi="Times New Roman"/></w:rPr>';
  function run(text) { return '<w:r>' + RPR + '<w:t xml:space="preserve">' + xesc(text) + '</w:t></w:r>'; }
  function bodyPara(inner) {
    return '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'
      + '<w:jc w:val="both"/><w:ind w:firstLine="0" w:right="0" w:left="0"/>'
      + '<w:spacing w:before="160" w:after="0" w:line="360" w:lineRule="auto"/>'
      + '<w:tabs><w:tab w:val="left" w:pos="1080"/></w:tabs></w:pPr>' + inner + '</w:p>';
  }
  function bodyText(text) { return bodyPara(run(text)); }
  function sectionHeading(text) {
    return '<w:p><w:pPr><w:pStyle w:val="SECTION"/><w:spacing w:line="480" w:lineRule="auto"/></w:pPr>'
      + '<w:r><w:t xml:space="preserve">' + xesc(text) + '</w:t></w:r></w:p>';
  }
  function numberingPlaceholder(text) {
    return '<w:p><w:pPr><w:pStyle w:val="Numbering"/></w:pPr>'
      + '<w:r><w:t xml:space="preserve">' + xesc(text) + '</w:t></w:r></w:p>';
  }
  function titlePara(text) {
    return '<w:p><w:pPr><w:spacing w:before="240" w:line="480" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>'
      + '<w:r><w:rPr><w:b/><w:caps/><w:sz w:val="24"/><w:rFonts w:ascii="Times New Roman" w:cs="Times New Roman" w:hAnsi="Times New Roman"/></w:rPr>'
      + '<w:t xml:space="preserve">' + xesc(text) + '</w:t></w:r></w:p>';
  }
  // claim paragraphs (literal numbers, no fields)
  function claimPreamble(numLiteral, preambleText) {
    return '<w:p><w:pPr><w:jc w:val="left"/><w:ind w:firstLine="720" w:right="0" w:left="0"/>'
      + '<w:spacing w:before="240" w:after="0" w:line="360" w:lineRule="auto"/>'
      + '<w:tabs><w:tab w:val="left" w:pos="1080"/></w:tabs></w:pPr>'
      + run(numLiteral + ".")
      + '<w:r>' + RPR + '<w:tab/><w:t xml:space="preserve">' + xesc(preambleText) + '</w:t></w:r></w:p>';
  }
  function claimLimitation(text) {
    return '<w:p><w:pPr><w:jc w:val="left"/><w:ind w:firstLine="720" w:right="0" w:left="0"/>'
      + '<w:spacing w:before="0" w:after="0" w:line="360" w:lineRule="auto"/>'
      + '<w:tabs><w:tab w:val="left" w:pos="1080"/></w:tabs></w:pPr>' + run(text) + '</w:p>';
  }

  function generateDocxXml(project) {
    var A = root.ASSETS, F = A.docxFrag;
    var m = project.matter || {};
    var body = [];
    body.push(titlePara(m.title || "{TITLE}"));

    body.push(sectionHeading("Background"));
    body.push(bodyText("The following relates generally to " + (m.field || "{FIELD}") + "."));
    body.push(numberingPlaceholder("{BACKGROUND}"));
    body.push(numberingPlaceholder("{PROBLEM}"));

    body.push(sectionHeading("Summary"));
    summaryParas(project).forEach(function (p) { body.push(p); });

    body.push(sectionHeading("Brief Description of the Drawings"));
    (project.figures || []).forEach(function (fig, i) {
      body.push(bodyText("FIG. " + (i + 1) + " shows an example of " + fig.name
        + " according to aspects of the present disclosure."));
    });

    var elmap = buildElementMap(project.figures);
    body.push(sectionHeading("Detailed Description"));
    (project.figures || []).forEach(function (fig, i) {
      var n = i + 1, isFlow = fig.category === "flowchart";
      var items = fig.items || [];
      if (isFlow) {
        body.push(bodyText("FIG. " + n + " shows an example of a method " + n + "00 for "
          + fig.name + " according to aspects of the present disclosure."));
        items.forEach(function (step, j) {
          body.push(bodyText("At operation " + docxRef(n, j, true) + ", the system "
            + lowerFirst(stepText(step)).replace(/\.*$/, "") + "."));
          ((step && step.refs) || []).forEach(function (rn) {
            var info = elmap[norm(rn)]; if (!info) return;
            body.push(bodyText("In some cases, the operations of this step refer to, or may be performed by, a "
              + info.display + " as described with reference to " + figRefPhrase(info.figs) + "."));
          });
        });
      } else {
        var listed = items.map(function (c, j) { return c + " " + docxRef(n, j, false); }).join(", ");
        body.push(bodyText("FIG. " + n + " shows an example of " + fig.name
          + " according to aspects of the present disclosure."
          + (listed ? " The example shown includes " + listed + "." : "")));
        items.forEach(function (c, j) {
          var others = ((elmap[norm(c)] || { figs: [] }).figs).filter(function (f) { return f !== n; });
          if (others.length) {
            body.push(bodyText(capFirst(c) + " " + docxRef(n, j, false)
              + " is an example of, or includes aspects of, the corresponding element described with reference to "
              + figRefPhrase(others) + "."));
          }
        });
      }
    });

    body.push(F.closing); // verbatim firm boilerplate

    // Claims
    body.push(F.abstractHeading.replace(/>Abstract</, ">Claims<").replace(/<w:t>[^<]*<\/w:t>/, "<w:t>Claims</w:t>"));
    // safer explicit "Claims" heading + intro:
    body.pop();
    body.push('<w:p><w:pPr><w:spacing w:before="240" w:line="480" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>'
      + '<w:r><w:br w:type="page"/></w:r><w:r><w:rPr><w:caps/></w:rPr><w:t>Claims</w:t></w:r></w:p>');
    body.push('<w:p><w:pPr><w:spacing w:before="240" w:line="480" w:lineRule="auto"/><w:rPr><w:b/></w:rPr></w:pPr>'
      + '<w:r><w:rPr><w:b/></w:rPr><w:t>What is claimed is:</w:t></w:r></w:p>');
    (project.claims || []).forEach(function (c) {
      body.push(claimPreamble(String(c.num), c.preamble));
      (c.limitations || []).forEach(function (l) { body.push(claimLimitation(l)); });
    });

    // Abstract
    body.push(F.abstractHeading);
    body.push(F.abstractPlaceholder);

    return A.docxDocOpen + body.join("") + A.docxSectPr + "</w:body></w:document>";
  }

  function generateDocx(project) {
    var A = root.ASSETS, files = [];
    var docket = (project.matter && project.matter.docket) || A.sampleDocket;
    var titleTxt = (project.matter && project.matter.title) || "";
    // static parts (replace sample docket where it appears, e.g. headers)
    Object.keys(A.docxStatic).forEach(function (path) {
      var isText = /\.(xml|rels)$/.test(path);
      if (isText) {
        var s = new TextDecoder().decode(b64ToU8(A.docxStatic[path]));
        s = s.split(A.sampleDocket).join(docket);
        files.push({ name: path, data: strToU8(s) });
      } else {
        files.push({ name: path, data: b64ToU8(A.docxStatic[path]) });
      }
    });
    files.push({ name: "word/document.xml", data: strToU8(generateDocxXml(project)) });
    // [Content_Types] must be first
    files.sort(function (a, b) { return a.name === "[Content_Types].xml" ? -1 : b.name === "[Content_Types].xml" ? 1 : 0; });
    return zipStore(files);
  }

  // ============================================================
  //  VSDX
  // ============================================================
  var PAGE_W = 8.2677165354331, PAGE_H = 11.692913385827;
  function fieldSection() {
    return "<Section N='Field'><Row IX='0'><Cell N='Value' V='0' F='PAGENUMBER()'/>"
      + "<Cell N='Format' V='esc(0)' U='STR' F='FIELDPICTURE(0)'/></Row></Section>";
  }
  var RECT_GEOM = "<Section N='Geometry' IX='0'>"
    + "<Row T='RelMoveTo' IX='1'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row>"
    + "<Row T='RelLineTo' IX='2'><Cell N='X' V='0'/><Cell N='Y' V='1'/></Row>"
    + "<Row T='RelLineTo' IX='3'><Cell N='X' V='1'/><Cell N='Y' V='1'/></Row>"
    + "<Row T='RelLineTo' IX='4'><Cell N='X' V='1'/><Cell N='Y' V='0'/></Row>"
    + "<Row T='RelLineTo' IX='5'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row></Section>";

  // component/step box: name (normal) + underlined reference number (PAGENUMBER field + suffix)
  function box(id, pinX, pinY, w, h, name, suffix) {
    var chars = "<Section N='Character'>"
      + "<Row IX='0'><Cell N='Font' V='Arial'/><Cell N='Color' V='0'/><Cell N='Style' V='0'/><Cell N='Size' V='0.1944444444444445'/></Row>"
      + "<Row IX='1'><Cell N='Font' V='Arial'/><Cell N='Color' V='0'/><Cell N='Style' V='4'/><Cell N='Size' V='0.1944444444444445'/></Row>"
      + "</Section>";
    var text = "<Text><cp IX='0'/><pp IX='0'/><tp IX='0'/>" + xesc(name) + " "
      + "<cp IX='1'/><fld IX='0'>0</fld>" + suffix + "</Text>";
    return "<Shape ID='" + id + "' Type='Shape' LineStyle='0' FillStyle='0' TextStyle='0'>"
      + "<Cell N='Width' V='" + w + "'/><Cell N='Height' V='" + h + "'/>"
      + "<Cell N='PinX' V='" + pinX + "'/><Cell N='PinY' V='" + pinY + "'/>"
      + "<Cell N='TopMargin' V='0.05' U='PT'/><Cell N='BottomMargin' V='0.05' U='PT'/>"
      + "<Cell N='LeftMargin' V='0.05' U='PT'/><Cell N='RightMargin' V='0.05' U='PT'/>"
      + "<Cell N='LineWeight' V='0.02'/>"
      + fieldSection() + chars + RECT_GEOM + text + "</Shape>";
  }
  // flowchart step box: step text only (reference number lives outside, on a lead line)
  function stepBox(id, pinX, pinY, w, h, text) {
    var chars = "<Section N='Character'><Row IX='0'><Cell N='Font' V='Arial'/><Cell N='Color' V='0'/><Cell N='Style' V='0'/><Cell N='Size' V='0.1527777777777778'/></Row></Section>";
    var t = "<Text><cp IX='0'/><pp IX='0'/><tp IX='0'/>" + xesc(text) + "</Text>";
    return "<Shape ID='" + id + "' Type='Shape' LineStyle='0' FillStyle='0' TextStyle='0'>"
      + "<Cell N='Width' V='" + w + "'/><Cell N='Height' V='" + h + "'/>"
      + "<Cell N='PinX' V='" + pinX + "'/><Cell N='PinY' V='" + pinY + "'/>"
      + "<Cell N='TopMargin' V='0.05' U='PT'/><Cell N='BottomMargin' V='0.05' U='PT'/>"
      + "<Cell N='LeftMargin' V='0.05' U='PT'/><Cell N='RightMargin' V='0.05' U='PT'/>"
      + "<Cell N='LineWeight' V='0.02'/>"
      + chars + RECT_GEOM + t + "</Shape>";
  }
  // dynamic reference-number label (PAGENUMBER field + underlined suffix), rendered like the diagram numbers
  function refLabel(id, pinX, pinY, suffix) {
    var chars = "<Section N='Character'><Row IX='0'><Cell N='Font' V='Arial'/><Cell N='Color' V='0'/><Cell N='Style' V='4'/><Cell N='Size' V='0.1944444444444445'/></Row></Section>";
    var text = "<Text><cp IX='0'/><pp IX='0'/><tp IX='0'/><fld IX='0'>0</fld>" + suffix + "</Text>";
    return "<Shape ID='" + id + "' Type='Shape' LineStyle='0' FillStyle='0' TextStyle='0'>"
      + "<Cell N='Width' V='0.6'/><Cell N='Height' V='0.25'/>"
      + "<Cell N='PinX' V='" + pinX + "'/><Cell N='PinY' V='" + pinY + "'/>"
      + fieldSection() + chars + text + "</Shape>";
  }
  // straight line (lead line or arrow). arrow=true adds an end arrowhead.
  function line(id, x1, y1, x2, y2, arrow) {
    var len = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)) || 0.0001;
    var ang = Math.atan2(y2 - y1, x2 - x1);
    var s = "<Shape ID='" + id + "' Type='Shape' LineStyle='0' FillStyle='0' TextStyle='0'>"
      + "<Cell N='PinX' V='" + ((x1 + x2) / 2) + "'/><Cell N='PinY' V='" + ((y1 + y2) / 2) + "'/>"
      + "<Cell N='Width' V='" + len + "'/><Cell N='Height' V='0'/>"
      + "<Cell N='LocPinX' V='" + (len / 2) + "'/><Cell N='LocPinY' V='0'/>"
      + "<Cell N='Angle' V='" + ang + "'/>"
      + "<Cell N='BeginX' V='" + x1 + "'/><Cell N='BeginY' V='" + y1 + "'/>"
      + "<Cell N='EndX' V='" + x2 + "'/><Cell N='EndY' V='" + y2 + "'/>"
      + "<Cell N='LineWeight' V='0.013'/><Cell N='LineColor' V='0'/>"
      + (arrow ? "<Cell N='EndArrow' V='4'/><Cell N='EndArrowSize' V='2'/>" : "")
      + "<Section N='Geometry' IX='0'><Cell N='NoFill' V='1'/>"
      + "<Row T='MoveTo' IX='1'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row>"
      + "<Row T='LineTo' IX='2'><Cell N='X' V='" + len + "'/><Cell N='Y' V='0'/></Row></Section></Shape>";
    return s;
  }
  function figCaption(id) {
    return "<Shape ID='" + id + "' Type='Shape' LineStyle='0' FillStyle='0' TextStyle='0'>"
      + "<Cell N='Width' V='0.95'/><Cell N='Height' V='0.25'/>"
      + "<Cell N='PinX' V='" + (PAGE_W / 2) + "'/><Cell N='PinY' V='0.55'/>"
      + fieldSection()
      + "<Section N='Character'><Row IX='0'><Cell N='Font' V='Arial'/><Cell N='Color' V='0'/><Cell N='Style' V='1'/><Cell N='Size' V='0.25'/></Row></Section>"
      + "<Text><cp IX='0'/><pp IX='0'/><tp IX='0'/>FIG. <fld IX='0'>0</fld></Text></Shape>";
  }

  function figurePageXml(fig) {
    var shapes = [], id = 100;
    var items = fig.items || [];
    if (fig.category === "flowchart") {
      var boxW = 4.2, boxH = 1.0, cx = 2.6, topY = 10.2, gap = 1.75;
      var ys = [];
      items.forEach(function (step, j) {
        var cy = topY - j * gap; ys.push(cy);
        shapes.push(stepBox(id++, cx, cy, boxW, boxH, stepText(step)));
        var rEdge = cx + boxW / 2, labelX = rEdge + 1.05;
        shapes.push(line(id++, rEdge, cy, labelX - 0.32, cy, false));   // lead line to the right
        shapes.push(refLabel(id++, labelX, cy, refSuffix(j, true)));    // dynamic reference number
      });
      for (var k = 0; k < ys.length - 1; k++) {                         // arrows connecting box centers
        shapes.push(line(id++, cx, ys[k] - boxH / 2, cx, ys[k + 1] + boxH / 2, true));
      }
    } else {
      var W = 2.4, H = 0.6, cols = 2, colX = [2.35, 5.6], rowTop = 10.4, rowGap = 1.05;
      items.forEach(function (name, j) {
        var col = j % cols, rowN = Math.floor(j / cols);
        var px = colX[col], py = rowTop - rowN * rowGap;
        shapes.push(box(id++, px, py, W, H, name, refSuffix(j, false)));
      });
    }
    shapes.push(figCaption(998));
    return "<?xml version='1.0' encoding='utf-8' ?>\r\n"
      + "<PageContents xmlns='http://schemas.microsoft.com/office/visio/2012/main' "
      + "xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships' xml:space='preserve'>"
      + "<Shapes>" + shapes.join("") + "</Shapes></PageContents>";
  }

  function pagesXml(figures) {
    var bg = "<Page ID='0' NameU='Background' IsCustomNameU='1' Name='Background' IsCustomName='1' Background='1' ViewScale='-1' ViewCenterX='4.1136363636364' ViewCenterY='5.8560606060606'>"
      + "<PageSheet LineStyle='0' FillStyle='0' TextStyle='0'>"
      + "<Cell N='PageWidth' V='" + PAGE_W + "' U='IN'/><Cell N='PageHeight' V='" + PAGE_H + "' U='IN'/>"
      + "<Cell N='PageScale' V='1' U='IN_F'/><Cell N='DrawingScale' V='1' U='IN_F'/>"
      + "<Cell N='PageLeftMargin' V='0.25' U='IN'/><Cell N='PageRightMargin' V='0.25' U='IN'/>"
      + "<Cell N='PageTopMargin' V='0.25' U='IN'/><Cell N='PageBottomMargin' V='0.25' U='IN'/>"
      + "<Cell N='PaperKind' V='9'/></PageSheet><Rel r:id='rId1'/></Page>";
    var pages = figures.map(function (fig, i) {
      var n = i + 1;
      return "<Page BackPage='0' ID='" + (n * 1000) + "' Name='FIG. " + n + "' ViewCenterX='4.13125' ViewCenterY='5.85'>"
        + "<PageSheet LineStyle='0' FillStyle='0' TextStyle='0'>"
        + "<Cell N='PageWidth' V='" + PAGE_W + "' U='IN'/><Cell N='PageHeight' V='" + PAGE_H + "' U='IN'/>"
        + "<Cell N='PageScale' V='1' U='IN'/>"
        + "<Cell N='PageLeftMargin' V='0.25' U='IN'/><Cell N='PageRightMargin' V='0.25' U='IN'/>"
        + "<Cell N='PageTopMargin' V='0.25' U='IN'/><Cell N='PageBottomMargin' V='0.25' U='IN'/>"
        + "<Cell N='PaperKind' V='9'/></PageSheet><Rel r:id='rId" + (n + 1) + "'/></Page>";
    }).join("");
    return "<?xml version='1.0' encoding='utf-8' ?>\r\n"
      + "<Pages xmlns='http://schemas.microsoft.com/office/visio/2012/main' "
      + "xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships' xml:space='preserve'>"
      + bg + pages + "</Pages>";
  }

  function pagesRels(figures) {
    var rels = ["<Relationship Id='rId1' Type='http://schemas.microsoft.com/visio/2010/relationships/page' Target='page1.xml'/>"];
    figures.forEach(function (_, i) {
      var n = i + 1;
      rels.push("<Relationship Id='rId" + (n + 1) + "' Type='http://schemas.microsoft.com/visio/2010/relationships/page' Target='page" + (n + 1) + ".xml'/>");
    });
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels.join("") + '</Relationships>';
  }
  function pageBgRel() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + "<Relationship Id='rId1' Type='http://schemas.microsoft.com/visio/2010/relationships/page' Target='page1.xml'/></Relationships>";
  }
  function contentTypes(figures) {
    var ov = [
      "/visio/document.xml|application/vnd.ms-visio.drawing.main+xml",
      "/visio/masters/masters.xml|application/vnd.ms-visio.masters+xml"
    ];
    for (var mi = 1; mi <= 20; mi++) ov.push("/visio/masters/master" + mi + ".xml|application/vnd.ms-visio.master+xml");
    ov.push("/visio/pages/pages.xml|application/vnd.ms-visio.pages+xml");
    ov.push("/visio/pages/page1.xml|application/vnd.ms-visio.page+xml");
    figures.forEach(function (_, i) { ov.push("/visio/pages/page" + (i + 2) + ".xml|application/vnd.ms-visio.page+xml"); });
    ov.push("/visio/windows.xml|application/vnd.ms-visio.windows+xml");
    ov.push("/docProps/core.xml|application/vnd.openxmlformats-package.core-properties+xml");
    ov.push("/docProps/app.xml|application/vnd.openxmlformats-officedocument.extended-properties+xml");
    ov.push("/docProps/custom.xml|application/vnd.openxmlformats-officedocument.custom-properties+xml");
    var overrides = ov.map(function (o) { var p = o.split("|"); return "<Override PartName='" + p[0] + "' ContentType='" + p[1] + "'/>"; }).join("");
    return "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>"
      + "<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'>"
      + "<Default Extension='emf' ContentType='image/x-emf'/>"
      + "<Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/>"
      + "<Default Extension='xml' ContentType='application/xml'/>"
      + overrides + "</Types>";
  }

  function generateVsdx(project) {
    var A = root.ASSETS, figures = project.figures || [];
    var docket = (project.matter && project.matter.docket) || A.sampleDocket;
    var files = [];
    files.push({ name: "[Content_Types].xml", data: strToU8(contentTypes(figures)) });
    Object.keys(A.vsdxStatic).forEach(function (path) {
      files.push({ name: path, data: b64ToU8(A.vsdxStatic[path]) });
    });
    // background page (docket templatized)
    files.push({ name: "visio/pages/page1.xml", data: strToU8(A.vsdxPage1.split(A.sampleDocket).join(docket)) });
    files.push({ name: "visio/pages/pages.xml", data: strToU8(pagesXml(figures)) });
    files.push({ name: "visio/pages/_rels/pages.xml.rels", data: strToU8(pagesRels(figures)) });
    figures.forEach(function (fig, i) {
      var n = i + 2;
      files.push({ name: "visio/pages/page" + n + ".xml", data: strToU8(figurePageXml(fig)) });
      files.push({ name: "visio/pages/_rels/page" + n + ".xml.rels", data: strToU8(pageBgRel()) });
    });
    return zipStore(files);
  }

  var API = { generateDocx: generateDocx, generateVsdx: generateVsdx, parseClaims: parseClaims, zipStore: zipStore };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.PatentCore = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
