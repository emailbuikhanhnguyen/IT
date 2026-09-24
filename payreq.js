/* payreq.js — Đề nghị thanh toán từ hóa đơn / chứng từ PDF của MỌI nhà cung cấp
   (Internet/viễn thông, máy in – máy photo, mực & vật tư, dịch vụ khác...).

   Thay cho trang "Chuyển đổi báo cáo (Word → JPG)" cũ.

   Luồng:
     1. Chọn nhiều file PDF (hóa đơn điện tử VNPT/Viettel/NCC khác, Thông báo cước Viettel...).
     2. App đọc chữ trong PDF (pdf.js) → tự nhận NCC (theo MST), số/ký hiệu/ngày hóa đơn, nội dung,
        tiền trước thuế/VAT/tổng, STK ngân hàng → người dùng kiểm tra & sửa từng dòng.
     3. Các chứng từ được GOM THEO NCC → mỗi NCC 1 "Giấy đề nghị thanh toán" (Excel theo mẫu
        pay-template.xlsx, nhiều dòng chứng từ) → tải từng file hoặc tải tất cả (.zip).
     4. (Admin) lưu lịch sử đề nghị vào Firestore `pay_requests` để cảnh báo trùng hóa đơn và tạo lại file.

   Phần lớn xử lý chạy ngay trên thiết bị (không upload PDF lên server). Tài khoản "reportonly" dùng
   được toàn bộ bước 1–3 mà không cần đọc/ghi Firestore.

   Phụ thuộc (nạp TRƯỚC file này): printers-payreq.js (window.PrPay: parseInvoiceText, itemsToText,
   buildPaymentXlsx), network-isp.js (window.NetIsp: parseNetDoc, dueFor, reasonFor, SEED), tùy chọn
   printers.js (window.PrCore). Các hàm thuần nằm ở window.PayReq để test được ngoài trình duyệt. */
