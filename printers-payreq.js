/* printers-payreq.js — Thư viện dùng chung cho "Đề nghị thanh toán" (window.PrPay)

   TRƯỚC ĐÂY file này còn có cả trang UI riêng "Máy in → Đề nghị thanh toán"
   (đọc PDF hóa đơn máy in -> lưu công nợ + xuất Excel). Trang đó đã bị BỎ
   theo yêu cầu — giờ chỉ còn 1 nơi duy nhất để lập "Giấy đề nghị thanh toán"
   cho MỌI NCC (kể cả NCC máy in/network): trang chung ở payreq.js. Khi lưu
   ở trang chung, hóa đơn có NCC khớp với danh bạ Máy in/Network sẽ được
   payreq.js TỰ ĐỘNG thêm vào printer_invoices/net_invoices để Công nợ ở
   từng module vẫn cập nhật, không cần nhập lại. Máy in vẫn còn form "Thêm
   hóa đơn" thủ công riêng (ở printers.js) cho trường hợp cần nhập tay.

   File này giờ CHỈ còn là thư viện thuần (window.PrPay) — đọc số thành chữ,
   phân tích hóa đơn (parseInvoiceText), dựng file Excel theo mẫu
   (buildPaymentXlsx), và bộ nạp pdf.js/JSZip dùng chung (ensurePdfJs/
   ensureJSZip/pdfToText) — được network-isp.js và payreq.js gọi lại, không
   còn UI riêng nào phụ thuộc file này. Các hàm thuần test được ngoài trình
   duyệt qua window.PrPay. */
