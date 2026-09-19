/* printers-payreq.js — Đề nghị thanh toán từ hóa đơn PDF của NCC (module Máy in)

   Luồng: tải hóa đơn điện tử PDF -> đọc chữ (pdf.js) -> tự nhận NCC, số/ngày hóa đơn,
   nội dung, tiền trước thuế/VAT/tổng -> người dùng kiểm tra & chỉnh -> lưu vào công nợ
   (printer_invoices) và xuất "Giấy đề nghị thanh toán" (Excel) theo đúng mẫu
   pay-template.xlsx (logo, checkbox, khổ in giữ nguyên) để in trình ký.

   Các hàm thuần (đọc số thành chữ, phân tích hóa đơn, chỉnh file xlsx) nằm ở PrPay để
   test được ngoài trình duyệt. Phần UI phụ thuộc printers.js qua window.PrCore. */
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
    x = setNum(x, "D14", excelSerial(d.from));
    x = setNum(x, "G14", excelSerial(d.due));
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
    x = setStr(x, "A" + sigRow, titleCase(d.requester || ""));
    x = setStr(x, "B" + sigRow, d.head || "");
    x = setStr(x, "D" + sigRow, d.finance || "");
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

  window.PrPay = { viWords, enWords, parseInvoiceText, itemsToText, buildPaymentXlsx, moneyOf, excelSerial };

  /* ================= UI ================= */
  const C = () => window.PrCore;
  const $ = id => document.getElementById(id);
  if (!$("prPqFile")) return; // (test/harness không có trang này)

  const SETTINGS_KEY = "prPayReqSettings";
  const DEFAULTS = { code: "ACC-001", requester: "BÙI KHÁNH NGUYÊN", dept: "IT", head: "Lê Nhật Thành", finance: "Chen Lai Chong – John" };
  function loadSettings() { try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); } catch (e) { return Object.assign({}, DEFAULTS); } }
  function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* bỏ qua */ } }

  let parsed = null;       // kết quả đọc PDF gần nhất
  let editingInvoiceId = ""; // hóa đơn đã có trong công nợ (nếu mở từ danh sách)
  const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const num = v => { const n = parseFloat(String(v).replace(/[^\d.\-]/g, "")); return isFinite(n) ? n : 0; };
  const moneyVal = id => Math.round(num($(id).value));
  const tr2 = (k, v) => tr(k, v);

  function fillSelects() {
    const core = C();
    const vSel = $("prPqVendor").value, pSel = $("prPqPrinter").value;
    const vs = core.vendors.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "", "vi"));
    $("prPqVendor").innerHTML = `<option value="">${core.esc(tr("pr.pq.newVendorOpt"))}</option>` + vs.map(v => `<option value="${v._id}">${core.esc(v.name || v._id)}</option>`).join("");
    $("prPqVendor").value = vs.some(v => v._id === vSel) ? vSel : "";
    const ps = core.printers.slice().sort((a, b) => (a.code || "").localeCompare(b.code || "", undefined, { numeric: true }));
    $("prPqPrinter").innerHTML = `<option value="">${core.esc(tr("pr.pq.noPrinter"))}</option>` + ps.map(p => `<option value="${p._id}">${core.esc([p.code, p.brand, p.model, p.section].filter(Boolean).join(" · "))}</option>`).join("");
    $("prPqPrinter").value = ps.some(p => p._id === pSel) ? pSel : "";
    $("prPqMethod").innerHTML = `<option value="transfer">${core.esc(tr("pr.pq.transfer"))}</option><option value="cash">${core.esc(tr("pr.pq.cash"))}</option>`;
  }
  window.renderPayReq = function () {
    if (!C() || !C().canSee()) return;
    const keepM = $("prPqMethod").value;
    fillSelects();
    if (keepM) $("prPqMethod").value = keepM;
    if (!$("prPqRequester").value) fillSettings();
  };
  function fillSettings() {
    const s = loadSettings();
    $("prPqCode").value = s.code; $("prPqRequester").value = s.requester; $("prPqDept").value = s.dept; $("prPqHead").value = s.head; $("prPqFinance").value = s.finance;
  }

  function matchVendor(p) {
    const core = C();
    const tax = digits(p.seller.tax);
    let v = tax ? core.vendors.find(x => digits(x.taxCode) === tax) : null;
    if (!v && p.seller.name) {
      const n = norm(p.seller.name);
      v = core.vendors.find(x => { const a = norm(x.name), b = norm(x.receiverName); return (a && (n.includes(a) || a.includes(n))) || (b && (n.includes(b) || b.includes(n))); });
      if (!v) { // so theo từ khóa cuối (vd "DNP") — tên trong app thường viết tắt
        const tok = (p.seller.name.match(/[A-Za-zÀ-ỹ]{2,}(?:\s[A-Z])+\s?[A-Z]?$/) || [""])[0];
        const key = norm(tok);
        if (key.length >= 3) v = core.vendors.find(x => norm(x.name).includes(key));
      }
    }
    return v || null;
  }
  function guessKind(desc) {
    const E = C().E, d = (desc || "").toLowerCase();
    if (/thuê/.test(d)) return E.ik[0];
    if (/sửa|thay|bảo trì|bảo dưỡng|vệ sinh|linh kiện/.test(d)) return E.ik[1];
    if (/mực|toner|drum|vật tư/.test(d)) return E.ik[2];
    return E.ik[4];
  }
  function guessPrinter(vendorId, desc) {
    const core = C(), dn = norm(desc);
    const list = core.printers.filter(p => p.vendorId === vendorId);
    const hit = list.find(p => p.model && norm(p.model).length >= 3 && dn.includes(norm(p.model)));
    if (hit) return hit;
    if (/photo|copy/i.test(desc)) { const ph = list.filter(p => p.type === core.E.pt[3]); if (ph.length === 1) return ph[0]; }
    return list.length === 1 ? list[0] : null;
  }
  function reasonText(kind, printer, desc) {
    const E = C().E;
    const photo = (printer && printer.type === E.pt[3]) || /photo/i.test(desc || "");
    if (kind === E.ik[0]) return photo ? "Thanh toán hóa đơn thuê máy photo / Payment for photocopier rental invoice" : "Thanh toán hóa đơn thuê máy in / Payment for printer rental invoice";
    if (kind === E.ik[1]) return "Thanh toán hóa đơn sửa chữa máy in / Payment for printer repair invoice";
    if (kind === E.ik[2]) return "Thanh toán hóa đơn mực & vật tư máy in / Payment for printer toner & supplies invoice";
    return "Thanh toán hóa đơn / Payment for invoice";
  }
  const periodOf = (desc, dateIso) => {
    const m = /tháng\s+(\d{1,2})\s+năm\s+(\d{4})/i.exec(desc || "");
    if (m) return `${m[2]}-${String(m[1]).padStart(2, "0")}`;
    return (dateIso || "").slice(0, 7);
  };

  function setWarn(list) {
    const box = $("prPqWarn");
    if (!list.length) { box.classList.add("hidden"); box.innerHTML = ""; return; }
    box.classList.remove("hidden");
    box.innerHTML = list.map(t => `<div class="pr-alert">${C().esc(t)}</div>`).join("");
  }
  function recompute() {
    const ex = moneyVal("prPqEx"), rate = num($("prPqVatRate").value);
    if (document.activeElement !== $("prPqVat")) $("prPqVat").value = Math.round(ex * rate / 100);
    $("prPqTotal").value = ex + moneyVal("prPqVat");
    validate();
  }
  function validate() {
    const core = C(), w = [];
    const vid = $("prPqVendor").value, no = $("prPqNo").value.trim();
    const total = moneyVal("prPqTotal");
    if (parsed && parsed.total && parsed.total !== total) w.push(tr("pr.pq.w.totalDiff", { pdf: core.money(parsed.total), now: core.money(total) }));
    if (parsed && parsed.exVat && parsed.vat && parsed.exVat + parsed.vat !== parsed.total) w.push(tr("pr.pq.w.pdfSum"));
    const dup = vid && no ? core.invoices.find(i => i.vendorId === vid && (i.invoiceNo || "") === no && i._id !== editingInvoiceId) : null;
    if (dup) w.push(tr("pr.pq.w.dup", { no }));
    const p = core.printerById($("prPqPrinter").value);
    if (p && core.E.own[0] === p.ownership && p.monthlyFee > 0 && $("prPqKindTag").dataset.kind === core.E.ik[0]) {
      const ex = moneyVal("prPqEx");
      if (Math.abs(ex - p.monthlyFee) > 1) w.push(tr("pr.pq.w.feeDiff", { fee: core.money(p.monthlyFee), ex: core.money(ex) }));
    }
    const v = core.vendorById(vid);
    if (v && (!v.bankAccount && !parsed)) w.push(tr("pr.pq.w.noBank"));
    if (parsed && parsed.buyer.tax && parsed.buyer.tax !== "1301132932") w.push(tr("pr.pq.w.buyer", { tax: parsed.buyer.tax }));
    setWarn(w);
  }

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

  function applyParsed(p) {
    const core = C(), E = core.E;
    parsed = p;
    fillSelects();
    const v = matchVendor(p);
    $("prPqVendor").value = v ? v._id : "";
    $("prPqSerial").value = p.serial; $("prPqNo").value = p.number; $("prPqDate").value = p.date;
    const desc = p.items.map(i => i.desc).filter(Boolean).join("; ");
    $("prPqDesc").value = desc;
    $("prPqEx").value = p.exVat; $("prPqVatRate").value = p.vatRate != null ? p.vatRate : (p.exVat ? Math.round(p.vat / p.exVat * 100) : 0);
    $("prPqVat").value = p.vat; $("prPqTotal").value = p.total;
    const kind = guessKind(desc);
    $("prPqKindTag").dataset.kind = kind; $("prPqKindTag").textContent = core.enumLabel("ik", kind);
    const pr = v ? guessPrinter(v._id, desc) : null;
    $("prPqPrinter").value = pr ? pr._id : "";
    const terms = v && v.paymentTerms != null ? Number(v.paymentTerms) : 30;
    $("prPqFrom").value = p.date; $("prPqDue").value = p.date ? core.addDays(p.date, terms) : "";
    $("prPqReason").value = reasonText(kind, pr, desc);
    $("prPqMethod").value = "transfer";
    $("prPqSellerInfo").textContent = tr("pr.pq.sellerInfo", { name: p.seller.name || "—", tax: p.seller.tax || "—", acc: p.seller.account || "—", bank: p.seller.bank || "—" });
    $("prPqForm").classList.remove("hidden");
    editingInvoiceId = "";
    validate();
    const found = core.invoices.find(i => v && i.vendorId === v._id && (i.invoiceNo || "") === p.number);
    if (found) editingInvoiceId = found._id;
    $("prPqStatus").textContent = v ? tr("pr.pq.readOk", { vendor: v.name }) : tr("pr.pq.readNewVendor");
  }

  $("prPqFile").addEventListener("change", async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    $("prPqStatus").textContent = tr("pr.pq.reading");
    try {
      const text = await pdfToText(f);
      const p = parseInvoiceText(text);
      if (!p.ok) {
        $("prPqForm").classList.remove("hidden");
        $("prPqStatus").textContent = tr("pr.pq.readFail");
        parsed = null;
        return;
      }
      applyParsed(p);
    } catch (err) {
      $("prPqForm").classList.remove("hidden");
      $("prPqStatus").textContent = tr("pr.pq.readErr", { err: err.message });
    }
    e.target.value = "";
  });
  ["prPqEx", "prPqVatRate"].forEach(id => $(id).addEventListener("input", recompute));
  $("prPqVat").addEventListener("input", () => { $("prPqTotal").value = moneyVal("prPqEx") + moneyVal("prPqVat"); validate(); });
  ["prPqTotal", "prPqNo", "prPqVendor", "prPqPrinter"].forEach(id => $(id).addEventListener("change", validate));
  $("prPqDesc").addEventListener("input", () => {
    const k = guessKind($("prPqDesc").value); $("prPqKindTag").dataset.kind = k; $("prPqKindTag").textContent = C().enumLabel("ik", k);
  });
  $("prPqVendor").addEventListener("change", () => {
    const v = C().vendorById($("prPqVendor").value);
    if (v && $("prPqDate").value) $("prPqDue").value = C().addDays($("prPqDate").value, v.paymentTerms != null ? Number(v.paymentTerms) : 30);
    const pr = v ? guessPrinter(v._id, $("prPqDesc").value) : null;
    if (pr) $("prPqPrinter").value = pr._id;
  });
  $("prPqResetBtn").addEventListener("click", () => {
    parsed = null; editingInvoiceId = "";
    $("prPqForm").classList.add("hidden"); $("prPqStatus").textContent = ""; setWarn([]);
    ["prPqSerial", "prPqNo", "prPqDate", "prPqDesc", "prPqEx", "prPqVat", "prPqTotal", "prPqFrom", "prPqDue", "prPqReason"].forEach(id => { $(id).value = ""; });
  });
  $("prPqManualBtn").addEventListener("click", () => {
    parsed = null; editingInvoiceId = "";
    $("prPqForm").classList.remove("hidden"); $("prPqStatus").textContent = tr("pr.pq.manual");
    $("prPqDate").value = C().todayStr(); $("prPqFrom").value = C().todayStr(); $("prPqVatRate").value = 8;
    $("prPqKindTag").dataset.kind = C().E.ik[0]; $("prPqKindTag").textContent = C().enumLabel("ik", C().E.ik[0]);
    $("prPqSellerInfo").textContent = "";
    fillSettings();
  });

  window.prPayReqFromInvoice = function (id) {
    const core = C();
    const inv = core.invoices.find(i => i._id === id);
    if (!inv) return;
    goPage("printerPayReq");
    fillSelects(); fillSettings();
    parsed = null; editingInvoiceId = inv._id;
    $("prPqForm").classList.remove("hidden");
    $("prPqVendor").value = inv.vendorId || "";
    $("prPqPrinter").value = inv.printerId || "";
    $("prPqSerial").value = inv.invoiceSerial || ""; $("prPqNo").value = inv.invoiceNo || ""; $("prPqDate").value = inv.invoiceDate || "";
    const desc = inv.desc || inv.note || "";
    $("prPqDesc").value = desc;
    const total = Number(inv.amount) || 0;
    const rate = inv.vatRate != null ? Number(inv.vatRate) : 0;
    const ex = inv.amountExVat != null ? Number(inv.amountExVat) : (rate ? Math.round(total / (1 + rate / 100)) : total);
    $("prPqEx").value = ex; $("prPqVatRate").value = rate; $("prPqVat").value = inv.vatAmount != null ? inv.vatAmount : total - ex; $("prPqTotal").value = total;
    $("prPqKindTag").dataset.kind = inv.kind; $("prPqKindTag").textContent = core.enumLabel("ik", inv.kind);
    $("prPqFrom").value = inv.invoiceDate || ""; $("prPqDue").value = inv.dueDate || "";
    $("prPqReason").value = reasonText(inv.kind, core.printerById(inv.printerId), desc);
    $("prPqSellerInfo").textContent = "";
    $("prPqStatus").textContent = tr("pr.pq.fromInvoice");
    validate();
  };

  function collect() {
    const core = C();
    return {
      vendorId: $("prPqVendor").value, serial: $("prPqSerial").value.trim(), no: $("prPqNo").value.trim(), date: $("prPqDate").value,
      desc: $("prPqDesc").value.trim(), ex: moneyVal("prPqEx"), rate: num($("prPqVatRate").value), vat: moneyVal("prPqVat"), total: moneyVal("prPqTotal"),
      printerId: $("prPqPrinter").value, kind: $("prPqKindTag").dataset.kind || core.E.ik[4], from: $("prPqFrom").value, due: $("prPqDue").value,
      method: $("prPqMethod").value, reason: $("prPqReason").value.trim()
    };
  }

  // Lưu hóa đơn vào công nợ (tạo mới hoặc cập nhật hóa đơn trùng số), tạo NCC nếu cần, bổ sung thông tin ngân hàng còn trống.
  async function saveInvoice(markRequest) {
    const core = C(), ts = firebase.firestore.FieldValue.serverTimestamp;
    if (!isAdmin) { alert(tr("pr.msg.noPerm")); return null; }
    const f = collect();
    if (!f.no || !f.total || !f.date) { alert(tr("pr.pq.needFields")); return null; }
    const batch = db.batch();
    let vid = f.vendorId, vendor = core.vendorById(vid);
    const s = parsed ? parsed.seller : null;
    if (!vid) {
      if (!s || !s.name) { alert(tr("pr.pq.needVendor")); return null; }
      if (!confirm(tr("pr.pq.confirmNewVendor", { name: s.name }))) return null;
      const ref = db.collection(core.VENDOR_COLLECTION).doc(); vid = ref.id;
      vendor = { name: s.name, roles: [core.E.vr[0]], role: core.E.vr[0], contact: "", phone: s.phone || "", email: "", address: s.address || "", taxCode: s.tax || "",
        receiverName: s.name, bankAccount: s.account || "", bankName: s.bank || "", bankAddress: "", paymentTerms: 30, note: "" };
      batch.set(ref, Object.assign({ createdAt: ts(), updatedAt: ts() }, vendor));
      vendor._id = vid;
    } else if (s) {
      const patch = {};
      if (!vendor.taxCode && s.tax) patch.taxCode = s.tax;
      if (!vendor.bankAccount && s.account) patch.bankAccount = s.account;
      if (!vendor.bankName && s.bank) patch.bankName = s.bank;
      if (!vendor.receiverName && s.name) patch.receiverName = s.name;
      if (!vendor.address && s.address) patch.address = s.address;
      if (!vendor.phone && s.phone) patch.phone = s.phone;
      if (Object.keys(patch).length) { patch.updatedAt = ts(); batch.set(db.collection(core.VENDOR_COLLECTION).doc(vid), patch, { merge: true }); Object.assign(vendor, patch); }
    }
    const printer = core.printerById(f.printerId);
    const existing = editingInvoiceId ? core.invoices.find(i => i._id === editingInvoiceId)
      : core.invoices.find(i => i.vendorId === vid && (i.invoiceNo || "") === f.no);
    const ref = existing ? db.collection(core.INVOICE_COLLECTION).doc(existing._id) : db.collection(core.INVOICE_COLLECTION).doc();
    const data = {
      vendorId: vid, vendorName: vendor ? vendor.name : "", printerId: printer ? printer._id : "", printerCode: printer ? printer.code : "",
      kind: f.kind, invoiceNo: f.no, invoiceSerial: f.serial, invoiceDate: f.date, period: periodOf(f.desc, f.date),
      dueDate: f.due || core.addDays(f.date, vendor && vendor.paymentTerms != null ? Number(vendor.paymentTerms) : 30),
      amount: f.total, amountExVat: f.ex, vatRate: f.rate, vatAmount: f.vat, desc: f.desc, note: f.desc, updatedAt: ts()
    };
    if (markRequest) { data.payReqDate = core.todayStr(); data.payReqMethod = f.method; }
    if (!existing) Object.assign(data, { payments: [], source: "pdf", createdBy: currentEmail || "?", createdAt: ts() });
    batch.set(ref, data, { merge: true });
    await batch.commit();
    editingInvoiceId = ref.id;
    return { f, vendor, printer };
  }

  $("prPqSaveBtn").addEventListener("click", async () => {
    try {
      const r = await saveInvoice(false);
      if (r) $("prPqStatus").textContent = tr("pr.pq.saved");
    } catch (err) { alert(tr("pr.msg.errSave", { err: err.message })); }
  });

  $("prPqXlsxBtn").addEventListener("click", async () => {
    const core = C();
    const f0 = collect();
    if (!f0.no || !f0.total) { alert(tr("pr.pq.needFields")); return; }
    try {
      $("prPqStatus").textContent = tr("pr.pq.building");
      const saved = await saveInvoice(true);
      if (!saved) { $("prPqStatus").textContent = ""; return; }
      const { f, vendor } = saved;
      await ensureJSZip();
      const res = await fetch("pay-template.xlsx");
      if (!res.ok) throw new Error("pay-template.xlsx");
      const tpl = new Uint8Array(await res.arrayBuffer());
      const settings = { code: $("prPqCode").value.trim() || DEFAULTS.code, requester: $("prPqRequester").value.trim(), dept: $("prPqDept").value.trim(), head: $("prPqHead").value.trim(), finance: $("prPqFinance").value.trim() };
      saveSettings(settings);
      const bytes = await buildPaymentXlsx(tpl, {
        code: settings.code, dateReq: core.todayStr(), requester: settings.requester, dept: settings.dept, head: settings.head, finance: settings.finance,
        reason: f.reason, method: f.method, total: f.total,
        receiver: (vendor && (vendor.receiverName || vendor.name)) || "", account: (vendor && vendor.bankAccount) || "", bank: (vendor && vendor.bankName) || "", bankAddress: (vendor && vendor.bankAddress) || "",
        from: f.from || f.date, due: f.due, docNo: f.no, docDesc: f.desc, docDate: f.date, exVat: f.ex, vat: f.vat
      });
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const a = document.createElement("a");
      const short = ((vendor && vendor.name) || "NCC").replace(/[^A-Za-z0-9]+/g, "").slice(-12) || "NCC";
      a.href = URL.createObjectURL(blob); a.download = `De-nghi-thanh-toan_${short}_${f.no}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      $("prPqStatus").textContent = tr("pr.pq.done", { no: f.no });
    } catch (err) {
      $("prPqStatus").textContent = "";
      alert(tr("pr.pq.errBuild", { err: err.message }));
    }
  });
})();