(function () {
  "use strict";

  /* ================= Chuỗi giao diện (VI / EN / ZH) ================= */
  const T = {
    "nav.payReq": ["Đề nghị thanh toán", "Payment requests", "付款申请"],
    "nav.payReq.desc": ["Hóa đơn NCC (mạng, máy in, ...) → Giấy đề nghị thanh toán Excel", "Supplier invoices (network, printers, ...) → payment-request Excel", "供应商发票（网络、打印机等）→ 付款申请Excel"],
    "pq.title": ["📝 Đề nghị thanh toán", "📝 Payment requests", "📝 付款申请"],
    "pq.hint": [
      "Bước 1: chọn các hóa đơn/chứng từ PDF của NCC (mạng, máy in, mực, dịch vụ khác… chọn được nhiều file, nhiều NCC cùng lúc). Bước 2: kiểm tra số liệu app đọc được. Bước 3: mỗi NCC được gom thành 1 “Giấy đề nghị thanh toán” (Excel theo mẫu, nhiều dòng chứng từ) để in trình ký. File PDF được đọc ngay trên máy, không gửi lên server.",
      "Step 1: choose supplier PDF invoices/documents (network, printers, toner, other services… many files and suppliers at once). Step 2: review what was read. Step 3: each supplier becomes one “Payment Request” Excel (template, many document rows) to print for sign-off. PDFs are read on this device and never uploaded.",
      "第1步：选择供应商的PDF发票/凭证（网络、打印机、墨粉、其他服务……可一次选多个文件和多个供应商）。第2步：核对读取结果。第3步：每个供应商生成一份“付款申请”Excel（按模板，多行凭证）供打印签字。PDF在本设备读取，不会上传。"
    ],
    "pq.pick": ["Chọn hóa đơn / chứng từ PDF (chọn được nhiều file)", "Choose PDF invoices / documents (multiple allowed)", "选择PDF发票/凭证（可多选）"],
    "pq.addManual": ["✍ Thêm dòng nhập tay", "✍ Add manual row", "✍ 手动添加一行"],
    "pq.clear": ["🗑 Xóa hết", "🗑 Clear all", "🗑 清空"],
    "pq.clearConfirm": ["Xóa toàn bộ các dòng đang làm việc (chưa lưu)?", "Clear all rows in progress (not saved)?", "清空所有正在处理的行（未保存）？"],
    "pq.reading": ["Đang đọc {{n}} file...", "Reading {{n}} files...", "正在读取 {{n}} 个文件..."],
    "pq.readDone": ["Đã đọc xong {{n}} file: {{ok}} hóa đơn nhận dạng được{{extra}}.", "Finished {{n}} files: {{ok}} invoices recognised{{extra}}.", "已读取 {{n}} 个文件：识别出 {{ok}} 张发票{{extra}}。"],
    "pq.skipQuote": ["“{{f}}” là bảng báo giá, không phải chứng từ thanh toán — đã bỏ qua.", "“{{f}}” is a quotation, not a payable document — skipped.", "“{{f}}”是报价单，不是付款凭证——已跳过。"],
    "pq.skipAttach": ["“{{f}}” là bảng kê đính kèm hóa đơn — đã bỏ qua (dùng hóa đơn chính).", "“{{f}}” is a schedule attached to an invoice — skipped (use the invoice itself).", "“{{f}}”是发票附带明细表——已跳过（请使用发票本身）。"],
    "pq.scanRow": ["“{{f}}” là PDF dạng ảnh (scan) — không đọc được chữ. Nhập tay các ô bên dưới hoặc bấm “Thử đọc bằng OCR”.", "“{{f}}” is an image-only (scanned) PDF — no text can be read. Fill in the fields below or try OCR.", "“{{f}}”是图片型（扫描）PDF——无法读取文字。请手动填写下方字段或尝试OCR。"],
    "pq.unreadRow": ["Không nhận dạng được “{{f}}” — hãy nhập tay các ô bên dưới.", "Could not recognise “{{f}}” — fill in the fields below.", "无法识别“{{f}}”——请手动填写下方字段。"],
    "pq.readErr": ["Lỗi đọc “{{f}}”: {{err}}", "Error reading “{{f}}”: {{err}}", "读取“{{f}}”出错：{{err}}"],
    "pq.step2": ["Bước 2 — Kiểm tra chứng từ", "Step 2 — Review documents", "第2步 — 核对凭证"],
    "pq.step3": ["Bước 3 — Giấy đề nghị theo từng NCC", "Step 3 — One request per supplier", "第3步 — 每个供应商一份申请"],
    "pq.f.vendor": ["Tên NCC*", "Supplier name*", "供应商名称*"],
    "pq.f.tax": ["MST NCC", "Supplier tax code", "供应商税号"],
    "pq.f.cat": ["Nhóm", "Group", "类别"],
    "pq.f.docType": ["Loại chứng từ", "Document type", "凭证类型"],
    "pq.f.no": ["Số chứng từ*", "Document no.*", "凭证号*"],
    "pq.f.serial": ["Ký hiệu", "Serial", "符号"],
    "pq.f.date": ["Ngày*", "Date*", "日期*"],
    "pq.f.desc": ["Nội dung", "Description", "内容"],
    "pq.f.ex": ["Trước thuế*", "Ex VAT*", "不含税*"],
    "pq.f.rate": ["VAT %", "VAT %", "税率 %"],
    "pq.f.vat": ["Tiền VAT", "VAT amount", "税额"],
    "pq.f.total": ["Tổng thanh toán", "Total", "合计"],
    "pq.cat.net": ["Mạng / Internet", "Network / Internet", "网络/互联网"],
    "pq.cat.printer": ["Máy in / Photo / Mực", "Printers / Copiers / Toner", "打印机/复印机/墨粉"],
    "pq.cat.other": ["Khác", "Other", "其他"],
    "pq.dt.invoice": ["Hóa đơn GTGT", "VAT invoice", "增值税发票"],
    "pq.dt.notice": ["Thông báo cước", "Payment notice", "费用通知"],
    "pq.remove": ["✕ Bỏ", "✕ Remove", "✕ 移除"],
    "pq.ocr": ["🔍 Thử đọc bằng OCR", "🔍 Try OCR", "🔍 尝试OCR"],
    "pq.ocrBusy": ["Đang OCR (lần đầu tải dữ liệu ngôn ngữ, chờ chút)...", "Running OCR (first run downloads language data)...", "正在OCR（首次需下载语言数据）..."],
    "pq.ocrDone": ["OCR xong — kiểm tra kỹ số liệu vì chữ nhận dạng có thể sai.", "OCR finished — double-check the numbers, recognised text may be wrong.", "OCR完成——请仔细核对数字，识别结果可能有误。"],
    "pq.ocrFail": ["OCR không đọc được hóa đơn này: {{err}}", "OCR could not read this document: {{err}}", "OCR无法读取此凭证：{{err}}"],
    "pq.w.missing": ["Thiếu số chứng từ / ngày / số tiền.", "Missing document no. / date / amount.", "缺少凭证号/日期/金额。"],
    "pq.w.totalDiff": ["Tổng trên PDF ({{pdf}}) khác Trước thuế + VAT ({{now}}).", "PDF total ({{pdf}}) differs from Ex VAT + VAT ({{now}}).", "PDF合计（{{pdf}}）与不含税+税额（{{now}}）不一致。"],
    "pq.w.buyer": ["MST người mua trên hóa đơn là {{tax}}, khác MST công ty — kiểm tra lại hóa đơn có đúng tên công ty không.", "Buyer tax code on the invoice is {{tax}}, not the company's — check the invoice is addressed to us.", "发票上购买方税号为 {{tax}}，与公司税号不同——请核对发票抬头。"],
    "pq.w.dupBatch": ["Trùng với dòng #{{n}} (cùng NCC, cùng số chứng từ) — tránh thanh toán 2 lần.", "Same as row #{{n}} (same supplier and document no.) — avoid paying twice.", "与第 #{{n}} 行重复（同一供应商、同一凭证号）——避免重复付款。"],
    "pq.w.dupHistory": ["⚠ Chứng từ này ĐÃ có trong đề nghị {{code}} ngày {{date}} — kiểm tra kẻo thanh toán 2 lần.", "⚠ This document is ALREADY in request {{code}} dated {{date}} — check before paying twice.", "⚠ 该凭证已在 {{date}} 的申请 {{code}} 中——请核实以免重复付款。"],
    "pq.w.inDebt": ["ℹ Đã được ghi nhận trong công nợ {{mod}}.", "ℹ Already recorded in {{mod}} payables.", "ℹ 已记录在{{mod}}应付款中。"],
    "pq.w.ocr": ["Dữ liệu lấy bằng OCR — cần kiểm tra kỹ.", "Data was obtained by OCR — please verify carefully.", "数据由OCR获得——请仔细核对。"],
    "pq.g.docs": ["{{n}} chứng từ", "{{n}} document(s)", "{{n}} 份凭证"],
    "pq.g.total": ["Tổng đề nghị", "Request total", "申请总额"],
    "pq.g.receiver": ["Đơn vị nhận tiền", "Receiver", "收款单位"],
    "pq.g.account": ["Số tài khoản", "Bank account", "银行账号"],
    "pq.g.bank": ["Tại ngân hàng", "Bank", "开户银行"],
    "pq.g.bankAddr": ["Địa chỉ ngân hàng", "Bank address", "银行地址"],
    "pq.g.method": ["Hình thức thanh toán", "Payment method", "付款方式"],
    "pq.g.transfer": ["Chuyển khoản", "Bank transfer", "转账"],
    "pq.g.cash": ["Tiền mặt", "Cash", "现金"],
    "pq.g.from": ["Từ ngày", "From", "自"],
    "pq.g.due": ["Hạn chót", "Deadline", "截止"],
    "pq.g.reason": ["Lý do (Content)", "Reason (Content)", "事由 (Content)"],
    "pq.g.noBank": ["Chưa có số tài khoản/ngân hàng của NCC — điền vào (sẽ được nhớ cho lần sau) hoặc chuyển sang Tiền mặt.", "No bank account/bank for this supplier — fill it in (it will be remembered) or switch to Cash.", "该供应商缺少银行账号/银行——请填写（将被记住）或改为现金。"],
    "pq.g.make": ["📄 Tạo Excel cho NCC này", "📄 Create Excel for this supplier", "📄 为此供应商生成Excel"],
    "pq.s.title": ["Thông tin người ký (nhớ trên máy này)", "Signers (remembered on this device)", "签字人信息（本设备记住）"],
    "pq.s.code": ["Mã số (Code)", "Code", "编号 (Code)"],
    "pq.s.requester": ["Người đề nghị", "Requester", "申请人"],
    "pq.s.dept": ["Phòng ban", "Department", "部门"],
    "pq.s.head": ["Trưởng bộ phận", "Head of Dept", "部门主管"],
    "pq.s.chief": ["Kế toán trưởng", "Chief accountant", "总会计师"],
    "pq.s.finance": ["Quản lý tài chính", "Finance manager", "财务经理"],
    "pq.s.save": ["Lưu lịch sử đề nghị (để cảnh báo trùng hóa đơn)", "Save request history (to warn about duplicate invoices)", "保存申请记录（用于重复发票提醒）"],
    "pq.makeAll": ["📦 Tạo tất cả ({{n}} NCC)", "📦 Create all ({{n}} suppliers)", "📦 全部生成（{{n}} 个供应商）"],
    "pq.makeOne": ["📄 Tạo file Excel đề nghị thanh toán", "📄 Create payment-request Excel", "📄 生成付款申请Excel"],
    "pq.needRows": ["Chưa có chứng từ nào. Hãy chọn file PDF hoặc thêm dòng nhập tay.", "No documents yet. Choose PDF files or add a manual row.", "还没有凭证。请选择PDF文件或手动添加一行。"],
    "pq.needFields": ["Mỗi chứng từ cần: tên NCC, số chứng từ, ngày và số tiền > 0.", "Each document needs supplier name, document no., date and amount > 0.", "每份凭证需要：供应商名称、凭证号、日期及金额 > 0。"],
    "pq.confirmNoBank": ["NCC “{{name}}” chưa có số tài khoản/ngân hàng — vẫn tạo file?", "Supplier “{{name}}” has no bank account/bank — create the file anyway?", "供应商“{{name}}”缺少银行账号/银行——仍要生成文件吗？"],
    "pq.building": ["Đang tạo file Excel...", "Building Excel...", "正在生成Excel..."],
    "pq.done": ["Đã tạo {{n}} file ({{sum}}).", "Created {{n}} file(s) ({{sum}}).", "已生成 {{n}} 个文件（{{sum}}）。"],
    "pq.doneSaved": [" Đã lưu lịch sử.", " History saved.", " 已保存记录。"],
    "pq.errBuild": ["Không tạo được file Excel: {{err}}", "Could not build Excel: {{err}}", "无法生成Excel：{{err}}"],
    "pq.errSave": ["File đã tạo nhưng không lưu được lịch sử: {{err}}", "File created but history could not be saved: {{err}}", "文件已生成，但无法保存记录：{{err}}"],
    "pq.h.title": ["🕘 Lịch sử đề nghị đã lập", "🕘 Request history", "🕘 已制作的申请记录"],
    "pq.h.none": ["Chưa có đề nghị nào được lưu.", "No saved requests yet.", "暂无保存的申请。"],
    "pq.h.redo": ["📄 Tạo lại file", "📄 Rebuild file", "📄 重新生成文件"],
    "pq.h.del": ["🗑 Xóa", "🗑 Delete", "🗑 删除"],
    "pq.h.delConfirm": ["Xóa đề nghị {{code}} ({{vendor}}) khỏi lịch sử? (Không ảnh hưởng file Excel đã tải.)", "Delete request {{code}} ({{vendor}}) from history? (Downloaded Excel files are unaffected.)", "从记录中删除申请 {{code}}（{{vendor}}）？（已下载的Excel不受影响。）"],
    "pq.h.by": ["bởi {{who}}", "by {{who}}", "由 {{who}}"],
    "pq.ocrPdf": ["Không mở được PDF: {{err}}", "Could not open the PDF: {{err}}", "无法打开PDF：{{err}}"]
  };
  ["vi", "en", "zh"].forEach((lang, li) => {
    if (typeof I18N === "undefined" || !I18N[lang]) return;
    Object.keys(T).forEach(k => { I18N[lang][k] = T[k][li]; });
  });

  /* ================= Hàm thuần (test được ngoài trình duyệt) ================= */
  const BUYER_TAX = "1301132932";           // MST công ty (người mua) — dùng để cảnh báo hóa đơn xuất sai tên
  const CATS = ["net", "printer", "other"];
  const pad = n => String(n).padStart(2, "0");
  const digits = s => String(s || "").replace(/\D/g, "");
  const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const num = v => { const n = parseFloat(String(v).replace(/[^\d.\-]/g, "")); return isFinite(n) ? n : 0; };
  const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  function addDaysIso(dateStr, n) { const d = new Date(dateStr + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
  const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  // Kỳ "YYYY-MM" suy từ nội dung ("tháng 8/2026", "tháng 08 năm 2026") hoặc từ ngày hóa đơn.
  function periodOf(desc, dateIso) {
    const m = /tháng\s+(\d{1,2})\s*(?:\/|năm)\s*(\d{4})/i.exec(desc || "");
    if (m) return `${m[2]}-${pad(m[1])}`;
    return (dateIso || "").slice(0, 7);
  }

  function guessCategory(desc) {
    const d = String(desc || "").toLowerCase();
    if (/thuê máy|photo|máy in|mực|toner|drum|gạt mực|nạp mực|linh kiện máy|trống từ|cụm sấy/.test(d)) return "printer";
    if (/cước|internet|viễn thông|fiber|ftth|leased|kênh thuê|điện thoại cố định|băng thông/.test(d)) return "net";
    return "other";
  }

  const emptyRow = () => ({
    file: "", kind: "manual", category: "other", docType: "invoice",
    vendorName: "", vendorTax: "", account: "", bank: "", bankAddress: "", phone: "", address: "",
    serial: "", no: "", date: "", period: "", due: "", desc: "",
    ex: 0, rate: 8, vat: 0, total: 0, pdfTotal: 0, buyerTax: "", ocr: false, scan: false
  });

  // Chuẩn hóa: nếu lệch ≤ 2đ do làm tròn -> ưu tiên giữ đúng tổng in trên hóa đơn.
  function settleAmounts(r, pdfTotal) {
    r.ex = Math.round(Number(r.ex) || 0); r.vat = Math.round(Number(r.vat) || 0);
    r.pdfTotal = Math.round(Number(pdfTotal) || 0);
    if (r.pdfTotal && r.ex && Math.abs(r.ex + r.vat - r.pdfTotal) <= 2) r.vat = r.pdfTotal - r.ex;
    if (r.pdfTotal && r.ex && !r.vat && r.pdfTotal > r.ex) r.vat = r.pdfTotal - r.ex;
    r.total = r.ex + r.vat;
    if (r.ex && !r.rate && r.vat) r.rate = Math.round(r.vat / r.ex * 100);
    return r;
  }

  function fromNet(n) {
    const r = emptyRow();
    const seed = ((window.NetIsp && window.NetIsp.SEED && window.NetIsp.SEED.providers) || []).find(p => p.key === n.provider);
    Object.assign(r, {
      kind: n.kind, category: "net", docType: n.docType, vendorName: n.sellerName || (seed && seed.receiverName) || "",
      vendorTax: n.sellerTax || (seed && seed.taxCode) || "", serial: n.serial || "", no: n.no || "", date: n.date || "",
      period: n.period || "", due: n.due || "", desc: n.desc || "", ex: n.ex, rate: n.rate || 10, vat: n.vat
    });
    return settleAmounts(r, n.total);
  }
  function fromGeneric(g, fileName) {
    const r = emptyRow();
    const desc = g.items.map(i => i.desc).filter(Boolean).join("; ");
    Object.assign(r, {
      kind: "invoice", category: guessCategory(desc), docType: "invoice", vendorName: g.seller.name, vendorTax: g.seller.tax,
      account: g.seller.account, bank: g.seller.bank, phone: g.seller.phone, address: g.seller.address,
      serial: g.serial, no: g.number, date: g.date, period: periodOf(desc, g.date), desc,
      ex: g.exVat, rate: g.vatRate != null ? g.vatRate : (g.exVat ? Math.round(g.vat / g.exVat * 100) : 0), vat: g.vat, buyerTax: g.buyer.tax
    });
    return settleAmounts(r, g.total);
  }

  /* Nhận dạng 1 file PDF (chữ đã trích). Trả { row, skip } — skip: "scan" | "quote" | "attach" | "" */
  function parseAny(text, fileName) {
    const t = String(text || "").normalize("NFC");
    const out = { row: null, skip: "" };
    if (t.replace(/\s/g, "").length < 40) { out.skip = "scan"; return out; }
    const net = window.NetIsp && window.NetIsp.parseNetDoc(t);
    if (net && (net.no || net.total)) { out.row = fromNet(net); out.row.file = fileName || ""; return out; }
    const g = window.PrPay.parseInvoiceText(t);
    if (g.ok) { out.row = fromGeneric(g, fileName); out.row.file = fileName || ""; return out; }
    const head = t.slice(0, 900);
    if (/BẢNG BÁO GIÁ|BÁO GIÁ/i.test(head) && !g.number) { out.skip = "quote"; return out; }
    if (/BẢNG KÊ/i.test(head) && !g.number) { out.skip = "attach"; return out; }
    out.skip = "unread";
    return out;
  }

  /* ---------- Danh bạ NCC (để điền sẵn STK ngân hàng, hạn thanh toán) ---------- */
  const LEARN_KEY = "payReqVendors";
  function loadLearned() { try { return JSON.parse(localStorage.getItem(LEARN_KEY) || "[]"); } catch (e) { return []; } }
  function learnVendor(v) {
    if (!v || !(v.tax || v.name)) return;
    try {
      const list = loadLearned();
      const k = digits(v.tax) || norm(v.name);
      const i = list.findIndex(x => (digits(x.tax) || norm(x.name)) === k);
      const merged = Object.assign({}, i >= 0 ? list[i] : {}, Object.fromEntries(Object.entries(v).filter(([, x]) => x !== "" && x != null)));
      if (i >= 0) list[i] = merged; else list.push(merged);
      localStorage.setItem(LEARN_KEY, JSON.stringify(list.slice(-200)));
    } catch (e) { /* bỏ qua */ }
  }
  // Thứ tự ưu tiên: dữ liệu công nợ Máy in/Network (Firestore) > NCC đã nhớ > dữ liệu nạp sẵn.
  function directory() {
    const out = [];
    const fromStore = (list, cat) => (list || []).forEach(v => out.push({
      name: v.name || "", tax: v.taxCode || "", receiver: v.receiverName || "", account: v.bankAccount || "", bank: v.bankName || "",
      bankAddress: v.bankAddress || "", terms: v.paymentTerms, dueDay: v.dueDay, cat
    }));
    try { if (window.PrCore) fromStore(window.PrCore.vendors, "printer"); } catch (e) { /* bỏ qua */ }
    try { if (window.NetIsp && window.NetIsp.state) fromStore(window.NetIsp.state().providers, "net"); } catch (e) { /* bỏ qua */ }
    loadLearned().forEach(v => out.push(v));
    ((window.NetIsp && window.NetIsp.SEED && window.NetIsp.SEED.providers) || []).forEach(p => out.push({
      name: p.name, tax: p.taxCode, receiver: p.receiverName, account: p.bankAccount, bank: p.bankName, bankAddress: p.bankAddress || "", terms: p.paymentTerms, dueDay: p.dueDay, cat: "net"
    }));
    return out;
  }
  function findVendor(tax, name) {
    const t = digits(tax), n = norm(name);
    const hits = directory().filter(v => {
      if (t && digits(v.tax) === t) return true;
      if (t && digits(v.tax) && digits(v.tax) !== t) return false;
      const a = norm(v.name), b = norm(v.receiver);
      return n.length >= 5 && ((a.length >= 5 && (a.includes(n) || n.includes(a))) || (b.length >= 5 && (b.includes(n) || n.includes(b))));
    });
    if (!hits.length) return null;
    const merged = {};
    hits.forEach(h => Object.keys(h).forEach(k => { if ((merged[k] === undefined || merged[k] === "" || merged[k] == null) && h[k] !== "" && h[k] != null) merged[k] = h[k]; }));
    return merged;
  }

  /* ---------- Gom theo NCC ---------- */
  const groupKey = r => digits(r.vendorTax) || norm(r.vendorName) || "?";
  function groupRows(rows) {
    const map = new Map();
    rows.forEach(r => {
      const k = groupKey(r);
      if (!map.has(k)) map.set(k, { key: k, rows: [] });
      map.get(k).rows.push(r);
    });
    return Array.from(map.values());
  }

  function monthsVi(periods) { return periods.map(p => `${p.slice(5)}/${p.slice(0, 4)}`).join(", "); }
  function monthsEn(periods) { return periods.map(p => `${MONTHS_EN[+p.slice(5) - 1]} ${p.slice(0, 4)}`).join(", "); }

  // Lý do thanh toán (song ngữ) tự sinh theo nhóm chứng từ.
  function reasonFor(rows) {
    const periods = Array.from(new Set(rows.map(r => r.period || periodOf(r.desc, r.date)).filter(p => /^\d{4}-\d{2}$/.test(p)))).sort();
    const cats = Array.from(new Set(rows.map(r => r.category)));
    const descs = rows.map(r => r.desc).join(" ; ");
    if (cats.length === 1 && cats[0] === "net" && window.NetIsp) return window.NetIsp.reasonFor(periods.map(p => ({ period: p })));
    if (cats.length === 1 && cats[0] === "printer") {
      const has = re => re.test(descs);
      const photo = has(/photo/i);
      const dev = photo ? ["máy photocopy", "photocopier"] : ["máy in", "printer"];
      const kinds = [];
      if (has(/thuê/i)) kinds.push(["thuê " + dev[0], dev[1] + " rental"]);
      if (has(/sửa|thay|bảo trì|bảo dưỡng|vệ sinh|linh kiện/i)) kinds.push(["sửa chữa " + dev[0], dev[1] + " repair"]);
      if (has(/mực|toner|drum|vật tư/i)) kinds.push(["mực & vật tư " + dev[0], dev[1] + " toner & supplies"]);
      const vi = kinds.length ? kinds.map(k => k[0]).join(", ") : "dịch vụ " + dev[0];
      const en = kinds.length ? kinds.map(k => k[1]).join(", ") : dev[1] + " services";
      return `Thanh toán hóa đơn ${vi}${periods.length ? " tháng " + monthsVi(periods) : ""} / Payment for ${en} invoice${periods.length ? " for " + monthsEn(periods) : ""}`;
    }
    const nos = rows.map(r => r.no).filter(Boolean).join(", ");
    const d = (rows[0] && rows[0].desc || "").replace(/\s+/g, " ").slice(0, 90);
    return `Thanh toán hóa đơn${d ? " " + d : ""}${nos ? " số " + nos : ""} / Payment for invoice${nos ? " no. " + nos : ""}`;
  }

  // Hạn thanh toán của 1 chứng từ: ưu tiên hạn ghi trên chứng từ, rồi theo NCC (ngày cố định/số ngày), mặc định 30 ngày.
  function dueOf(r, vendor) {
    if (r.due) return r.due;
    if (!r.date) return "";
    if (vendor && vendor.cat === "net" && window.NetIsp && (vendor.dueDay || vendor.terms != null)) {
      return window.NetIsp.dueFor({ dueDay: vendor.dueDay, paymentTerms: vendor.terms }, r.date);
    }
    const terms = vendor && vendor.terms != null && vendor.terms !== "" ? Number(vendor.terms) : 30;
    return addDaysIso(r.date, terms);
  }

  // Giá trị mặc định của 1 giấy đề nghị (theo NCC).
  function groupDefaults(g) {
    const rows = g.rows, first = rows[0];
    const v = findVendor(first.vendorTax, first.vendorName) || {};
    const pick = f => v[f] || (rows.find(r => r[f]) || {})[f] || "";
    const dates = rows.map(r => r.date).filter(Boolean).sort();
    const dues = rows.map(r => dueOf(r, v)).filter(Boolean).sort();
    return {
      receiver: v.receiver || first.vendorName || v.name || "", account: v.account || pick("account"), bank: v.bank || pick("bank"),
      bankAddress: v.bankAddress || "", method: "transfer", from: dates[0] || "", due: dues[0] || "", reason: reasonFor(rows)
    };
  }

  const docNo = r => (r.docType === "notice" && r.period) ? `TBC ${r.period.slice(5)}/${r.period.slice(0, 4)}` : r.no;
  const docLabel = r => r.docType === "notice" ? "Thông báo cước/ Payment notice" : ("Hóa đơn GTGT/ VAT invoice" + (r.serial ? ` (${r.serial})` : ""));

  // Dữ liệu cho PrPay.buildPaymentXlsx (nhiều dòng chứng từ).
  function buildRequestData(rows, cfg, s) {
    const sorted = rows.slice().sort((a, b) => (a.date || "").localeCompare(b.date || "") || String(a.no).localeCompare(String(b.no)));
    return {
      code: s.code, dateReq: s.dateReq, requester: s.requester, dept: s.dept, head: s.head, chief: s.chief, finance: s.finance,
      reason: cfg.reason, method: cfg.method || "transfer", receiver: cfg.receiver, account: cfg.account, bank: cfg.bank, bankAddress: cfg.bankAddress,
      from: cfg.from, due: cfg.due,
      docs: sorted.map(r => ({ no: docNo(r), desc: docLabel(r), date: r.date, ex: Number(r.ex) || 0, vat: Number(r.vat) || 0 }))
    };
  }

  const STOP = /^(cong|ty|tnhh|mtv|cophan|co|phan|tap|doan|san|xuat|thuong|mai|dich|vu|cn|tm|mot|thanh|vien)$/;
  // Tên ngắn dùng đặt tên file: tên ngắn (<= 18 ký tự) giữ nguyên, tên dài bỏ "CÔNG TY TNHH..." rồi lấy 2 từ cuối.
  function shortName(name) {
    const clean = String(name || "").normalize("NFC").replace(/(?<![\p{L}\p{N}])(\p{L})\s(?=\p{L}(?![\p{L}\p{N}]))/gu, "$1"); // "D N P" -> "DNP"
    const words = clean.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (!words.length) return "NCC";
    if (words.join("-").length <= 18) return words.join("-");
    const keep = words.filter(w => !STOP.test(w.toLowerCase()));
    return (keep.length ? keep : words).slice(-2).join("-");
  }
  // Tên gọn của NCC: ưu tiên tên ngắn nhất đã có trong danh bạ (vd "VNPT Vĩnh Long", "DNP"), không thì tên trên hóa đơn.
  function vendorLabel(tax, name) {
    const t = digits(tax);
    const names = directory().filter(v => t && digits(v.tax) === t).map(v => String(v.name || "").replace(/\(.*?\)/g, "").trim()).filter(Boolean);
    names.sort((a, b) => a.length - b.length);
    return names[0] || name || "";
  }

  window.PayReq = {
    parseAny, guessCategory, periodOf, reasonFor, groupRows, groupDefaults, buildRequestData, findVendor, dueOf, shortName, vendorLabel, docNo, settleAmounts, emptyRow,
    learnVendor, BUYER_TAX, CATS
  };

  /* ================= UI ================= */
  const $ = id => document.getElementById(id);
  if (!$("pqFile")) return; // (harness/test không có trang này)

  const HIST_COL = "pay_requests";
  const SETTINGS_KEY = "prPayReqSettings"; // dùng chung với module Máy in / Network
  const DEFAULTS = { code: "ACC-001", requester: "BÙI KHÁNH NGUYÊN", dept: "IT", head: "Lê Nhật Thành", chief: "HỒ THANH TÂM", finance: "Chen Lai Chong – John" };
  const loadSettings = () => { try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); } catch (e) { return Object.assign({}, DEFAULTS); } };
  const saveSettings = s => { try { const old = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); localStorage.setItem(SETTINGS_KEY, JSON.stringify(Object.assign(old, s))); } catch (e) { /* bỏ qua */ } };

  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const money = n => (Number(n) || 0).toLocaleString("vi-VN") + " ₫";
  const todayStr = () => { const d = new Date(); return iso(d.getFullYear(), d.getMonth() + 1, d.getDate()); };
  const fmtDate = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || ""); };
  const canSaveHistory = () => typeof isAdmin !== "undefined" && isAdmin;
  const canReadHistory = () => typeof isAdmin !== "undefined" && (isAdmin || (typeof isViewer !== "undefined" && isViewer));

  let rows = [];       // các dòng chứng từ đang làm việc
  let cfgs = {};       // cấu hình từng giấy đề nghị theo khóa NCC: { [key]: {receiver, account, ..., touched:{}} }
  let history = [], unsub = null, seq = 0;

  /* ---------- Cảnh báo ---------- */
  function warningsFor(r, idx) {
    const w = [];
    if (!r.no || !r.date || !(r.total > 0)) w.push({ t: "warn", m: tr("pq.w.missing") });
    if (r.pdfTotal && r.pdfTotal !== r.total) w.push({ t: "warn", m: tr("pq.w.totalDiff", { pdf: money(r.pdfTotal), now: money(r.total) }) });
    if (r.buyerTax && digits(r.buyerTax) !== BUYER_TAX) w.push({ t: "warn", m: tr("pq.w.buyer", { tax: r.buyerTax }) });
    if (r.ocr) w.push({ t: "warn", m: tr("pq.w.ocr") });
    if (r.ai) {
      w.push({ t: "warn", m: tr("pq.w.ai", { c: r.ai.confidence || "?" }) });
      (r.ai.warnings || []).forEach(m => w.push({ t: "warn", m: tr("pq.w.aiNote", { m }) }));
    }
    const k = groupKey(r);
    const dup = rows.findIndex((x, j) => j < idx && r.no && x.no === r.no && groupKey(x) === k);
    if (dup >= 0) w.push({ t: "bad", m: tr("pq.w.dupBatch", { n: dup + 1 }) });
    const h = r.no ? historyHit(r) : null;
    if (h) w.push({ t: "bad", m: tr("pq.w.dupHistory", { code: h.code || "?", date: fmtDate(h.dateReq) }) });
    const d = r.no ? debtHit(r) : "";
    if (d) w.push({ t: "info", m: tr("pq.w.inDebt", { mod: d }) });
    return w;
  }
  function historyHit(r) {
    const k = groupKey(r);
    for (const h of history) {
      if ((digits(h.vendorTax) || norm(h.vendorName)) !== k) continue;
      if ((h.docs || []).some(d => String(d.no) === String(r.no) || String(d.no) === String(window.PayReq.docNo(r)))) return h;
    }
    return null;
  }
  // Hóa đơn đã có trong công nợ của module Máy in / Network (chỉ có dữ liệu khi tài khoản đọc được Firestore).
  function debtHit(r) {
    const t = digits(r.vendorTax);
    try {
      if (window.PrCore && t) {
        const v = window.PrCore.vendors.find(x => digits(x.taxCode) === t);
        if (v && window.PrCore.invoices.some(i => i.vendorId === v._id && String(i.invoiceNo || "") === String(r.no))) return tr("nav.printers");
      }
      if (window.NetIsp && window.NetIsp.state && t) {
        const st = window.NetIsp.state();
        const p = st.providers.find(x => digits(x.taxCode) === t);
        if (p && st.bills.some(b => b.providerId === p._id && String(b.invoiceNo || "") === String(r.no))) return tr("nav.network");
      }
    } catch (e) { /* bỏ qua */ }
    return "";
  }

  /* ---------- Dựng giao diện ---------- */
  const catOpts = sel => CATS.map(c => `<option value="${c}"${c === sel ? " selected" : ""}>${esc(tr("pq.cat." + c))}</option>`).join("");
  const dtOpts = sel => ["invoice", "notice"].map(c => `<option value="${c}"${c === sel ? " selected" : ""}>${esc(tr("pq.dt." + c))}</option>`).join("");
  const fld = (i, f, label, val, extra) => `<label class="${extra && extra.cls || ""}"><span>${esc(tr(label))}</span><input data-f="${f}" data-i="${i}" value="${esc(val)}" ${extra && extra.attr || ""}></label>`;

  function rowHtml(r, i) {
    return `<div class="card pq-row" data-row="${i}">
      <div class="pq-row-head"><b>#${i + 1}</b> <span class="muted">${esc(r.file || "✍")}</span>
        <span class="pq-spacer"></span>
        ${r.scan ? `<button type="button" class="secondary pq-mini" data-act="ocr" data-i="${i}">${esc(tr("pq.ocr"))}</button>` : ""}
        ${r.fileObj && window.AIX && window.AIX.ready && window.AIX.ready() ? `<button type="button" class="pq-mini" data-act="ai" data-i="${i}">${esc(tr("pq.ai"))}</button>` : ""}
        <button type="button" class="ghost pq-mini" data-act="del" data-i="${i}">${esc(tr("pq.remove"))}</button></div>
      <div class="pq-alerts" id="pqW${i}"></div>
      <div class="pq-grid">
        ${fld(i, "vendorName", "pq.f.vendor", r.vendorName, { cls: "full" })}
        ${fld(i, "vendorTax", "pq.f.tax", r.vendorTax, { attr: 'inputmode="numeric"' })}
        <label><span>${esc(tr("pq.f.cat"))}</span><select data-f="category" data-i="${i}">${catOpts(r.category)}</select></label>
        <label><span>${esc(tr("pq.f.docType"))}</span><select data-f="docType" data-i="${i}">${dtOpts(r.docType)}</select></label>
        ${fld(i, "no", "pq.f.no", r.no)}
        ${fld(i, "serial", "pq.f.serial", r.serial)}
        ${fld(i, "date", "pq.f.date", r.date, { attr: 'type="date"' })}
        <label class="full"><span>${esc(tr("pq.f.desc"))}</span><textarea data-f="desc" data-i="${i}" rows="2">${esc(r.desc)}</textarea></label>
        ${fld(i, "ex", "pq.f.ex", r.ex || "", { attr: 'inputmode="numeric"' })}
        ${fld(i, "rate", "pq.f.rate", r.rate, { attr: 'inputmode="decimal"' })}
        ${fld(i, "vat", "pq.f.vat", r.vat || "", { attr: 'inputmode="numeric"' })}
        <label><span>${esc(tr("pq.f.total"))}</span><input data-f="total" data-i="${i}" value="${esc(r.total || "")}" readonly></label>
      </div>
    </div>`;
  }

  function renderRows() {
    $("pqRowsWrap").classList.toggle("hidden", rows.length === 0);
    $("pqRows").innerHTML = rows.map(rowHtml).join("");
    refreshWarnings();
    renderGroups();
  }
  function refreshWarnings() {
    rows.forEach((r, i) => {
      const el = $("pqW" + i); if (!el) return;
      const w = warningsFor(r, i);
      if (r.scanMsg) w.unshift({ t: "warn", m: r.scanMsg });
      el.innerHTML = w.map(x => `<div class="pr-alert ${x.t}">${esc(x.m)}</div>`).join("");
    });
  }

  function cfgFor(g) {
    const d = groupDefaults(g);
    const c = cfgs[g.key] || (cfgs[g.key] = { touched: {} });
    Object.keys(d).forEach(f => { if (!c.touched[f]) c[f] = d[f]; });
    return c;
  }
  const groupTotal = g => g.rows.reduce((s, r) => s + (Number(r.total) || 0), 0);

  function groupHtml(g) {
    const c = cfgFor(g), k = esc(g.key), first = g.rows[0];
    const list = g.rows.map(r => `<div class="pq-doc"><span>${esc(window.PayReq.docNo(r) || "?")}</span><span class="muted">${esc(fmtDate(r.date))}</span><b>${esc(money(r.total))}</b></div>`).join("");
    const gf = (f, label, extra) => `<label class="${extra && extra.cls || ""}"><span>${esc(tr(label))}</span><input data-g="${k}" data-gf="${f}" value="${esc(c[f])}" ${extra && extra.attr || ""}></label>`;
    return `<div class="card pq-group" data-gk="${k}">
      <h4>${esc(first.vendorName || "?")} <span class="muted">· ${esc(first.vendorTax || "—")} · ${esc(tr("pq.g.docs", { n: g.rows.length }))}</span></h4>
      <div class="pq-docs">${list}</div>
      <div class="pr-summary">${esc(tr("pq.g.total"))}: <span data-gtotal="${k}">${esc(money(groupTotal(g)))}</span></div>
      <div class="pq-grid">
        ${gf("receiver", "pq.g.receiver", { cls: "full" })}
        ${gf("account", "pq.g.account", { attr: 'inputmode="numeric"' })}
        ${gf("bank", "pq.g.bank")}
        ${gf("bankAddress", "pq.g.bankAddr", { cls: "full" })}
        <label class="full"><span>${esc(tr("pq.g.method"))}</span><select data-g="${k}" data-gf="method">
          <option value="transfer"${c.method !== "cash" ? " selected" : ""}>${esc(tr("pq.g.transfer"))}</option>
          <option value="cash"${c.method === "cash" ? " selected" : ""}>${esc(tr("pq.g.cash"))}</option></select></label>
        ${gf("from", "pq.g.from", { attr: 'type="date"' })}
        ${gf("due", "pq.g.due", { attr: 'type="date"' })}
        <label class="full"><span>${esc(tr("pq.g.reason"))}</span><textarea data-g="${k}" data-gf="reason" rows="3">${esc(c.reason)}</textarea></label>
      </div>
      <div class="pq-alerts" data-gw="${k}"></div>
      <div class="quick"><button type="button" data-act="make" data-g="${k}">${esc(tr("pq.g.make"))}</button></div>
    </div>`;
  }
  function groupWarn(g) {
    const c = cfgFor(g);
    return (c.method !== "cash" && !c.account) ? `<div class="pr-alert warn">${esc(tr("pq.g.noBank"))}</div>` : "";
  }
  function renderGroups() {
    const groups = groupRows(rows);
    $("pqGroupsWrap").classList.toggle("hidden", groups.length === 0);
    Object.keys(cfgs).forEach(k => { if (!groups.some(g => g.key === k)) delete cfgs[k]; });
    $("pqGroups").innerHTML = groups.map(groupHtml).join("");
    groups.forEach(g => { const el = document.querySelector(`[data-gw="${CSS.escape(g.key)}"]`); if (el) el.innerHTML = groupWarn(g); });
    const all = $("pqMakeAll");
    all.textContent = groups.length > 1 ? tr("pq.makeAll", { n: groups.length }) : tr("pq.makeOne");
    all.classList.toggle("hidden", groups.length === 0);
  }
  function fillSettings() {
    const s = loadSettings();
    $("pqCode").value = s.code; $("pqRequester").value = s.requester; $("pqDept").value = s.dept; $("pqHead").value = s.head; $("pqChief").value = s.chief; $("pqFinance").value = s.finance;
  }
  function signer() {
    const s = { code: $("pqCode").value.trim() || DEFAULTS.code, requester: $("pqRequester").value.trim(), dept: $("pqDept").value.trim(), head: $("pqHead").value.trim(), chief: $("pqChief").value.trim(), finance: $("pqFinance").value.trim(), dateReq: todayStr() };
    return s;
  }

  window.renderPayReq = function () {
    if (!$("pqRequester").value) fillSettings();
    $("pqSaveHistWrap").classList.toggle("hidden", !canSaveHistory());
    renderRows();
    renderHistory();
  };

  /* ---------- Sự kiện chỉnh sửa ---------- */
  $("pqRows").addEventListener("input", e => {
    const el = e.target, f = el.getAttribute("data-f"); if (!f) return;
    const r = rows[+el.getAttribute("data-i")]; if (!r) return;
    const v = el.value;
    if (["ex", "vat"].includes(f)) r[f] = Math.round(num(v));
    else if (f === "rate") r.rate = num(v);
    else r[f] = v;
    const row = el.closest(".pq-row");
    if (f === "ex" || f === "rate") { r.vat = Math.round(r.ex * r.rate / 100); const vi = row.querySelector('[data-f="vat"]'); if (vi) vi.value = r.vat || ""; }
    if (["ex", "rate", "vat"].includes(f)) { r.total = r.ex + r.vat; const ti = row.querySelector('[data-f="total"]'); if (ti) ti.value = r.total || ""; }
    refreshWarnings();
  });
  $("pqRows").addEventListener("change", e => {
    const f = e.target.getAttribute("data-f"); if (!f) return;
    const r = rows[+e.target.getAttribute("data-i")]; if (!r) return;
    if (f === "vendorTax" || f === "vendorName") { r.vendorTax = r.vendorTax.trim(); }
    if (f === "desc") { r.period = periodOf(r.desc, r.date); }
    if (f === "date") { r.period = periodOf(r.desc, r.date); }
    if (f === "category" || f === "docType" || f === "desc" || f === "date" || f === "vendorTax" || f === "vendorName" || f === "no") {
      // các trường này ảnh hưởng lý do/hạn thanh toán/gom nhóm -> tính lại (giữ nguyên ô người dùng đã tự sửa)
      renderGroups(); refreshWarnings();
    } else { renderGroups(); }
  });
  $("pqRows").addEventListener("click", e => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const i = +b.getAttribute("data-i");
    if (b.getAttribute("data-act") === "del") { rows.splice(i, 1); renderRows(); }
    else if (b.getAttribute("data-act") === "ocr") ocrRow(i);
    else if (b.getAttribute("data-act") === "ai") aiRow(i);
  });
  $("pqGroups").addEventListener("input", e => {
    const el = e.target, gk = el.getAttribute("data-g"), f = el.getAttribute("data-gf"); if (!gk || !f) return;
    const c = cfgs[gk]; if (!c) return;
    c[f] = el.value; c.touched[f] = true;
    if (f === "account" || f === "method") { const g = groupRows(rows).find(x => x.key === gk); const w = document.querySelector(`[data-gw="${CSS.escape(gk)}"]`); if (g && w) w.innerHTML = groupWarn(g); }
  });
  $("pqGroups").addEventListener("change", e => {
    const el = e.target;
    if (el.getAttribute("data-gf") === "method") { const c = cfgs[el.getAttribute("data-g")]; if (c) { c.method = el.value; c.touched.method = true; } const g = groupRows(rows).find(x => x.key === el.getAttribute("data-g")); const w = document.querySelector(`[data-gw="${CSS.escape(el.getAttribute("data-g"))}"]`); if (g && w) w.innerHTML = groupWarn(g); }
  });
  $("pqGroups").addEventListener("click", e => {
    const b = e.target.closest('[data-act="make"]'); if (b) makeFiles([b.getAttribute("data-g")]);
  });
  $("pqMakeAll").addEventListener("click", () => makeFiles(groupRows(rows).map(g => g.key)));
  ["pqCode", "pqRequester", "pqDept", "pqHead", "pqChief", "pqFinance"].forEach(id => $(id).addEventListener("change", () => saveSettings(signer())));

  $("pqManualBtn").addEventListener("click", () => {
    const r = emptyRow(); r.date = todayStr(); r.file = "";
    rows.push(r); renderRows();
    const last = document.querySelector(".pq-row:last-child"); if (last && last.scrollIntoView) last.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("pqClearBtn").addEventListener("click", () => {
    if (!rows.length || !confirm(tr("pq.clearConfirm"))) return;
    rows = []; cfgs = {}; $("pqStatus").textContent = ""; renderRows();
  });

  /* ---------- Đọc PDF ----------
     ensurePdfJs/ensureJSZip/pdfToText dùng chung từ window.PrPay (định nghĩa ở
     printers-payreq.js, nạp trước file này) — trước đây payreq.js, network-isp.js
     và printers-payreq.js mỗi file tự cài 1 bản riêng của 3 hàm này, giống hệt
     nhau, nay gộp lại 1 chỗ. loadScript() vẫn giữ ở đây vì còn dùng riêng để nạp
     Tesseract.js (OCR) — không liên quan tới pdf.js/jszip. */
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error(src)); document.head.appendChild(s); });
  }
  const ensurePdfJs = () => window.PrPay.ensurePdfJs();
  const ensureJSZip = () => window.PrPay.ensureJSZip();
  const pdfToText = file => window.PrPay.pdfToText(file);
  async function openPdf(file) {
    const lib = await ensurePdfJs();
    return lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  }

  $("pqFile").addEventListener("change", async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    const st = $("pqStatus");
    st.textContent = tr("pq.reading", { n: files.length });
    let ok = 0; const notes = [];
    for (const f of files) {
      try {
        const res = parseAny(await pdfToText(f), f.name);
        if (res.row) { res.row.fileObj = f; rows.push(res.row); ok++; }
        else if (res.skip === "quote") notes.push(tr("pq.skipQuote", { f: f.name }));
        else if (res.skip === "attach") notes.push(tr("pq.skipAttach", { f: f.name }));
        else {
          const r = emptyRow(); r.file = f.name; r.fileObj = f; r.date = todayStr();
          if (res.skip === "scan") { r.scan = true; r.scanMsg = tr("pq.scanRow", { f: f.name }); }
          else r.scanMsg = tr("pq.unreadRow", { f: f.name });
          rows.push(r);
        }
      } catch (err) {
        notes.push(tr("pq.readErr", { f: f.name, err: err.message }));
      }
    }
    st.innerHTML = esc(tr("pq.readDone", { n: files.length, ok, extra: "" })) + notes.map(n => `<div class="pr-alert warn">${esc(n)}</div>`).join("");
    renderRows();
  });

  // OCR (tùy chọn) cho PDF dạng ảnh: render trang 1 -> Tesseract.js (tải từ CDN, lần đầu cần mạng).
  async function ocrRow(i) {
    const r = rows[i]; if (!r || !r.fileObj) return;
    const st = $("pqStatus");
    st.textContent = tr("pq.ocrBusy");
    try {
      let doc;
      try { doc = await openPdf(r.fileObj); } catch (err) { throw new Error(tr("pq.ocrPdf", { err: err.message })); }
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale: 2.4 });
      const canvas = document.createElement("canvas"); canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      if (!window.Tesseract) await loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js");
      const out = await window.Tesseract.recognize(canvas, "vie+eng");
      const res = parseAny(out.data.text, r.file);
      if (!res.row) throw new Error(tr("pq.unreadRow", { f: r.file }));
      const keepFile = r.fileObj;
      rows[i] = Object.assign(res.row, { fileObj: keepFile, ocr: true, scan: true });
      st.textContent = tr("pq.ocrDone");
      renderRows();
    } catch (err) {
      st.textContent = tr("pq.ocrFail", { err: err.message });
    }
  }

  // AI (Gemini qua Worker, structured outputs) đọc thẳng file PDF/ảnh gốc qua AI Worker (ai.js) —
  // dùng khi regex không nhận dạng được, PDF scan, hoặc muốn đối chiếu lại số liệu.
  // Kết quả có cùng dạng với PrPay.parseInvoiceText nên đi qua đúng fromGeneric()/settleAmounts() như cũ.
  async function aiRow(i) {
    const r = rows[i]; if (!r || !r.fileObj || !window.AIX) return;
    const st = $("pqStatus");
    st.textContent = tr("pq.aiBusy");
    const btn = document.querySelector(`[data-act="ai"][data-i="${i}"]`); if (btn) btn.disabled = true;
    try {
      const g = await window.AIX.extractInvoice(r.fileObj);
      if (!g.ok) throw new Error(tr("pq.unreadRow", { f: r.file }));
      const row = fromGeneric(g, r.file);
      if (g.docKind === "notice") row.docType = "notice";
      if (g.period) row.period = g.period;
      const warnings = (g.warnings || []).slice();
      if (g.docKind === "quote" || g.docKind === "attachment" || g.docKind === "other") warnings.unshift(tr("pq.aiKind", { k: g.docKind }));
      rows[i] = Object.assign(row, { file: r.file, fileObj: r.fileObj, ai: { confidence: g.confidence, warnings } });
      st.textContent = tr("pq.aiDone");
      renderRows();
    } catch (err) {
      st.textContent = tr("pq.aiFail", { err: err.message });
      if (btn) btn.disabled = false;
    }
  }

  /* ---------- Tạo file Excel ---------- */
  function validateGroups(keys) {
    const groups = groupRows(rows).filter(g => keys.indexOf(g.key) !== -1);
    if (!groups.length) { alert(tr("pq.needRows")); return null; }
    for (const g of groups) {
      if (g.rows.some(r => !r.vendorName || !r.no || !r.date || !(r.total > 0))) { alert(tr("pq.needFields")); return null; }
      const c = cfgFor(g);
      if (c.method !== "cash" && !c.account && !confirm(tr("pq.confirmNoBank", { name: c.receiver || g.rows[0].vendorName }))) return null;
    }
    return groups;
  }
  function download(bytes, name, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const stamp = () => todayStr().replace(/-/g, "");
  async function templateBytes() {
    const res = await fetch("pay-template.xlsx");
    if (!res.ok) throw new Error("pay-template.xlsx");
    return new Uint8Array(await res.arrayBuffer());
  }
  async function buildOne(tpl, data) { return window.PrPay.buildPaymentXlsx(tpl, data); }

  async function makeFiles(keys) {
    const groups = validateGroups(keys); if (!groups) return;
    const st = $("pqStatus");
    try {
      st.textContent = tr("pq.building");
      await ensureJSZip();
      const tpl = await templateBytes();
      const s = signer(); saveSettings(s);
      const outs = [];
      for (const g of groups) {
        const c = cfgFor(g);
        const data = window.PayReq.buildRequestData(g.rows, c, s);
        outs.push({ g, c, data, name: `De-nghi-thanh-toan_${shortName(window.PayReq.vendorLabel(g.rows[0].vendorTax, c.receiver || g.rows[0].vendorName))}_${stamp()}.xlsx`, bytes: await buildOne(tpl, data) });
      }
      // tránh trùng tên file trong zip
      const seen = {}; outs.forEach(o => { seen[o.name] = (seen[o.name] || 0) + 1; if (seen[o.name] > 1) o.name = o.name.replace(".xlsx", `_${seen[o.name]}.xlsx`); });
      if (outs.length === 1) download(outs[0].bytes, outs[0].name, XLSX_TYPE);
      else {
        const zip = new JSZip(); outs.forEach(o => zip.file(o.name, o.bytes));
        download(await zip.generateAsync({ type: "uint8array" }), `De-nghi-thanh-toan_${stamp()}.zip`, "application/zip");
      }
      outs.forEach(o => window.PayReq.learnVendor({ name: o.g.rows[0].vendorName, tax: o.g.rows[0].vendorTax, receiver: o.c.receiver, account: o.c.account, bank: o.c.bank, bankAddress: o.c.bankAddress }));
      const sum = outs.reduce((t, o) => t + groupTotal(o.g), 0);
      let msg = tr("pq.done", { n: outs.length, sum: money(sum) });
      if (canSaveHistory() && $("pqSaveHist").checked) {
        try { await saveHistory(outs, s); msg += tr("pq.doneSaved"); }
        catch (err) { msg += " " + tr("pq.errSave", { err: err.message }); }
      }
      st.textContent = msg;
    } catch (err) {
      st.textContent = "";
      alert(tr("pq.errBuild", { err: err.message }));
    }
  }

  /* ---------- Lịch sử (Firestore pay_requests, chỉ Admin ghi) ---------- */
  async function saveHistory(outs, s) {
    const ts = firebase.firestore.FieldValue.serverTimestamp;
    const batch = db.batch();
    outs.forEach(o => {
      const r0 = o.g.rows[0];
      batch.set(db.collection(HIST_COL).doc(), {
        code: s.code, dateReq: s.dateReq, requester: s.requester, dept: s.dept, head: s.head, chief: s.chief, finance: s.finance,
        vendorName: r0.vendorName, vendorTax: r0.vendorTax, category: r0.category, method: o.c.method || "transfer",
        receiver: o.c.receiver, account: o.c.account, bank: o.c.bank, bankAddress: o.c.bankAddress, from: o.c.from, due: o.c.due, reason: o.c.reason,
        total: groupTotal(o.g),
        docs: o.g.rows.map(r => ({ no: window.PayReq.docNo(r), serial: r.serial || "", date: r.date, ex: r.ex, vat: r.vat, desc: r.desc || "", docType: r.docType })),
        createdBy: (typeof currentEmail !== "undefined" && currentEmail) || "?", createdAt: ts()
      });
    });
    await batch.commit();
  }
  window.initPayReqSync = function () {
    if (unsub || !canReadHistory()) return;
    unsub = db.collection(HIST_COL).orderBy("createdAt", "desc").limit(100).onSnapshot(snap => {
      history = snap.docs.map(d => Object.assign({ _id: d.id }, d.data()));
      renderHistory(); refreshWarnings();
    }, err => console.warn("pay_requests sync:", err));
  };
  window.stopPayReqSync = function () { if (unsub) unsub(); unsub = null; history = []; renderHistory(); };
  window.payReqPageBlocked = name => name === "payReq" && typeof isCollector !== "undefined" && isCollector;
  window.onPayReqPage = name => { if (name === "payReq") window.renderPayReq(); };

  function renderHistory() {
    const wrap = $("pqHistoryWrap"), box = $("pqHistory");
    if (!wrap || !box) return;
    wrap.classList.toggle("hidden", !canReadHistory());
    if (!canReadHistory()) return;
    if (!history.length) { box.innerHTML = `<p class="muted">${esc(tr("pq.h.none"))}</p>`; return; }
    box.innerHTML = history.map(h => `<div class="pq-hist">
      <div><b>${esc(h.code || "?")}</b> · ${esc(fmtDate(h.dateReq))} · ${esc(h.vendorName || "")}</div>
      <div class="muted">${esc(tr("pq.g.docs", { n: (h.docs || []).length }))}: ${esc((h.docs || []).map(d => d.no).join(", "))} · ${esc(money(h.total))} ${h.createdBy ? "· " + esc(tr("pq.h.by", { who: h.createdBy })) : ""}</div>
      <div class="pq-hist-act"><button type="button" class="secondary pq-mini" data-act="redo" data-id="${esc(h._id)}">${esc(tr("pq.h.redo"))}</button>
      ${canSaveHistory() ? `<button type="button" class="ghost pq-mini" data-act="hdel" data-id="${esc(h._id)}">${esc(tr("pq.h.del"))}</button>` : ""}</div></div>`).join("");
  }
  $("pqHistory").addEventListener("click", async e => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const h = history.find(x => x._id === b.getAttribute("data-id")); if (!h) return;
    if (b.getAttribute("data-act") === "hdel") {
      if (!confirm(tr("pq.h.delConfirm", { code: h.code || "?", vendor: h.vendorName || "" }))) return;
      try { await db.collection(HIST_COL).doc(h._id).delete(); } catch (err) { alert(err.message); }
      return;
    }
    try {
      await ensureJSZip();
      const tpl = await templateBytes();
      const data = {
        code: h.code, dateReq: h.dateReq, requester: h.requester, dept: h.dept, head: h.head, chief: h.chief, finance: h.finance,
        reason: h.reason, method: h.method || "transfer", receiver: h.receiver, account: h.account, bank: h.bank, bankAddress: h.bankAddress, from: h.from, due: h.due,
        // số chứng từ đã lưu ở dạng cuối cùng (vd "TBC 07/2026") nên dùng thẳng
        docs: (h.docs || []).map(d => ({ no: d.no, desc: d.docType === "notice" ? "Thông báo cước/ Payment notice" : ("Hóa đơn GTGT/ VAT invoice" + (d.serial ? ` (${d.serial})` : "")), date: d.date, ex: Number(d.ex) || 0, vat: Number(d.vat) || 0 }))
      };
      download(await buildOne(tpl, data), `De-nghi-thanh-toan_${shortName(window.PayReq.vendorLabel(h.vendorTax, h.receiver || h.vendorName))}_${(h.dateReq || todayStr()).replace(/-/g, "")}.xlsx`, XLSX_TYPE);
    } catch (err) { alert(tr("pq.errBuild", { err: err.message })); }
  });
})();