(function () {
  "use strict";

  /* ================= Đọc số thành chữ ================= */
  const VI_DIGITS = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"];
  function viTriple(n, full) {
    const h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), u = n % 10;
    const out = [];
    if (h > 0 || full) out.push(VI_DIGITS[h] + " trăm");
    if (t > 1) {
      out.push(VI_DIGITS[t] + " mươi");
      if (u === 1) out.push("mốt"); else if (u === 5) out.push("lăm"); else if (u === 4) out.push("tư"); else if (u > 0) out.push(VI_DIGITS[u]);
    } else if (t === 1) {
      out.push("mười");
      if (u === 5) out.push("lăm"); else if (u > 0) out.push(VI_DIGITS[u]);
    } else if (u > 0) {
      if (h > 0 || full) out.push("lẻ");
      out.push(VI_DIGITS[u]);
    }
    return out.join(" ");
  }
  function viWords(n) {
    n = Math.round(Number(n) || 0);
    if (n === 0) return "Không đồng chẵn";
    const units = ["", " nghìn", " triệu", " tỷ", " nghìn tỷ"];
    const groups = [];
    let x = n;
    while (x > 0) { groups.push(x % 1000); x = Math.floor(x / 1000); }
    const parts = [];
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i] === 0) continue;
      const full = i < groups.length - 1; // có nhóm cao hơn -> đọc "không trăm"
      parts.push(viTriple(groups[i], full) + units[i]);
    }
    const s = parts.join(" ").replace(/\s+/g, " ").trim();
    return s.charAt(0).toUpperCase() + s.slice(1) + " đồng chẵn";
  }
  const EN_ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  function enTriple(n) {
    const out = [];
    const h = Math.floor(n / 100), r = n % 100;
    if (h) out.push(EN_ONES[h] + " hundred");
    if (r) {
      if (h) out.push("and");
      if (r < 20) out.push(EN_ONES[r]);
      else out.push(EN_TENS[Math.floor(r / 10)] + (r % 10 ? "-" + EN_ONES[r % 10] : ""));
    }
    return out.join(" ");
  }
  function enWords(n) {
    n = Math.round(Number(n) || 0);
    if (n === 0) return "Zero Vietnamese dong.";
    const units = ["", " thousand", " million", " billion", " trillion"];
    const groups = [];
    let x = n;
    while (x > 0) { groups.push(x % 1000); x = Math.floor(x / 1000); }
    const parts = [];
    for (let i = groups.length - 1; i >= 0; i--) if (groups[i]) parts.push(enTriple(groups[i]) + units[i]);
    const s = parts.join(" ");
    return s.charAt(0).toUpperCase() + s.slice(1) + " Vietnamese dong.";
  }

  /* ================= Phân tích hóa đơn điện tử VN (chữ đã trích từ PDF) ================= */
  const moneyOf = s => {
    if (s == null) return 0;
    const t = String(s).replace(/[^\d,.\-]/g, "");
    if (!t) return 0;
    // Định dạng VN: 1.234.567 (dấu . ngăn nghìn) hoặc 1.234.567,50 ; chỉ lấy phần nguyên
    const noDec = t.replace(/,\d{1,2}$/, "");
    return parseInt(noDec.replace(/[.,]/g, ""), 10) || 0;
  };
  const digits = s => String(s || "").replace(/\D/g, "");
  const UNIT_RE = /^(lần|lầ\s?n|cái|chiếc|bảng|bản|tháng|máy|bộ|gói|hộp|cuộn|cây|chai|thùng|ram|lít|kg|m|dịch vụ|lượt|trang|tờ|tấm|quyển|giờ|ngày|năm)$/i;

  function parseInvoiceText(raw) {
    const text = String(raw || "").normalize("NFC").replace(/[\u00a0\u200b]/g, " ");
    const out = {
      serial: "", number: "", date: "", seller: { name: "", tax: "", account: "", bank: "", phone: "", address: "" },
      buyer: { name: "", tax: "" }, items: [], exVat: 0, vatRate: null, vat: 0, total: 0, words: "", payment: "", ok: false
    };
    let m;
    if ((m = /Ký hiệu\s*(?:\(Serial\))?\s*:?\s*([0-9A-Z]{5,10})/i.exec(text))) out.serial = m[1];
    if ((m = /\bSố\s*(?:\(No\.?\))?\s*:\s*(\d{3,})/.exec(text))) out.number = m[1];
    if ((m = /Ngày\s+(\d{1,2})\s+tháng\s+(\d{1,2})\s+năm\s+(\d{4})/i.exec(text))) out.date = `${m[3]}-${String(m[2]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;

    const lines = text.split(/\r?\n/).map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    const sellerIdx = lines.findIndex(l => /^Đơn vị bán hàng\s*:/i.test(l));
    const buyerIdx = lines.findIndex(l => /^(Họ tên người mua hàng|Tên đơn vị)\s*:/i.test(l) || /^Tên đơn vị\s*:/i.test(l));
    const tableIdx = lines.findIndex(l => /^STT\b/i.test(l) || /Tên hàng hóa/i.test(l));
    const sellerEnd = buyerIdx > sellerIdx && buyerIdx >= 0 ? buyerIdx : (tableIdx > 0 ? tableIdx : lines.length);
    const seg = (a, b) => lines.slice(Math.max(a, 0), b).join("\n");
    if (sellerIdx >= 0) {
      const s = seg(sellerIdx, sellerEnd);
      if ((m = /Đơn vị bán hàng\s*:\s*(.+)/i.exec(s))) out.seller.name = m[1].trim();
      if ((m = /Mã số thuế\s*:\s*([\d\s-]{9,20})/i.exec(s))) out.seller.tax = digits(m[1]);
      if ((m = /Số điện thoại\s*:\s*([\d\s.+-]{8,})/i.exec(s))) out.seller.phone = m[1].trim();
      if ((m = /Địa chỉ\s*:\s*(.+)/i.exec(s))) out.seller.address = m[1].trim();
      if ((m = /Số tài khoản\s*:\s*([\d\s.-]{6,30}?)\s*(?:Ngân hàng\s*:|$)/im.exec(s))) out.seller.account = digits(m[1]);
      if ((m = /Ngân hàng\s*:\s*(.+)/i.exec(s))) out.seller.bank = m[1].trim();
    }
    if (buyerIdx >= 0) {
      const s = seg(buyerIdx, tableIdx > buyerIdx ? tableIdx : buyerIdx + 6);
      if ((m = /Tên đơn vị\s*:\s*(.+)/i.exec(s))) out.buyer.name = m[1].trim();
      if ((m = /Mã số thuế\s*:\s*([\d\s-]{9,20})/i.exec(s))) out.buyer.tax = digits(m[1]);
    }
    if ((m = /Hình thức thanh toán\s*:\s*(.+)/i.exec(text))) out.payment = m[1].trim();

    // Dòng hàng: từ sau tiêu đề bảng đến "Cộng tiền hàng"
    const endIdx = lines.findIndex(l => /Cộng tiền hàng/i.test(l));
    if (tableIdx >= 0) {
      const body = lines.slice(tableIdx + 1, endIdx > tableIdx ? endIdx : undefined);
      let cur = null;
      body.forEach(l => {
        const it = /^(\d{1,3})\s+(.+)$/.exec(l);
        if (it && /[\d.,]+\s*$/.test(l)) {
          const nums = [];
          let rest = it[2];
          let mm;
          while ((mm = /\s([\d.,]+)$/.exec(" " + rest)) && nums.length < 3) { nums.unshift(mm[1]); rest = rest.slice(0, rest.length - mm[1].length).trim(); }
          let words = rest.split(" ");
          // bỏ đơn vị tính ở cuối (vd "Lầ n", "Lần")
          const last2 = words.slice(-2).join("");
          if (words.length > 1 && UNIT_RE.test(words[words.length - 1])) words.pop();
          else if (words.length > 2 && UNIT_RE.test(last2)) words.splice(-2);
          cur = { no: it[1], desc: words.join(" ").trim(), qty: nums.length >= 3 ? nums[0] : "", price: nums.length >= 3 ? moneyOf(nums[1]) : 0, amount: moneyOf(nums[nums.length - 1]) };
          out.items.push(cur);
        } else if (cur && !/^(Đơn vị tính|Số lượng|Đơn giá|Thành tiền)/i.test(l)) {
          cur.desc = (cur.desc + " " + l).trim();
        }
      });
    }
    if ((m = /Cộng tiền hàng\s*:?\s*([\d.,]+)/i.exec(text))) out.exVat = moneyOf(m[1]);
    if ((m = /Thuế suất GTGT\s*:?\s*(\d+(?:[.,]\d+)?)\s*%/i.exec(text))) out.vatRate = parseFloat(m[1].replace(",", "."));
    else if (/Thuế suất GTGT\s*:?\s*(KCT|KKKNT)/i.test(text)) out.vatRate = 0;
    if ((m = /Tiền thuế GTGT\s*:?\s*([\d.,]+)/i.exec(text))) out.vat = moneyOf(m[1]);
    if ((m = /Tổng cộng tiền thanh toán\s*:?\s*([\d.,]+)/i.exec(text))) out.total = moneyOf(m[1]);
    if ((m = /Số tiền bằng chữ\s*:\s*(.+)/i.exec(text))) out.words = m[1].trim();
    if (!out.exVat && out.items.length) out.exVat = out.items.reduce((s, x) => s + x.amount, 0);
    if (!out.total && out.exVat) out.total = out.exVat + out.vat;
    out.ok = !!(out.number && out.total);
    return out;
  }

  // Ghép các mảnh chữ của pdf.js (có toạ độ) thành dòng.
  function itemsToText(pages) {
    return pages.map(items => {
      const rows = [];
      items.filter(i => i.str && i.str.trim() !== "" || i.str === " ").forEach(i => {
        const y = i.transform[5], x = i.transform[4];
        let row = rows.find(r => Math.abs(r.y - y) < 3);
        if (!row) { row = { y, cells: [] }; rows.push(row); }
        row.cells.push({ x, w: i.width || 0, s: i.str });
      });
      rows.sort((a, b) => b.y - a.y);
      return rows.map(r => {
        r.cells.sort((a, b) => a.x - b.x);
        let line = "", prevEnd = null;
        r.cells.forEach(c => {
          if (prevEnd !== null) line += (c.x - prevEnd > 2 ? " " : "");
          line += c.s; prevEnd = c.x + c.w;
        });
        return line.replace(/[ \t]{2,}/g, "  ");
      }).join("\n");
    }).join("\n");
  }

  /* ================= Chỉnh file xlsx mẫu (giữ nguyên logo/checkbox/định dạng) ================= */
  const xmlEsc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  function cellRe(ref) { return new RegExp(`<c r="${ref}"((?:\\s[^>]*?)?)(?:/>|>[\\s\\S]*?</c>)`); }
  function styleOf(attrs) { const m = /\ss="(\d+)"/.exec(attrs || ""); return m ? ` s="${m[1]}"` : ""; }
  function putCell(xml, ref, build) {
    const re = cellRe(ref);
    const m = re.exec(xml);
    if (!m) throw new Error("Mẫu Excel thiếu ô " + ref);
    return xml.replace(re, build(ref, styleOf(m[1])));
  }
  const setStr = (xml, ref, v) => putCell(xml, ref, (r, s) => `<c r="${r}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`);
  const setNum = (xml, ref, v) => putCell(xml, ref, (r, s) => `<c r="${r}"${s}><v>${Number(v) || 0}</v></c>`);
  const setFormula = (xml, ref, f, v) => putCell(xml, ref, (r, s) => `<c r="${r}"${s}><f>${xmlEsc(f)}</f><v>${Number(v) || 0}</v></c>`);
  function excelSerial(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
    if (!m) return 0;
    return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000);
  }
  const dmy = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ""); return m ? `${m[3]}/${m[2]}/${m[1]}` : ""; };

  const up = t => String(t || "").toLocaleUpperCase("vi");
  const titleCase = t => String(t).toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase());

  // Mở rộng bảng chứng từ: nhân bản dòng 19 thêm k dòng, đẩy các dòng phía dưới xuống k dòng.
  function expandRows(xml, k) {
    const from = 20;
    const bump = n => (n >= from ? n + k : n);
    const i0 = xml.indexOf("<sheetData>"), i1 = xml.indexOf("</sheetData>");
    let head = xml.slice(0, i0), sd = xml.slice(i0, i1), rest = xml.slice(i1);
    sd = sd.replace(/<row r="(\d+)"/g, (m, n) => `<row r="${bump(+n)}"`).replace(/<c r="([A-Z]+)(\d+)"/g, (m, c, n) => `<c r="${c}${bump(+n)}"`);
    rest = rest.replace(/<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\/>/g, (m, a, b, c, d) => `<mergeCell ref="${a}${bump(+b)}:${c}${bump(+d)}"/>`);
    const rm = /<row r="19"[\s\S]*?<\/row>/.exec(sd);
    if (!rm) throw new Error("Mẫu Excel thiếu dòng chứng từ");
    let clones = "", merges = "";
    for (let i = 1; i <= k; i++) {
      const n = 19 + i;
      clones += rm[0].replace(/<row r="19"/, `<row r="${n}"`).replace(/<c r="([A-Z]+)19"/g, (m, c) => `<c r="${c}${n}"`).replace(/<f>[^<]*<\/f>/g, "").replace(/<v>[^<]*<\/v>/g, "");
      merges += `<mergeCell ref="B${n}:C${n}"/>`;
    }
    sd = sd.replace(rm[0], rm[0] + clones);
    rest = rest.replace(/<mergeCells count="(\d+)">/, (m, c) => `<mergeCells count="${+c + k}">`).replace("</mergeCells>", merges + "</mergeCells>");
    head = head.replace(/<dimension ref="A1:H(\d+)"\/>/, (m, n) => `<dimension ref="A1:H${+n + k}"/>`);
    return head + sd + rest;
  }

  // Nhân bản style của ô `ref` nhưng dùng định dạng số dd/mm/yyyy; trả về chỉ số style mới (ghi lại styles.xml trong zip).
  async function addDateStyle(zip, sheetXml, ref) {
    let st = await zip.file("xl/styles.xml").async("string");
    const cm = /<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/.exec(st);
    const sm = new RegExp(`<c r="${ref}"[^>]*\\ss="(\\d+)"`).exec(sheetXml);
    if (!cm || !sm) return sm ? +sm[1] : 0;
    const xfs = cm[2].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) || [];
    const base = xfs[+sm[1]];
    if (!base) return +sm[1];
    const FMT_ID = 190;
    if (!/numFmtId="190"/.test(st)) {
      const fmt = `<numFmt numFmtId="${FMT_ID}" formatCode="dd\\/mm\\/yyyy"/>`;
      if (/<numFmts count="(\d+)">/.test(st)) st = st.replace(/<numFmts count="(\d+)">/, (m, c) => `<numFmts count="${+c + 1}">`).replace("</numFmts>", fmt + "</numFmts>");
      else st = st.replace(/(<styleSheet[^>]*>)/, `$1<numFmts count="1">${fmt}</numFmts>`);
    }
    let nx = base.replace(/numFmtId="\d+"/, `numFmtId="${FMT_ID}"`);
    if (!/applyNumberFormat=/.test(nx)) nx = nx.replace(/^<xf/, '<xf applyNumberFormat="1"');
    st = st.replace(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/, (m, c, body) => `<cellXfs count="${+c + 1}">${body}${nx}</cellXfs>`);
    zip.file("xl/styles.xml", st);
    return xfs.length;
  }

  async function buildPaymentXlsx(templateBytes, d) {
    const zip = await JSZip.loadAsync(templateBytes);
    const sp = "xl/worksheets/sheet3.xml";
    let x = await zip.file(sp).async("string");
    const docs = d.docs && d.docs.length ? d.docs : [{ no: d.docNo, desc: d.docDesc, date: d.docDate, ex: d.exVat, vat: d.vat }];
    const k = docs.length - 1;
    if (k > 0) x = expandRows(x, k);
    const last = 19 + k, totRow = 20 + k;
    const total = docs.reduce((sum, r) => sum + (Number(r.ex) || 0) + (Number(r.vat) || 0), 0);
    x = setStr(x, "F1", `Mã số/ Code: ${d.code || "ACC-001"}\nNgày/ Date: ${dmy(d.dateReq) || ""}`);
    x = setStr(x, "C2", d.requester || "");
    x = setStr(x, "C3", d.dept || "");
    x = setStr(x, "C4", d.reason || "");
    x = setFormula(x, "C6", "G" + totRow, total);
    x = setStr(x, "C7", viWords(total));
    x = setStr(x, "C8", enWords(total));
    x = setStr(x, "C10", d.receiver || "");
    x = setStr(x, "C11", d.account || "");
    x = setStr(x, "C12", d.bank || "");
    if (d.bankAddress) x = setStr(x, "C13", d.bankAddress);
    // Ngày "Từ ngày/Hạn chót": ép định dạng dd/mm/yyyy (mẫu dùng định dạng ngày theo máy -> hiện m/d/yyyy trên Excel US).
    const dateStyle = await addDateStyle(zip, x, "D14");
    x = putCell(x, "D14", ref => `<c r="${ref}" s="${dateStyle}"><v>${excelSerial(d.from)}</v></c>`);
    x = putCell(x, "G14", ref => `<c r="${ref}" s="${dateStyle}"><v>${excelSerial(d.due)}</v></c>`);
    docs.forEach((r, i) => {
      const n = 19 + i, ex = Number(r.ex) || 0, vat = Number(r.vat) || 0;
      x = setStr(x, "A" + n, r.no || "");
      x = setStr(x, "B" + n, r.desc || "");
      x = setStr(x, "D" + n, dmy(r.date));
      x = setNum(x, "E" + n, ex);
      x = setNum(x, "F" + n, vat);
      x = setFormula(x, "G" + n, `E${n}+F${n}`, ex + vat);
    });
    x = setFormula(x, "G" + totRow, `SUM(G19:G${last})`, total);
    const sigRow = 28 + k;
    x = setStr(x, "A" + sigRow, up(d.requester));
    x = setStr(x, "B" + sigRow, up(d.head));
    x = setStr(x, "C" + sigRow, up(d.chief || "HỒ THANH TÂM"));
    x = setStr(x, "D" + sigRow, up(d.finance));
    zip.file(sp, x);

    // Checkbox Tiền mặt (Check Box 1 / ctrlProp5) và Chuyển khoản (Check Box 2 / ctrlProp6)
    const cash = d.method === "cash";
    for (const [file, on] of [["xl/ctrlProps/ctrlProp5.xml", cash], ["xl/ctrlProps/ctrlProp6.xml", !cash]]) {
      let c = await zip.file(file).async("string");
      c = c.replace(/\schecked="Checked"/, "");
      if (on) c = c.replace('objectType="CheckBox"', 'objectType="CheckBox" checked="Checked"');
      zip.file(file, c);
    }
    let vml = await zip.file("xl/drawings/vmlDrawing3.vml").async("string");
    const shapes = vml.split("</v:shape>");
    const fix = (idx, on) => {
      shapes[idx] = shapes[idx].replace(/\s*<x:Checked>1<\/x:Checked>/, "");
      if (on) shapes[idx] = shapes[idx].replace("<x:NoThreeD/>", "<x:Checked>1</x:Checked>\n   <x:NoThreeD/>");
    };
    fix(0, cash); fix(1, !cash);
    zip.file("xl/drawings/vmlDrawing3.vml", shapes.join("</v:shape>"));
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }

  // ensurePdfJs/ensureJSZip/pdfToText được export qua PrPay để network-isp.js và
  // payreq.js dùng chung (trước đây mỗi file tự cài 1 bản riêng — 3 bản giống hệt
  // nhau, sửa version pdf.js/jszip phải sửa 3 chỗ). Định nghĩa thật ở dưới (được
  // hoisted nên tham chiếu được ngay tại đây dù đứng trước theo thứ tự dòng).
    async function ensurePdfJs() {
    if (window.pdfjsLib) return window.pdfjsLib;
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload = res; s.onerror = () => rej(new Error("pdf.js"));
      document.head.appendChild(s);
    });
    try { // worker cross-origin -> nạp qua blob
      const code = await (await fetch("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js")).text();
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    } catch (e) { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; }
    return window.pdfjsLib;
  }
  async function ensureJSZip() {
    if (window.JSZip) return;
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
      s.onload = res; s.onerror = () => rej(new Error("jszip"));
      document.head.appendChild(s);
    });
  }
  async function pdfToText(file) {
    const lib = await ensurePdfJs();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let i = 1; i <= Math.min(doc.numPages, 3); i++) pages.push((await (await doc.getPage(i)).getTextContent()).items);
    return itemsToText(pages);
  }

  window.PrPay = { viWords, enWords, parseInvoiceText, itemsToText, buildPaymentXlsx, moneyOf, excelSerial, ensurePdfJs, ensureJSZip, pdfToText };
})();
