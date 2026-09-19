/* network-isp.js — Network › Thanh toán cước Internet / viễn thông (VNPT, Viettel...).

   Nạp SAU app.js và printers-payreq.js (dùng lại window.PrPay.buildPaymentXlsx
   để xuất "Giấy đề nghị thanh toán" nhiều dòng chứng từ, và pdf.js/JSZip do
   printers-payreq.js nạp).

   Dữ liệu (Firestore) — 3 collection, xem firestore.rules:
   - net_providers/{autoId} : nhà cung cấp dịch vụ (VNPT, Viettel...) + tài khoản NH nhận tiền.
   - net_lines/{autoId}     : từng đường truyền / dịch vụ (mã KH, số hợp đồng, tên thuê bao...).
   - net_invoices/{autoId}  : hóa đơn / thông báo cước hằng tháng; các lần thanh toán nằm
                              trong mảng `payments`. Công nợ luôn TỰ TÍNH = amount − Σ payments.
   Phân quyền: Admin ghi; Viewer đọc; Collector không thấy phần thanh toán. */
(function () {
  "use strict";

  /* ================= Chuỗi giao diện (VI / EN / ZH) ================= */
  const T = {
    "nw.hub.lines": ["Đường truyền & NCC", "Lines & providers", "线路与供应商"],
    "nw.hub.lines.desc": ["Danh sách đường truyền Internet, mã KH, hợp đồng, NCC", "Internet lines, customer codes, contracts, providers", "互联网线路、客户编号、合同、供应商"],
    "nw.hub.bills": ["Công nợ cước Internet", "Internet bills & payables", "网络费用应付款"],
    "nw.hub.bills.desc": ["Hóa đơn hằng tháng, đã trả, còn nợ, quá hạn", "Monthly bills, paid, outstanding, overdue", "每月账单、已付、未付、逾期"],
    "nw.hub.payreq": ["Đề nghị thanh toán cước", "Payment request", "付款申请"],
    "nw.hub.payreq.desc": ["Tải hóa đơn PDF → xuất Excel trình ký", "Upload PDF bills → export signed-off Excel", "上传PDF账单 → 导出Excel供签字"],
    "nw.hub.title": ["💳 Thanh toán cước Internet", "💳 Internet bill payments", "💳 网络费用付款"],
    "nw.hub.hint": ["Hàng tháng: tải hóa đơn PDF của VNPT/Viettel lên, kiểm tra rồi xuất Excel “Giấy đề nghị thanh toán” để in trình ký.", "Each month: upload the VNPT/Viettel PDF bills, review, then export the “Payment Request” Excel to print for sign-off.", "每月：上传VNPT/Viettel的PDF账单，核对后导出“付款申请”Excel打印签字。"],

    "nw.l.title": ["📡 Đường truyền & NCC", "📡 Lines & providers", "📡 线路与供应商"],
    "nw.l.add": ["＋ Thêm đường truyền", "＋ Add line", "＋ 添加线路"],
    "nw.l.count": ["Số đường truyền", "Lines", "线路数"],
    "nw.l.monthly": ["Cước ước tính/tháng", "Est. monthly fee", "预计月费"],
    "nw.l.none": ["Chưa có đường truyền nào.", "No lines yet.", "暂无线路。"],
    "nw.l.form.create": ["Thêm đường truyền", "Add line", "添加线路"],
    "nw.l.form.edit": ["Sửa đường truyền", "Edit line", "编辑线路"],
    "nw.l.provider": ["Nhà cung cấp*", "Provider*", "供应商*"],
    "nw.l.name": ["Tên đường truyền*", "Line name*", "线路名称*"],
    "nw.l.type": ["Loại dịch vụ", "Service type", "服务类型"],
    "nw.l.custCode": ["Mã khách hàng (VNPT)", "Customer code (VNPT)", "客户编号 (VNPT)"],
    "nw.l.contract": ["Số hợp đồng", "Contract no.", "合同号"],
    "nw.l.account": ["Tên thuê bao / tài khoản (Viettel)", "Subscriber / account (Viettel)", "用户名/账号 (Viettel)"],
    "nw.l.location": ["Vị trí lắp đặt", "Install location", "安装位置"],
    "nw.l.speed": ["Tốc độ / băng thông", "Speed / bandwidth", "速率/带宽"],
    "nw.l.fee": ["Cước ước tính/tháng (VNĐ, gồm VAT)", "Est. monthly fee (VND, incl. VAT)", "预计月费 (VND, 含税)"],
    "nw.l.note": ["Ghi chú", "Note", "备注"],
    "nw.l.save": ["Lưu đường truyền", "Save line", "保存线路"],
    "nw.l.delConfirm": ["Xóa đường truyền “{{name}}”? (Hóa đơn cũ vẫn được giữ.)", "Delete line “{{name}}”? (Existing bills are kept.)", "删除线路“{{name}}”？（已有账单保留。）"],
    "nw.lt.0": ["Internet cáp quang (FTTH)", "Fiber Internet (FTTH)", "光纤上网 (FTTH)"],
    "nw.lt.1": ["Kênh thuê riêng (Leased line)", "Leased line", "专线"],
    "nw.lt.2": ["Điện thoại cố định", "Landline", "固定电话"],
    "nw.lt.3": ["Khác", "Other", "其他"],

    "nw.p.title": ["🏢 Nhà cung cấp dịch vụ", "🏢 Service providers", "🏢 服务供应商"],
    "nw.p.add": ["＋ Thêm NCC", "＋ Add provider", "＋ 添加供应商"],
    "nw.p.form.create": ["Thêm NCC dịch vụ mạng", "Add network provider", "添加网络供应商"],
    "nw.p.form.edit": ["Sửa NCC dịch vụ mạng", "Edit network provider", "编辑网络供应商"],
    "nw.p.name": ["Tên NCC*", "Provider name*", "供应商名称*"],
    "nw.p.tax": ["Mã số thuế", "Tax code", "税号"],
    "nw.p.receiver": ["Đơn vị nhận tiền", "Receiver name", "收款单位"],
    "nw.p.account": ["Số tài khoản", "Bank account", "银行账号"],
    "nw.p.bank": ["Tại ngân hàng", "Bank", "开户银行"],
    "nw.p.bankAddr": ["Địa chỉ ngân hàng", "Bank address", "银行地址"],
    "nw.p.dueDay": ["Hạn thanh toán: ngày … hằng tháng (để trống nếu dùng số ngày)", "Due on day … of month (leave blank to use days below)", "每月付款截止日（留空则按天数）"],
    "nw.p.terms": ["Hoặc số ngày kể từ ngày hóa đơn", "Or days after invoice date", "或发票日起天数"],
    "nw.p.save": ["Lưu NCC", "Save provider", "保存供应商"],
    "nw.p.delConfirm": ["Xóa NCC “{{name}}”?", "Delete provider “{{name}}”?", "删除供应商“{{name}}”？"],
    "nw.p.hasLines": ["NCC này còn đường truyền/hóa đơn, không xóa được.", "This provider still has lines/bills and cannot be deleted.", "该供应商仍有线路/账单，无法删除。"],
    "nw.p.none": ["Chưa có NCC.", "No providers yet.", "暂无供应商。"],
    "nw.seed.btn": ["⬇ Nạp NCC & đường truyền VNPT/Viettel", "⬇ Load VNPT/Viettel providers & lines", "⬇ 载入VNPT/Viettel供应商与线路"],
    "nw.seed.done": ["Đã nạp {{np}} NCC và {{nl}} đường truyền.", "Loaded {{np}} providers and {{nl}} lines.", "已载入 {{np}} 个供应商和 {{nl}} 条线路。"],
    "nw.seed.nothing": ["Đã có đủ dữ liệu, không có gì để nạp thêm.", "Everything is already loaded.", "数据已齐全，无需载入。"],

    "nw.b.title": ["💳 Công nợ cước Internet", "💳 Internet bills & payables", "💳 网络费用应付款"],
    "nw.b.total": ["Tổng còn phải trả", "Total outstanding", "未付总额"],
    "nw.b.overdue": ["Trong đó quá hạn", "Of which overdue", "其中逾期"],
    "nw.b.search": ["Tìm số hóa đơn, NCC, đường truyền...", "Search bill no., provider, line...", "搜索账单号、供应商、线路..."],
    "nw.b.allProviders": ["Tất cả NCC", "All providers", "全部供应商"],
    "nw.b.allStatus": ["Mọi trạng thái", "Any status", "所有状态"],
    "nw.b.none": ["Chưa có hóa đơn nào.", "No bills yet.", "暂无账单。"],
    "nw.b.pay": ["💰 Ghi thanh toán", "💰 Record payment", "💰 记录付款"],
    "nw.b.payAmount": ["Số tiền đã trả (VNĐ):", "Amount paid (VND):", "已付金额 (VND):"],
    "nw.b.payDate": ["Ngày trả (YYYY-MM-DD):", "Payment date (YYYY-MM-DD):", "付款日期 (YYYY-MM-DD):"],
    "nw.b.undo": ["↩ Hủy lần trả cuối", "↩ Undo last payment", "↩ 撤销最后一次付款"],
    "nw.b.delConfirm": ["Xóa hóa đơn {{no}}?", "Delete bill {{no}}?", "删除账单 {{no}}？"],
    "nw.b.remaining": ["còn nợ", "outstanding", "未付"],
    "nw.b.due": ["hạn", "due", "到期"],
    "nw.b.reqDone": ["Đã lập ĐNTT {{date}}", "Request made {{date}}", "已申请 {{date}}"],
    "nw.b.overdueTag": ["Quá hạn", "Overdue", "逾期"],
    "nw.b.doc.invoice": ["Hóa đơn", "Invoice", "发票"],
    "nw.b.doc.notice": ["Thông báo cước", "Payment notice", "费用通知"],
    "nw.b.st.0": ["Chưa thanh toán", "Unpaid", "未付款"],
    "nw.b.st.1": ["Thanh toán một phần", "Partially paid", "部分付款"],
    "nw.b.st.2": ["Đã thanh toán", "Paid", "已付清"],
    "nw.b.byProvider": ["Công nợ theo NCC", "Payables by provider", "按供应商应付款"],
    "nw.b.openReq": ["📝 Lập đề nghị thanh toán", "📝 Make payment request", "📝 制作付款申请"],

    "nw.q.title": ["📝 Đề nghị thanh toán cước", "📝 Payment request", "📝 付款申请"],
    "nw.q.hint": ["Bước 1: chọn các hóa đơn PDF của tháng (VNPT: hóa đơn; Viettel: hóa đơn FTTH + Thông báo cước leased line) → kiểm tra → Lưu vào công nợ. Bước 2: chọn NCC, tick các hóa đơn cần thanh toán → Tạo file Excel (mỗi NCC 1 giấy đề nghị, nhiều dòng chứng từ).", "Step 1: pick this month's PDF bills → review → save to payables. Step 2: pick a provider, tick the bills to pay → create the Excel (one request per provider, many document rows).", "第1步：选择本月PDF账单 → 核对 → 保存到应付款。第2步：选择供应商，勾选要付款的账单 → 生成Excel（每个供应商一份申请，多行凭证）。"],
    "nw.q.pick": ["Chọn các file PDF (chọn được nhiều file)", "Choose PDF files (multiple allowed)", "选择PDF文件（可多选）"],
    "nw.q.addManual": ["✍ Thêm dòng nhập tay", "✍ Add manual row", "✍ 手动添加一行"],
    "nw.q.reading": ["Đang đọc {{n}} file...", "Reading {{n}} files...", "正在读取 {{n}} 个文件..."],
    "nw.q.readDone": ["Đã đọc {{ok}}/{{n}} file. Kiểm tra lại số liệu bên dưới.", "Read {{ok}}/{{n}} files. Please review below.", "已读取 {{ok}}/{{n}} 个文件，请核对下方数据。"],
    "nw.q.unknown": ["Không nhận dạng được file “{{f}}” (không phải hóa đơn VNPT/Viettel dạng chữ).", "Could not recognise “{{f}}” (not a text VNPT/Viettel bill).", "无法识别文件“{{f}}”（不是文字版VNPT/Viettel账单）。"],
    "nw.q.readErr": ["Lỗi đọc file “{{f}}”: {{err}}", "Error reading “{{f}}”: {{err}}", "读取“{{f}}”出错：{{err}}"],
    "nw.q.provider": ["NCC", "Provider", "供应商"],
    "nw.q.line": ["Đường truyền", "Line", "线路"],
    "nw.q.noLine": ["(không gán đường truyền)", "(no line)", "(不指定线路)"],
    "nw.q.docType": ["Loại", "Type", "类型"],
    "nw.q.no": ["Số hóa đơn/chứng từ", "Bill / document no.", "账单/凭证号"],
    "nw.q.date": ["Ngày", "Date", "日期"],
    "nw.q.period": ["Kỳ cước", "Period", "费用期"],
    "nw.q.ex": ["Trước thuế", "Ex VAT", "不含税"],
    "nw.q.vat": ["Thuế GTGT", "VAT", "税额"],
    "nw.q.total": ["Tổng", "Total", "合计"],
    "nw.q.due": ["Hạn thanh toán", "Due date", "付款截止"],
    "nw.q.remove": ["✕ Bỏ", "✕ Remove", "✕ 移除"],
    "nw.q.dupPeriod": ["⚠ Đường truyền này kỳ {{p}} đã có chứng từ khác ({{no}}) — tránh thanh toán 2 lần.", "⚠ This line already has another document for {{p}} ({{no}}) — avoid paying twice.", "⚠ 该线路 {{p}} 已有其他凭证 ({{no}}) — 避免重复付款。"],
    "nw.q.exists": ["ℹ Đã có trong công nợ — sẽ cập nhật.", "ℹ Already in payables — will be updated.", "ℹ 已在应付款中 — 将更新。"],
    "nw.q.noLineMatch": ["⚠ Chưa khớp đường truyền nào (mã KH/hợp đồng mới?) — chọn tay hoặc thêm ở “Đường truyền & NCC”.", "⚠ No matching line (new customer code/contract?) — choose manually or add it under “Lines & providers”.", "⚠ 未匹配到线路（新客户编号/合同？）— 请手动选择或先添加线路。"],
    "nw.q.saveRows": ["💾 Lưu vào công nợ", "💾 Save to payables", "💾 保存到应付款"],
    "nw.q.saved": ["Đã lưu {{n}} chứng từ vào công nợ.", "Saved {{n}} documents to payables.", "已保存 {{n}} 份凭证到应付款。"],
    "nw.q.needFields": ["Mỗi dòng cần: NCC, số chứng từ, ngày và số tiền > 0.", "Each row needs provider, document no., date and amount > 0.", "每行需要：供应商、凭证号、日期及金额 > 0。"],
    "nw.q.step2": ["Bước 2 — Tạo giấy đề nghị thanh toán", "Step 2 — Create the payment request", "第2步 — 生成付款申请"],
    "nw.q.pickBills": ["Chọn hóa đơn đưa vào giấy đề nghị", "Bills to include", "选择纳入申请的账单"],
    "nw.q.noBills": ["NCC này không còn hóa đơn nào chưa thanh toán.", "No unpaid bills for this provider.", "该供应商没有未付账单。"],
    "nw.q.method": ["Hình thức thanh toán", "Payment method", "付款方式"],
    "nw.q.transfer": ["Chuyển khoản", "Bank transfer", "转账"],
    "nw.q.cash": ["Tiền mặt", "Cash", "现金"],
    "nw.q.from": ["Từ ngày", "From", "自"],
    "nw.q.dueAll": ["Hạn chót", "Deadline", "截止"],
    "nw.q.reason": ["Lý do (Content)", "Reason (Content)", "事由 (Content)"],
    "nw.q.code": ["Mã số (Code)", "Code", "编号 (Code)"],
    "nw.q.requester": ["Người đề nghị", "Requester", "申请人"],
    "nw.q.dept": ["Phòng ban", "Department", "部门"],
    "nw.q.head": ["Trưởng bộ phận", "Head of Dept", "部门主管"],
    "nw.q.finance": ["Quản lý tài chính", "Finance manager", "财务经理"],
    "nw.q.selTotal": ["Tổng đã chọn", "Selected total", "已选合计"],
    "nw.q.xlsx": ["📄 Tạo file Excel đề nghị thanh toán", "📄 Create payment-request Excel", "📄 生成付款申请Excel"],
    "nw.q.needSel": ["Hãy tick ít nhất 1 hóa đơn.", "Tick at least one bill.", "请至少勾选一张账单。"],
    "nw.q.noBank": ["NCC chưa có số tài khoản/ngân hàng — vẫn tạo file? (bổ sung ở “Đường truyền & NCC”)", "Provider has no bank account/bank — create anyway? (add it under “Lines & providers”)", "供应商缺少银行账号/银行 — 仍要生成吗？（可在“线路与供应商”补充）"],
    "nw.q.done": ["Đã tạo file Excel ({{n}} chứng từ, {{sum}}).", "Excel created ({{n}} documents, {{sum}}).", "已生成Excel（{{n}} 份凭证，{{sum}}）。"],
    "nw.q.errBuild": ["Không tạo được file Excel: {{err}}", "Could not build Excel: {{err}}", "无法生成Excel：{{err}}"],
    "nw.q.settingsHint": ["Thông tin người ký được nhớ trên máy này cho lần sau.", "Signer details are remembered on this device.", "签字人信息会保存在本设备。"],
    "nw.q.noProviders": ["Chưa có NCC nào — bấm “Nạp NCC & đường truyền VNPT/Viettel” ở trang Đường truyền & NCC.", "No providers yet — use “Load VNPT/Viettel providers & lines” on the Lines & providers page.", "还没有供应商 — 请在“线路与供应商”页点击载入VNPT/Viettel。"],
    "nw.noperm": ["Bạn không có quyền ghi dữ liệu này.", "You do not have permission to write this data.", "您没有写入权限。"],
    "nw.errSave": ["Lỗi lưu: {{err}}", "Save error: {{err}}", "保存出错：{{err}}"]
  };
  ["vi", "en", "zh"].forEach((lang, li) => {
    if (typeof I18N === "undefined" || !I18N[lang]) return;
    Object.keys(T).forEach(k => { I18N[lang][k] = T[k][li]; });
  });

  const LINE_TYPES = ["Internet cáp quang (FTTH)", "Kênh thuê riêng (Leased line)", "Điện thoại cố định", "Khác"];
  const IS = ["Chưa thanh toán", "Thanh toán một phần", "Đã thanh toán"];

  /* ================= Hàm thuần (test được ngoài trình duyệt) ================= */
  const pad = n => String(n).padStart(2, "0");
  const vnd = s => { const d = String(s == null ? "" : s).replace(/[^\d]/g, ""); return d ? parseInt(d, 10) : 0; };
  const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, "");
  function addDaysIso(dateStr, n) { const d = new Date(dateStr + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }

  // Nhận dạng & đọc 3 dạng chứng từ: hóa đơn VNPT, hóa đơn Viettel, Thông báo cước Viettel.
  function parseNetDoc(raw) {
    const t = String(raw || "").normalize("NFC").replace(/[ \t]+/g, " ");
    const g = (re, i) => { const m = re.exec(t); return m ? (m[i === undefined ? 1 : i] || "").trim() : ""; };

    if (/THÔNG BÁO THANH TOÁN/i.test(t) && /VIETTEL/i.test(t)) {
      const range = /Từ \(from\)\s*(\d{2})\/(\d{2})\/(\d{4})\s*Đến \(to\)\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(t);
      const issued = /(\d{2})\/(\d{2})\/(\d{4})\s+([\d,.]+)\s+VND/.exec(t);
      const contract = g(/Số hợp đồng \(Contract\):\s*(\S+)/);
      let total = vnd(g(/Tổng tiền phải thanh toán[^\d\n]*([\d,.]+)/));
      if (!total && issued) total = vnd(issued[4]);
      let ex = 0, vat = 0, desc = "";
      const rowRe = /^\s*\d+\s+([A-Za-z][\w ]*?)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s*$/gm;
      let m;
      while ((m = rowRe.exec(t))) { ex += vnd(m[4]); vat += vnd(m[5]); desc += (desc ? ", " : "") + m[1]; }
      if (!ex && total) { ex = Math.round(total / 1.1); vat = total - ex; }
      if (ex + vat !== total && total) vat = total - ex; // giữ tổng đúng theo thông báo
      const to = range ? { y: range[6], m: range[5] } : issued ? { y: issued[3], m: +issued[2] - 1 || 12 } : null;
      const per = to ? `${to.y}-${pad(to.m)}` : "";
      return {
        kind: "viettel-notice", provider: "viettel", docType: "notice",
        sellerName: "TẬP ĐOÀN CÔNG NGHIỆP - VIỄN THÔNG QUÂN ĐỘI", sellerTax: "",
        serial: "", no: contract ? `TBC-${contract.split("/")[0]}-${per.slice(5)}${per.slice(0, 4)}` : "",
        date: issued ? iso(issued[3], issued[2], issued[1]) : "", period: per,
        from: range ? iso(range[3], range[2], range[1]) : "", to: range ? iso(range[6], range[5], range[4]) : "",
        contractNo: contract, customerCode: "", subscriber: g(/Sub\. No\):\s*(\S+)/),
        ex, vat, rate: ex ? Math.round(vat / ex * 100) : 10, total,
        due: (m = /trước ngày[^:]*:\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(t)) ? iso(m[3], m[2], m[1]) : "",
        desc: desc ? `Cước ${desc} ${per.slice(5)}/${per.slice(0, 4)}` : ""
      };
    }

    if (/\(VAT INVOICE\)|Customer Code/i.test(t) && /Serial/i.test(t)) { // VNPT
      const d = /Ngày \(Date\)\s*(\d{1,2})\s*Tháng \(Month\)\s*(\d{1,2})\s*Năm \(Year\)\s*(\d{4})/.exec(t);
      const per = /Tháng (\d{1,2})\/(\d{4})/.exec(t);
      const custCode = g(/Customer Code\):\s*(\S+)/);
      const sub = g(/Mã TB ĐD:\s*(\S+)/);
      const ex = vnd(g(/Cộng tiền hàng[^:]*:\s*([\d.,]+)/)), vat = vnd(g(/Tiền thuế GTGT[^:]*:\s*([\d.,]+)/));
      const total = vnd(g(/Tổng cộng tiền thanh toán[^:]*:\s*([\d.,]+)/)) || ex + vat;
      return {
        kind: "vnpt", provider: "vnpt", docType: "invoice",
        sellerName: g(/Tên người bán \(Seller\):\s*(.+)/), sellerTax: g(/Mã số thuế \(Tax code\):\s*(\d[\d-]*)/),
        serial: g(/Ký hiệu \(Serial\):\s*(\S+)/), no: g(/Số \(No\.\):\s*(\d+)/),
        date: d ? iso(d[3], d[2], d[1]) : "", period: per ? `${per[2]}-${pad(per[1])}` : "",
        contractNo: "", customerCode: custCode, subscriber: sub,
        ex, vat, rate: +g(/Thuế suất[^:]*:\s*(\d+)\s*%/) || 10, total, due: "",
        desc: g(/^\s*\d+\s+(Cước[^\n]*?)\s+Tháng\s+\d/m) || "Cước dịch vụ viễn thông"
      };
    }

    if (/HÓA ĐƠN DỊCH VỤ VIỄN THÔNG/i.test(t)) { // Viettel
      const d = /Ngày lập:\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(t);
      const per = /Kỳ cước:\s*Tháng\s*(\d{1,2})\/(\d{4})/.exec(t);
      const tot = /CỘNG\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)/.exec(t);
      const ex = tot ? vnd(tot[1]) : 0, vat = tot ? vnd(tot[2]) : 0, total = tot ? vnd(tot[3]) : 0;
      const rowDesc = /^\s*\d+\s+(Dịch vụ[^\d\n]*?)\s+\d/m.exec(t);
      return {
        kind: "viettel-invoice", provider: "viettel", docType: "invoice",
        sellerName: "TẬP ĐOÀN CÔNG NGHIỆP - VIỄN THÔNG QUÂN ĐỘI", sellerTax: g(/Mã số thuế:\s*(\d{10})/),
        serial: g(/Ký hiệu:\s*(\S+)/), no: g(/\(GTGT\)\s*Số:\s*(\d+)/) || g(/Số:\s*(\d{5,})/),
        date: d ? iso(d[3], d[2], d[1]) : "", period: per ? `${per[2]}-${pad(per[1])}` : "",
        contractNo: g(/Số hợp đồng:\s*(\S+)/), customerCode: "", subscriber: g(/Số thuê bao:[^(\n]*\(([^)]+)\)/),
        ex, vat, rate: +g(/\b(\d{1,2})\s*%/) || 10, total, due: "",
        desc: rowDesc ? rowDesc[1].trim() : "Cước dịch vụ viễn thông"
      };
    }
    return null;
  }

  // Khớp chứng từ với đường truyền theo mã KH / số hợp đồng / tên thuê bao.
  function matchLine(p, lines, providerId) {
    const ids = [];
    [p.customerCode, p.contractNo, p.subscriber].filter(Boolean).forEach(x => {
      const v = String(x).toLowerCase(); ids.push(v);
      if (x === p.customerCode) v.split("/").forEach(y => ids.push(y));
    });
    const hit = l => [l.customerCode, l.contractNo, l.account].filter(k => k && String(k).length >= 6).some(k => {
      const kk = String(k).toLowerCase();
      return ids.some(i => i.length >= 6 && (i.includes(kk) || kk.includes(i)));
    });
    const c = lines.filter(l => !providerId || l.providerId === providerId).filter(hit);
    return c.length === 1 ? c[0] : (c[0] || null);
  }

  function matchProvider(p, providers) {
    return providers.find(v => v.taxCode && p.sellerTax && v.taxCode === p.sellerTax)
      || providers.find(v => (v.keys || []).some(k => k && norm(p.provider).includes(norm(k)) || norm(k) === norm(p.provider)))
      || providers.find(v => norm(v.name).includes(norm(p.provider)) || (p.sellerName && norm(v.name).includes(norm(p.sellerName))))
      || null;
  }

  // Hạn thanh toán mặc định của một hóa đơn.
  function dueFor(provider, dateIso) {
    if (!dateIso) return "";
    if (provider && provider.dueDay) {
      const dd = Math.min(28, Math.max(1, Number(provider.dueDay)));
      let y = +dateIso.slice(0, 4), m = +dateIso.slice(5, 7); const day = +dateIso.slice(8, 10);
      if (day > dd) { m++; if (m > 12) { m = 1; y++; } }
      return iso(y, m, dd);
    }
    return addDaysIso(dateIso, provider && provider.paymentTerms != null && provider.paymentTerms !== "" ? Number(provider.paymentTerms) : 15);
  }

  const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function reasonFor(bills) {
    const per = Array.from(new Set(bills.map(b => b.period).filter(Boolean))).sort();
    const vi = per.map(p => `${p.slice(5)}/${p.slice(0, 4)}`).join(", ");
    const en = per.map(p => `${MONTHS_EN[+p.slice(5) - 1]} ${p.slice(0, 4)}`).join(", ");
    return `Thanh toán cước dịch vụ Internet/viễn thông tháng ${vi}\nPayment of internet/telecom service fees for ${en}`;
  }

  // Dữ liệu cho PrPay.buildPaymentXlsx (nhiều dòng chứng từ).
  function buildRequestData(bills, provider, s) {
    const sorted = bills.slice().sort((a, b) => (a.invoiceDate || "").localeCompare(b.invoiceDate || "") || String(a.invoiceNo).localeCompare(String(b.invoiceNo)));
    return {
      code: s.code, dateReq: s.dateReq, requester: s.requester, dept: s.dept, head: s.head, finance: s.finance,
      reason: s.reason || reasonFor(sorted), method: s.method || "transfer",
      receiver: provider ? (provider.receiverName || provider.name) : "", account: provider ? provider.bankAccount || "" : "",
      bank: provider ? provider.bankName || "" : "", bankAddress: provider ? provider.bankAddress || "" : "",
      from: s.from, due: s.due,
      docs: sorted.map(b => ({
        no: b.docType === "notice" && b.period ? `TBC ${b.period.slice(5)}/${b.period.slice(0, 4)}` : b.invoiceNo, date: b.invoiceDate, ex: Number(b.amountExVat) || 0, vat: Number(b.vatAmount) || 0,
        desc: b.docType === "notice" ? "Thông báo cước/ Payment notice" : "Hóa đơn điện tử/ Invoice"
      }))
    };
  }

  const SEED = {
    providers: [
      { key: "vnpt", name: "VNPT Vĩnh Long (Viễn thông Vĩnh Long)", keys: ["vnpt", "vienthongvinhlong"], taxCode: "1500189108", receiverName: "VIỄN THÔNG VĨNH LONG", bankAccount: "7108201002280", bankName: "Ngân Hàng NN&PTNT CN Châu Thành Bến Tre", bankAddress: "", dueDay: 15, paymentTerms: 15 },
      { key: "viettel", name: "Viettel Telecom (Tập đoàn Công nghiệp - Viễn thông Quân đội)", keys: ["viettel"], taxCode: "0100109106", receiverName: "TẬP ĐOÀN CÔNG NGHIỆP - VIỄN THÔNG QUÂN ĐỘI", bankAccount: "1207402221", bankName: "NH TMCP Đầu tư và Phát triển VN - Sở Giao Dịch 1", bankAddress: "", dueDay: 15, paymentTerms: 15 }
    ],
    lines: [
      { p: "vnpt", name: "VNPT 0886153848 (Tuyến 5-000)", type: LINE_TYPES[3], customerCode: "BTE-00-1422345", contractNo: "", account: "0886153848", monthlyFee: 170999 },
      { p: "vnpt", name: "VNPT kênh thuê riêng LL001089326", type: LINE_TYPES[1], customerCode: "BTE-00-1440833", contractNo: "", account: "LL001089326", monthlyFee: 1500000 },
      { p: "vnpt", name: "VNPT Fiber KCN Giao Long", type: LINE_TYPES[0], customerCode: "BTE-00-1423055", contractNo: "", account: "fiber_ctyxtxanhsec_kcnglg", monthlyFee: 1760000 },
      { p: "vnpt", name: "VNPT điện thoại cố định 02753620555", type: LINE_TYPES[2], customerCode: "BTE-00-1449073", contractNo: "", account: "02753620555", monthlyFee: 44000 },
      { p: "viettel", name: "Viettel FTTH", type: LINE_TYPES[0], customerCode: "", contractNo: "644578723/HKD_BTE_CTH_NHANDP/27032025", account: "b075_gftth_seccttcnstx0", monthlyFee: 800000 },
      { p: "viettel", name: "Viettel Leased Line", type: LINE_TYPES[1], customerCode: "", contractNo: "648664490/KHDN_AM_VLG/09102025", account: "vlg_gll_seccttcnstx", monthlyFee: 20900000 }
    ]
  };

  window.NetIsp = { parseNetDoc, matchLine, matchProvider, dueFor, reasonFor, buildRequestData, vnd, SEED, LINE_TYPES };

  /* ================= UI ================= */
  const $ = id => document.getElementById(id);
  if (!$("nwPqFile")) return; // (harness/test không có trang này)

  const PAGES = ["netLines", "netLineForm", "netProviderForm", "netBills", "netPayReq"];
  const P_COL = "net_providers", L_COL = "net_lines", B_COL = "net_invoices";
  let providers = [], lines = [], bills = [], unsubs = [];
  let rows = [];          // các dòng chứng từ đang kiểm tra (chưa lưu)
  const esc = s => escapeHtml(s);
  const canSee = () => !!(isAdmin || isViewer);
  const money = n => (Number(n) || 0).toLocaleString("vi-VN") + " ₫";
  const todayStr = () => { const d = new Date(); return iso(d.getFullYear(), d.getMonth() + 1, d.getDate()); };
  const fmtDate = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || ""); };
  const provById = id => providers.find(p => p._id === id);
  const lineById = id => lines.find(l => l._id === id);
  const paid = b => (b.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const remaining = b => Math.max(0, (Number(b.amount) || 0) - paid(b));
  const statusOf = b => (Number(b.amount) > 0 && remaining(b) <= 0) ? IS[2] : paid(b) > 0 ? IS[1] : IS[0];
  const isOverdue = b => remaining(b) > 0 && !!b.dueDate && b.dueDate < todayStr();
  const lineTypeLabel = v => { const i = LINE_TYPES.indexOf(v); return i >= 0 ? tr("nw.lt." + i) : (v || ""); };
  const loadSettings = () => { const D = { code: "ACC-001", requester: "BÙI KHÁNH NGUYÊN", dept: "IT", head: "Lê Nhật Thành", finance: "Chen Lai Chong – John" }; try { return Object.assign(D, JSON.parse(localStorage.getItem("prPayReqSettings") || "{}")); } catch (e) { return D; } };
  const saveSettings = s => { try { const old = JSON.parse(localStorage.getItem("prPayReqSettings") || "{}"); localStorage.setItem("prPayReqSettings", JSON.stringify(Object.assign(old, s))); } catch (e) { /* bỏ qua */ } };

  /* ---------- Đồng bộ ---------- */
  window.initNetSync = function () {
    if (unsubs.length || !canSee()) return;
    const listen = (col, set) => db.collection(col).onSnapshot(snap => {
      set(snap.docs.map(d => Object.assign({ _id: d.id }, d.data())));
      window.renderNetAll();
    }, err => console.error("Net sync error (" + col + "):", err));
    unsubs = [listen(P_COL, a => { providers = a; }), listen(L_COL, a => { lines = a; }), listen(B_COL, a => { bills = a; })];
  };
  window.stopNetSync = function () { unsubs.forEach(u => u()); unsubs = []; providers = []; lines = []; bills = []; };
  window.netPageBlocked = name => PAGES.indexOf(name) !== -1 && !canSee();
  window.onNetPage = function (name) { if (PAGES.indexOf(name) !== -1) window.renderNetAll(); };
  window.renderNetAll = function () {
    if (!canSee()) return;
    renderLines(); renderBills(); renderPq();
  };
  const optHtml = (items, sel) => items.map(it => `<option value="${esc(it.v)}"${it.v === sel ? " selected" : ""}>${esc(it.l)}</option>`).join("");
  const provItems = () => providers.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "", "vi")).map(p => ({ v: p._id, l: p.name }));

  /* ---------- Đường truyền & NCC ---------- */
  function renderLines() {
    const act = lines.reduce((s, l) => s + (Number(l.monthlyFee) || 0), 0);
    $("nwLStatCount").textContent = lines.length; $("nwLStatFee").textContent = money(act);
    const bp = providers.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "", "vi"));
    $("nwSeedBtn").classList.toggle("hidden", !isAdmin);
    let html = "";
    bp.forEach(p => {
      const ls = lines.filter(l => l.providerId === p._id).sort((a, b) => (a.name || "").localeCompare(b.name || "", "vi"));
      html += `<div class="card"><h3>🏢 ${esc(p.name)}</h3>
        <div class="muted">${esc([p.taxCode ? "MST " + p.taxCode : "", p.bankAccount ? p.bankAccount + " · " + (p.bankName || "") : ""].filter(Boolean).join(" · "))}</div>
        ${isAdmin ? `<div class="quick" style="margin:8px 0"><button class="secondary" onclick="nwOpenProvider('${p._id}')">✎ ${tr("action.edit")}</button><button class="secondary" onclick="nwDeleteProvider('${p._id}')">🗑 ${tr("action.delete")}</button></div>` : ""}
        ${ls.length ? ls.map(l => `<div class="asset"><div><h3>${esc(l.name)}</h3>
          <div class="muted">${esc(lineTypeLabel(l.type))}${l.speed ? " · " + esc(l.speed) : ""}${l.location ? " · " + esc(l.location) : ""}</div>
          <div class="muted">${esc([l.customerCode, l.contractNo, l.account].filter(Boolean).join(" · "))}</div>
          ${l.monthlyFee ? `<span class="badge info">${money(l.monthlyFee)}/${tr("nw.q.period").toLowerCase()}</span>` : ""}</div>
          <div class="asset-actions"><button onclick="nwOpenLine('${l._id}')">${isAdmin ? "✎ " + tr("action.edit") : "👁 " + tr("action.view")}</button>
          ${isAdmin ? `<button class="secondary" onclick="nwDeleteLine('${l._id}')">🗑</button>` : ""}</div></div>`).join("") : `<p class="muted">${tr("nw.l.none")}</p>`}
      </div>`;
    });
    const orphan = lines.filter(l => !provById(l.providerId));
    if (orphan.length) html += `<div class="card">${orphan.map(l => `<div class="asset"><div><h3>${esc(l.name)}</h3></div><div class="asset-actions"><button onclick="nwOpenLine('${l._id}')">✎</button></div></div>`).join("")}</div>`;
    $("nwLineList").innerHTML = html || `<div class="card empty"><p>${tr("nw.p.none")}</p></div>`;
  }

  window.nwOpenLine = function (id) {
    const l = id ? lineById(id) : null;
    $("nwLineDocId").value = id || "";
    $("nwLineFormTitle").textContent = tr(l ? "nw.l.form.edit" : "nw.l.form.create");
    $("nwLineProvider").innerHTML = optHtml(provItems(), l ? l.providerId : "");
    $("nwLineType").innerHTML = optHtml(LINE_TYPES.map((t, i) => ({ v: t, l: tr("nw.lt." + i) })), l ? l.type : LINE_TYPES[0]);
    [["Name", "name"], ["CustCode", "customerCode"], ["Contract", "contractNo"], ["Account", "account"], ["Location", "location"], ["Speed", "speed"], ["Fee", "monthlyFee"], ["Note", "note"]]
      .forEach(([a, f]) => { $("nwLine" + a).value = l && l[f] != null ? l[f] : ""; });
    goPage("netLineForm");
  };
  window.nwDeleteLine = async function (id) {
    if (!isAdmin) return alert(tr("nw.noperm"));
    const l = lineById(id); if (!l || !confirm(tr("nw.l.delConfirm", { name: l.name }))) return;
    try { await db.collection(L_COL).doc(id).delete(); } catch (e) { alert(tr("nw.errSave", { err: e.message })); }
  };
  $("nwLineFormEl").addEventListener("submit", async ev => {
    ev.preventDefault();
    if (!isAdmin) return alert(tr("nw.noperm"));
    const name = $("nwLineName").value.trim(), pid = $("nwLineProvider").value;
    if (!name || !pid) return alert(tr("nw.q.needFields"));
    const id = $("nwLineDocId").value, ts = firebase.firestore.FieldValue.serverTimestamp;
    const data = { providerId: pid, name, type: $("nwLineType").value, customerCode: $("nwLineCustCode").value.trim(), contractNo: $("nwLineContract").value.trim(),
      account: $("nwLineAccount").value.trim(), location: $("nwLineLocation").value.trim(), speed: $("nwLineSpeed").value.trim(),
      monthlyFee: Number($("nwLineFee").value) || 0, note: $("nwLineNote").value.trim(), updatedAt: ts() };
    try {
      const ref = id ? db.collection(L_COL).doc(id) : db.collection(L_COL).doc();
      if (!id) data.createdAt = ts();
      await ref.set(data, { merge: true });
      goPage("netLines");
    } catch (e) { alert(tr("nw.errSave", { err: e.message })); }
  });
  $("nwLineAddBtn").addEventListener("click", () => window.nwOpenLine(""));

  window.nwOpenProvider = function (id) {
    const p = id ? provById(id) : null;
    $("nwProvDocId").value = id || "";
    $("nwProvFormTitle").textContent = tr(p ? "nw.p.form.edit" : "nw.p.form.create");
    [["Name", "name"], ["Tax", "taxCode"], ["Receiver", "receiverName"], ["Account", "bankAccount"], ["Bank", "bankName"], ["BankAddr", "bankAddress"], ["DueDay", "dueDay"], ["Terms", "paymentTerms"]]
      .forEach(([a, f]) => { $("nwProv" + a).value = p && p[f] != null ? p[f] : ""; });
    goPage("netProviderForm");
  };
  window.nwDeleteProvider = async function (id) {
    if (!isAdmin) return alert(tr("nw.noperm"));
    const p = provById(id); if (!p) return;
    if (lines.some(l => l.providerId === id) || bills.some(b => b.providerId === id)) return alert(tr("nw.p.hasLines"));
    if (!confirm(tr("nw.p.delConfirm", { name: p.name }))) return;
    try { await db.collection(P_COL).doc(id).delete(); } catch (e) { alert(tr("nw.errSave", { err: e.message })); }
  };
  $("nwProvFormEl").addEventListener("submit", async ev => {
    ev.preventDefault();
    if (!isAdmin) return alert(tr("nw.noperm"));
    const name = $("nwProvName").value.trim(); if (!name) return alert(tr("nw.q.needFields"));
    const id = $("nwProvDocId").value, ts = firebase.firestore.FieldValue.serverTimestamp, old = id ? provById(id) : null;
    const data = { name, taxCode: $("nwProvTax").value.trim(), receiverName: $("nwProvReceiver").value.trim() || name, bankAccount: $("nwProvAccount").value.trim(),
      bankName: $("nwProvBank").value.trim(), bankAddress: $("nwProvBankAddr").value.trim(),
      dueDay: $("nwProvDueDay").value === "" ? "" : Number($("nwProvDueDay").value), paymentTerms: $("nwProvTerms").value === "" ? 15 : Number($("nwProvTerms").value),
      keys: old && old.keys ? old.keys : [], updatedAt: ts() };
    try {
      const ref = id ? db.collection(P_COL).doc(id) : db.collection(P_COL).doc();
      if (!id) data.createdAt = ts();
      await ref.set(data, { merge: true });
      goPage("netLines");
    } catch (e) { alert(tr("nw.errSave", { err: e.message })); }
  });
  $("nwProvAddBtn").addEventListener("click", () => window.nwOpenProvider(""));

  $("nwSeedBtn").addEventListener("click", async () => {
    if (!isAdmin) return alert(tr("nw.noperm"));
    const ts = firebase.firestore.FieldValue.serverTimestamp, batch = db.batch();
    const idOf = {}; let np = 0, nl = 0;
    SEED.providers.forEach(sp => {
      const ex = providers.find(p => (p.taxCode && p.taxCode === sp.taxCode) || (p.keys || []).indexOf(sp.key) !== -1);
      if (ex) { idOf[sp.key] = ex._id; return; }
      const ref = db.collection(P_COL).doc(); idOf[sp.key] = ref.id; np++;
      const d = Object.assign({}, sp); delete d.key; d.createdAt = ts(); d.updatedAt = ts();
      batch.set(ref, d);
    });
    SEED.lines.forEach(sl => {
      const pid = idOf[sl.p];
      const dup = lines.some(l => l.providerId === pid && ((sl.customerCode && l.customerCode === sl.customerCode) || (sl.contractNo && l.contractNo === sl.contractNo) || (sl.account && l.account === sl.account)));
      if (dup) return;
      const d = Object.assign({}, sl); delete d.p; d.providerId = pid; d.location = ""; d.speed = ""; d.note = ""; d.createdAt = ts(); d.updatedAt = ts();
      batch.set(db.collection(L_COL).doc(), d); nl++;
    });
    if (!np && !nl) return alert(tr("nw.seed.nothing"));
    try { await batch.commit(); alert(tr("nw.seed.done", { np, nl })); } catch (e) { alert(tr("nw.errSave", { err: e.message })); }
  });

  /* ---------- Công nợ / hóa đơn ---------- */
  function renderBills() {
    const f = norm($("nwBSearch").value), pf = $("nwBProv").value, sf = $("nwBStatus").value;
    const keepP = pf, keepS = sf;
    $("nwBProv").innerHTML = `<option value="">${esc(tr("nw.b.allProviders"))}</option>` + optHtml(provItems(), keepP);
    $("nwBStatus").innerHTML = `<option value="">${esc(tr("nw.b.allStatus"))}</option>` + IS.map((s, i) => `<option value="${esc(s)}"${s === keepS ? " selected" : ""}>${esc(tr("nw.b.st." + i))}</option>`).join("");
    const debt = bills.reduce((s, b) => s + remaining(b), 0), over = bills.filter(isOverdue).reduce((s, b) => s + remaining(b), 0);
    $("nwBDebt").textContent = money(debt); $("nwBOver").textContent = money(over);
    $("nwBByProv").innerHTML = providers.map(p => { const d = bills.filter(b => b.providerId === p._id).reduce((s, b) => s + remaining(b), 0); return `<div class="asset"><div><h3>${esc(p.name)}</h3></div><b>${money(d)}</b></div>`; }).join("") || `<p class="muted">${tr("nw.p.none")}</p>`;
    const list = bills.filter(b => (!pf || b.providerId === pf) && (!sf || statusOf(b) === sf)
      && (!f || norm([b.invoiceNo, b.providerName, b.lineName, b.period, b.desc].join(" ")).includes(f)))
      .sort((a, b) => (b.invoiceDate || "").localeCompare(a.invoiceDate || "") || String(b.invoiceNo).localeCompare(String(a.invoiceNo)));
    $("nwBList").innerHTML = list.map(b => {
      const st = statusOf(b), cls = st === IS[2] ? "ok" : st === IS[1] ? "warn" : "bad";
      const prov = provById(b.providerId);
      return `<div class="asset"><div><h3>${esc(b.invoiceNo)} · ${esc(prov ? prov.name.split(" (")[0] : b.providerName)}</h3>
        <div class="muted">${esc(b.lineName || "")}${b.lineName ? " · " : ""}${tr("nw.b.doc." + (b.docType === "notice" ? "notice" : "invoice"))} · ${esc(b.period ? b.period.slice(5) + "/" + b.period.slice(0, 4) : "")} · ${fmtDate(b.invoiceDate)}</div>
        <div><b>${money(b.amount)}</b> · ${tr("nw.b.remaining")} <b>${money(remaining(b))}</b> · ${tr("nw.b.due")} ${fmtDate(b.dueDate)}</div>
        <span class="badge ${cls}">${esc(tr("nw.b.st." + IS.indexOf(st)))}</span>${isOverdue(b) ? ` <span class="badge bad">${tr("nw.b.overdueTag")}</span>` : ""}${b.payReqDate ? ` <span class="badge info">${tr("nw.b.reqDone", { date: fmtDate(b.payReqDate) })}</span>` : ""}</div>
        ${isAdmin ? `<div class="asset-actions">${remaining(b) > 0 ? `<button onclick="nwPay('${b._id}')">${tr("nw.b.pay")}</button>` : ""}${(b.payments || []).length ? `<button class="secondary" onclick="nwUndoPay('${b._id}')">${tr("nw.b.undo")}</button>` : ""}<button class="secondary" onclick="nwDeleteBill('${b._id}')">🗑</button></div>` : ""}</div>`;
    }).join("") || `<div class="card empty"><p>${tr("nw.b.none")}</p></div>`;
  }
  ["nwBSearch", "nwBProv", "nwBStatus"].forEach(id => $(id).addEventListener("input", renderBills));
  window.nwPay = async function (id) {
    if (!isAdmin) return alert(tr("nw.noperm"));
    const b = bills.find(x => x._id === id); if (!b) return;
    const a = prompt(tr("nw.b.payAmount"), String(remaining(b))); if (a === null) return;
    const amount = Math.round(Number(String(a).replace(/[^\d.]/g, ""))); if (!amount) return;
    const d = prompt(tr("nw.b.payDate"), todayStr()); if (d === null) return;
    try {
      await db.collection(B_COL).doc(id).set({ payments: (b.payments || []).concat([{ date: /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : todayStr(), amount, note: "", by: currentEmail || "" }]), updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    } catch (e) { alert(tr("nw.errSave", { err: e.message })); }
  };
  window.nwUndoPay = async function (id) {
    if (!isAdmin) return alert(tr("nw.noperm"));
    const b = bills.find(x => x._id === id); if (!b || !(b.payments || []).length) return;
    try { await db.collection(B_COL).doc(id).set({ payments: b.payments.slice(0, -1), updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }); } catch (e) { alert(tr("nw.errSave", { err: e.message })); }
  };
  window.nwDeleteBill = async function (id) {
    if (!isAdmin) return alert(tr("nw.noperm"));
    const b = bills.find(x => x._id === id); if (!b || !confirm(tr("nw.b.delConfirm", { no: b.invoiceNo }))) return;
    try { await db.collection(B_COL).doc(id).delete(); } catch (e) { alert(tr("nw.errSave", { err: e.message })); }
  };

  /* ---------- Đề nghị thanh toán ---------- */
  let pdfDone = null;
  async function ensurePdfJs() {
    if (window.pdfjsLib) return window.pdfjsLib;
    await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"; s.onload = res; s.onerror = () => rej(new Error("pdf.js")); document.head.appendChild(s); });
    try {
      const code = await (await fetch("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js")).text();
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    } catch (e) { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; }
    return window.pdfjsLib;
  }
  async function ensureJSZip() {
    if (window.JSZip) return;
    await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"; s.onload = res; s.onerror = () => rej(new Error("jszip")); document.head.appendChild(s); });
  }
  async function pdfToText(file) {
    const lib = await ensurePdfJs();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let i = 1; i <= Math.min(doc.numPages, 3); i++) pages.push((await (await doc.getPage(i)).getTextContent()).items);
    return window.PrPay.itemsToText(pages);
  }

  function rowFromParsed(p, file) {
    const prov = matchProvider(p, providers);
    const line = matchLine(p, lines, prov ? prov._id : "");
    return { file, providerId: prov ? prov._id : (line ? line.providerId : ""), lineId: line ? line._id : "", docType: p.docType, no: p.no, serial: p.serial || "", date: p.date, period: p.period,
      ex: p.ex, vat: p.vat, rate: p.rate, due: p.due || dueFor(prov, p.date), desc: p.desc || "", src: "pdf" };
  }
  const rowTotal = r => (Number(r.ex) || 0) + (Number(r.vat) || 0);

  $("nwPqFile").addEventListener("change", async ev => {
    const files = Array.from(ev.target.files || []); if (!files.length) return;
    if (!providers.length) alert(tr("nw.q.noProviders"));
    $("nwPqStatus").textContent = tr("nw.q.reading", { n: files.length });
    let ok = 0; const msgs = [];
    for (const f of files) {
      try {
        const p = window.NetIsp.parseNetDoc(await pdfToText(f));
        if (!p || !p.no) { msgs.push(tr("nw.q.unknown", { f: f.name })); continue; }
        rows.push(rowFromParsed(p, f.name)); ok++;
      } catch (e) { msgs.push(tr("nw.q.readErr", { f: f.name, err: e.message })); }
    }
    ev.target.value = "";
    $("nwPqStatus").innerHTML = esc(tr("nw.q.readDone", { ok, n: files.length })) + msgs.map(m => `<div class="pr-alert warn">${esc(m)}</div>`).join("");
    renderReview();
  });
  $("nwPqManualBtn").addEventListener("click", () => {
    const prov = providers[0], d = todayStr();
    rows.push({ file: "", providerId: prov ? prov._id : "", lineId: "", docType: "invoice", no: "", serial: "", date: d, period: d.slice(0, 7), ex: 0, vat: 0, rate: 10, due: dueFor(prov, d), desc: "", src: "manual" });
    renderReview();
  });

  function rowWarn(r) {
    const w = [];
    if (r.lineId && r.period) {
      const dup = bills.find(b => b.lineId === r.lineId && b.period === r.period && (b.invoiceNo || "") !== r.no && b.providerId === r.providerId);
      if (dup) w.push(tr("nw.q.dupPeriod", { p: r.period.slice(5) + "/" + r.period.slice(0, 4), no: dup.invoiceNo }));
    }
    if (!r.lineId && r.src === "pdf") w.push(tr("nw.q.noLineMatch"));
    if (r.providerId && r.no && bills.some(b => b.providerId === r.providerId && (b.invoiceNo || "") === r.no)) w.push(tr("nw.q.exists"));
    return w;
  }
  function renderReview() {
    $("nwPqReviewWrap").classList.toggle("hidden", !rows.length);
    $("nwPqReview").innerHTML = rows.map((r, i) => {
      const lineOpts = `<option value="">${esc(tr("nw.q.noLine"))}</option>` + optHtml(lines.filter(l => !r.providerId || l.providerId === r.providerId).map(l => ({ v: l._id, l: l.name })), r.lineId);
      const inp = (f, type, extra) => `<input data-i="${i}" data-f="${f}" type="${type}" value="${esc(r[f] == null ? "" : r[f])}" ${extra || ""}>`;
      return `<div class="card"><div class="muted">${esc(r.file || "✍")}</div>
        <div>${rowWarn(r).map(w => `<div class="pr-alert warn">${esc(w)}</div>`).join("")}</div>
        <label><span>${tr("nw.q.provider")}</span><select data-i="${i}" data-f="providerId">${optHtml(provItems(), r.providerId)}<option value=""${r.providerId ? "" : " selected"}>—</option></select></label>
        <label><span>${tr("nw.q.line")}</span><select data-i="${i}" data-f="lineId">${lineOpts}</select></label>
        <label><span>${tr("nw.q.docType")}</span><select data-i="${i}" data-f="docType"><option value="invoice"${r.docType === "invoice" ? " selected" : ""}>${tr("nw.b.doc.invoice")}</option><option value="notice"${r.docType === "notice" ? " selected" : ""}>${tr("nw.b.doc.notice")}</option></select></label>
        <label><span>${tr("nw.q.no")}</span>${inp("no", "text")}</label>
        <div class="filter-dates"><label class="filter-date"><span>${tr("nw.q.date")}</span>${inp("date", "date")}</label><label class="filter-date"><span>${tr("nw.q.due")}</span>${inp("due", "date")}</label></div>
        <label style="margin-top:11px"><span>${tr("nw.q.period")}</span>${inp("period", "month")}</label>
        <div class="filter-dates"><label class="filter-date"><span>${tr("nw.q.ex")}</span>${inp("ex", "number", 'min="0" step="1"')}</label><label class="filter-date"><span>${tr("nw.q.vat")}</span>${inp("vat", "number", 'min="0" step="1"')}</label></div>
        <div style="margin:8px 0"><b>${tr("nw.q.total")}: <span id="nwRowTot${i}">${money(rowTotal(r))}</span></b></div>
        <button type="button" class="secondary" data-rm="${i}">${tr("nw.q.remove")}</button></div>`;
    }).join("");
  }
  $("nwPqReview").addEventListener("input", ev => {
    const el = ev.target, i = el.dataset.i, f = el.dataset.f; if (i === undefined || !f) return;
    const r = rows[+i]; r[f] = (f === "ex" || f === "vat") ? (Number(el.value) || 0) : el.value;
    if (f === "ex" || f === "vat") { const t = $("nwRowTot" + i); if (t) t.textContent = money(rowTotal(r)); }
  });
  $("nwPqReview").addEventListener("change", ev => {
    const el = ev.target, i = el.dataset.i, f = el.dataset.f; if (i === undefined || !f) return;
    const r = rows[+i];
    if (f === "providerId") { r.lineId = ""; const p = provById(r.providerId); if (p && r.date) r.due = dueFor(p, r.date); renderReview(); }
    else if (f === "lineId" || f === "no") renderReview();
    else if (f === "date") { const p = provById(r.providerId); if (p && r.docType === "invoice") r.due = dueFor(p, r.date); renderReview(); }
  });
  $("nwPqReview").addEventListener("click", ev => {
    const b = ev.target.closest("[data-rm]"); if (!b) return;
    rows.splice(+b.dataset.rm, 1); renderReview();
  });

  $("nwPqSaveRows").addEventListener("click", async () => {
    if (!isAdmin) return alert(tr("nw.noperm"));
    if (!rows.length) return;
    if (rows.some(r => !r.providerId || !r.no.trim() || !r.date || rowTotal(r) <= 0)) return alert(tr("nw.q.needFields"));
    const ts = firebase.firestore.FieldValue.serverTimestamp, batch = db.batch();
    rows.forEach(r => {
      const prov = provById(r.providerId), line = r.lineId ? lineById(r.lineId) : null;
      const ex = bills.find(b => b.providerId === r.providerId && (b.invoiceNo || "") === r.no.trim());
      const ref = ex ? db.collection(B_COL).doc(ex._id) : db.collection(B_COL).doc();
      const data = { providerId: r.providerId, providerName: prov ? prov.name : "", lineId: line ? line._id : "", lineName: line ? line.name : "", docType: r.docType,
        invoiceNo: r.no.trim(), invoiceSerial: r.serial || "", invoiceDate: r.date, period: r.period || r.date.slice(0, 7), dueDate: r.due || dueFor(prov, r.date),
        amount: rowTotal(r), amountExVat: Number(r.ex) || 0, vatRate: Number(r.rate) || 0, vatAmount: Number(r.vat) || 0, desc: r.desc || "", updatedAt: ts() };
      if (!ex) Object.assign(data, { payments: [], source: r.src, createdBy: currentEmail || "?", createdAt: ts() });
      batch.set(ref, data, { merge: true });
    });
    try {
      const n = rows.length; await batch.commit(); rows = []; renderReview();
      $("nwPqStatus").textContent = tr("nw.q.saved", { n });
    } catch (e) { alert(tr("nw.errSave", { err: e.message })); }
  });

  function pendingBills(pid) {
    return bills.filter(b => b.providerId === pid && remaining(b) > 0)
      .sort((a, b) => (a.invoiceDate || "").localeCompare(b.invoiceDate || "") || String(a.invoiceNo).localeCompare(String(b.invoiceNo)));
  }
  function renderPq() {
    if (!$("nwPqProv")) return;
    const keep = $("nwPqProv").value;
    $("nwPqNoProv").classList.toggle("hidden", providers.length > 0);
    $("nwPqProv").innerHTML = optHtml(provItems(), keep);
    if (!$("nwPqProv").value && providers.length) $("nwPqProv").value = provItems()[0].v;
    renderPending();
    if (!$("nwPqRequester").value) { const s = loadSettings(); $("nwPqCode").value = s.code; $("nwPqRequester").value = s.requester; $("nwPqDept").value = s.dept; $("nwPqHead").value = s.head; $("nwPqFinance").value = s.finance; }
    const keepM = $("nwPqMethod").value || "transfer";
    $("nwPqMethod").innerHTML = `<option value="transfer">${esc(tr("nw.q.transfer"))}</option><option value="cash">${esc(tr("nw.q.cash"))}</option>`;
    $("nwPqMethod").value = keepM;
    if (!$("nwPqFrom").value) $("nwPqFrom").value = todayStr();
    if ($("nwPqReviewWrap") && rows.length) { /* giữ nguyên các ô đang sửa */ }
  }
  let checked = {}; // id hóa đơn -> true/false (nhớ lựa chọn khi render lại)
  function renderPending() {
    const pid = $("nwPqProv").value, list = pid ? pendingBills(pid) : [];
    list.forEach(b => { if (checked[b._id] === undefined) checked[b._id] = !b.payReqDate; });
    $("nwPqPending").innerHTML = list.map(b => `<label class="checkbox-inline" style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" style="width:auto;margin-top:4px" data-bid="${b._id}"${checked[b._id] ? " checked" : ""}>
      <span><b>${esc(b.invoiceNo)}</b> · ${esc(b.lineName || "")} · ${esc(b.period ? b.period.slice(5) + "/" + b.period.slice(0, 4) : "")}<br><span class="muted">${money(remaining(b))} · ${tr("nw.b.due")} ${fmtDate(b.dueDate)}${b.payReqDate ? " · " + tr("nw.b.reqDone", { date: fmtDate(b.payReqDate) }) : ""}</span></span></label>`).join("") || `<p class="muted">${tr("nw.q.noBills")}</p>`;
    recomputeSel();
  }
  function selectedBills() { return pendingBills($("nwPqProv").value).filter(b => checked[b._id]); }
  function recomputeSel() {
    const sel = selectedBills();
    $("nwPqSelTotal").textContent = money(sel.reduce((s, b) => s + remaining(b), 0));
    const due = sel.map(b => b.dueDate).filter(Boolean).sort()[0] || "";
    if (due && !$("nwPqDue").dataset.touched) $("nwPqDue").value = due;
    if (!$("nwPqReason").dataset.touched) $("nwPqReason").value = sel.length ? reasonFor(sel) : "";
  }
  $("nwPqProv").addEventListener("change", () => { $("nwPqDue").dataset.touched = ""; $("nwPqReason").dataset.touched = ""; renderPending(); });
  $("nwPqPending").addEventListener("change", ev => {
    const id = ev.target.dataset.bid; if (!id) return;
    checked[id] = ev.target.checked; recomputeSel();
  });
  $("nwPqDue").addEventListener("input", () => { $("nwPqDue").dataset.touched = "1"; });
  $("nwPqReason").addEventListener("input", () => { $("nwPqReason").dataset.touched = "1"; });

  $("nwPqXlsxBtn").addEventListener("click", async () => {
    if (!isAdmin) return alert(tr("nw.noperm"));
    const prov = provById($("nwPqProv").value), sel = selectedBills();
    if (!prov || !sel.length) return alert(tr("nw.q.needSel"));
    if ((!prov.bankAccount || !prov.bankName) && $("nwPqMethod").value === "transfer" && !confirm(tr("nw.q.noBank"))) return;
    try {
      await ensureJSZip();
      const res = await fetch("pay-template.xlsx"); if (!res.ok) throw new Error("pay-template.xlsx");
      const tpl = new Uint8Array(await res.arrayBuffer());
      const s = { code: $("nwPqCode").value.trim() || "ACC-001", requester: $("nwPqRequester").value.trim(), dept: $("nwPqDept").value.trim(), head: $("nwPqHead").value.trim(), finance: $("nwPqFinance").value.trim(),
        dateReq: todayStr(), method: $("nwPqMethod").value, from: $("nwPqFrom").value || todayStr(), due: $("nwPqDue").value, reason: $("nwPqReason").value.trim() };
      saveSettings({ code: s.code, requester: s.requester, dept: s.dept, head: s.head, finance: s.finance });
      const bytes = await window.PrPay.buildPaymentXlsx(tpl, buildRequestData(sel, prov, s));
      const ts = firebase.firestore.FieldValue.serverTimestamp, batch = db.batch();
      sel.forEach(b => batch.set(db.collection(B_COL).doc(b._id), { payReqDate: todayStr(), payReqMethod: s.method, updatedAt: ts() }, { merge: true }));
      await batch.commit();
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const a = document.createElement("a");
      const per = Array.from(new Set(sel.map(b => b.period))).sort().pop() || "";
      a.href = URL.createObjectURL(blob); a.download = `De-nghi-thanh-toan_${norm(prov.name.split(" (")[0]).toUpperCase()}_${per.replace("-", "")}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      $("nwPqStatus").textContent = tr("nw.q.done", { n: sel.length, sum: money(sel.reduce((t, b) => t + (Number(b.amount) || 0), 0)) });
    } catch (e) { alert(tr("nw.q.errBuild", { err: e.message })); }
  });
  $("nwBOpenReq").addEventListener("click", () => goPage("netPayReq"));
})();
