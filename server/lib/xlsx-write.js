// Geração mínima de planilhas .xlsx (sem dependências): várias abas, cabeçalho em negrito, larguras de coluna,
// linha de cabeçalho congelada, listas suspensas (validação por intervalo de outra aba) e comentários de ajuda via texto.
import { deflateRawSync, crc32 } from 'node:zlib';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

// Também usado para baixar vários arquivos de uma vez (.zip)
export function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const comp = deflateRawSync(buf);
    const crc = crc32(buf) >>> 0;
    const nameBuf = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(buf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(0, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(buf.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// Estilos: 0 normal · 1 cabeçalho (negrito, fundo) · 2 texto quebrando linha · 3 número 0,00 · 4 título · 5 negrito
// · 6 número 0,00 em negrito com fundo · 7 negrito com fundo · 8 número 0,00 com fundo · 9 negrito com fundo, centralizado na vertical
// e quebrando linha · 10 número 0,00 em negrito com fundo, centralizado na vertical · 11 texto centralizado na vertical.
// Célula pode ser { v, s } (valor e estilo). Aba pode ter merges: ['A13:A20', …] (células mescladas).
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="&quot;R$&quot;\\ #,##0.00"/></numFmts>
<fonts count="9"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="13"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><sz val="9"/><name val="Calibri"/></font><font><b/><sz val="9"/><name val="Calibri"/></font><font><b/><sz val="28"/><name val="Calibri"/></font><font><b/><sz val="9"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="9"/><color rgb="FFFF0000"/><name val="Calibri"/></font></fonts>
<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2A3D50"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF2F6"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF003366"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="hair"><color auto="1"/></left><right style="hair"><color auto="1"/></right><top style="hair"><color auto="1"/></top><bottom style="hair"><color auto="1"/></bottom><diagonal/></border><border><left style="hair"><color auto="1"/></left><right style="hair"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="hair"><color auto="1"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="27"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/><xf numFmtId="0" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1" applyNumberFormat="1"/><xf numFmtId="0" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="7" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf><xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="4" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="165" fontId="5" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="165" fontId="8" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="5" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf><xf numFmtId="9" fontId="4" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="9" fontId="5" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const cell = (ref, v, style) => {
  if (v && typeof v === 'object' && 'f' in v) { const st = v.s ?? style; return `<c r="${ref}"${st ? ` s="${st}"` : ''}><f>${esc(v.f)}</f>${typeof v.v === 'number' ? `<v>${v.v}</v>` : ''}</c>`; }
  if (v && typeof v === 'object' && 'v' in v) { style = v.s ?? style; v = v.v; }
  if (v === null || v === undefined || v === '') return style ? `<c r="${ref}" s="${style}"/>` : '';
  if (typeof v === 'number') return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${v}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
};

// sheets: [{ name, rows: [[...]], widths: [..], header: true, freeze: true, styles: { [col]: estilo }, validations: [{ col, rows: [a, b], source: "'Listas'!$A$2:$A$10" }] }]
export function writeXlsx(sheets) {
  const files = [];
  sheets.forEach((sh, i) => {
    const cols = sh.widths?.length ? `<cols>${sh.widths.map((w, k) => `<col min="${k + 1}" max="${k + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    const rows = sh.rows.map((r, ri) => `<row r="${ri + 1}"${sh.heights?.[ri] ? ` ht="${sh.heights[ri]}" customHeight="1"` : ''}>${r.map((v, ci) => cell(`${colName(ci)}${ri + 1}`, v, sh.rowStyles?.[ri] ?? (ri === 0 && sh.header ? 1 : ri === 0 && sh.title ? 4 : sh.styles?.[ci]))).join('')}</row>`).join('');
    const fr = sh.freezeRows || (sh.freeze ? 1 : 0);
    const pane = fr || sh.gridlines === false ? `<sheetViews><sheetView workbookViewId="0"${sh.gridlines === false ? ' showGridLines="0"' : ''}>${fr ? `<pane ySplit="${fr}" topLeftCell="A${fr + 1}" activePane="bottomLeft" state="frozen"/>` : ''}</sheetView></sheetViews>` : '';
    const pr = sh.landscape ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : '';
    const page = sh.landscape ? '<printOptions horizontalCentered="1"/><pageMargins left="0.2" right="0.2" top="0.3" bottom="0.3" header="0.1" footer="0.1"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' : '';
    const dv = sh.validations?.length ? `<dataValidations count="${sh.validations.length}">${sh.validations.map(v =>
      `<dataValidation type="list" allowBlank="1" showErrorMessage="1" errorTitle="Valor inválido" error="Escolha um item da lista." sqref="${colName(v.col)}${v.rows[0]}:${colName(v.col)}${v.rows[1]}"><formula1>${esc(v.source)}</formula1></dataValidation>`).join('')}</dataValidations>` : '';
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pr}${pane}${cols}<sheetData>${rows}</sheetData>${sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}${dv}${page}</worksheet>` });
  });
  return zip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${sheets.some(s => s.printTitleRows) ? `<definedNames>${sheets.map((s, i) => (s.printTitleRows ? `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${esc(s.name.replace(/'/g, "''"))}'!$1:$${s.printTitleRows}</definedName>` : '')).join('')}</definedNames>` : ''}</workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: STYLES },
    ...files,
  ]);
}
