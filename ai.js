/* ai.js — Tích hợp AI (Claude) cho IT-main
   ------------------------------------------------------------------
   Kiến trúc (xem thêm README mục "🤖 Trợ lý AI" và ai-worker/worker.js):

     app (trình duyệt) ──Firebase ID token──▶ Cloudflare Worker ──API key──▶ Claude
       │                                        (giữ prompt, JSON Schema, danh sách tool,
       │                                         kiểm tra role, lọc tool theo role)
       └─ TOOL chạy NGAY TRÊN TRÌNH DUYỆT trên dữ liệu đã đồng bộ sẵn
          (assets, ticketRecords, projectRecords, EMPLOYEES, PrCore, NetIsp)
          → không thêm lần đọc Firestore nào, và Firestore Rules vẫn là lớp chặn thật.

   5 chức năng:
     1. Đọc hóa đơn bằng AI (structured outputs) — nút "🤖 Đọc bằng AI" ở trang Đề nghị thanh toán (payreq.js).
     2. Tạo ticket từ tin nhắn tự do — khung "🤖 Trợ lý AI" đầu form ticket.
     3. Gợi ý nguyên nhân / cách xử lý / ticket lặp lại — cùng khung trên.
     4. Trợ lý IT (agent, tool calling) — trang "🤖 Trợ lý AI".
     5. Chuẩn hóa dữ liệu tài sản + Tóm tắt điều hành — cũng ở trang "🤖 Trợ lý AI".

   Nguyên tắc an toàn: AI KHÔNG tự ghi Firestore. Mọi thay đổi đều qua form
   hoặc bảng duyệt → người dùng bấm Lưu/Áp dụng → Firestore Rules kiểm tra.

   Các hàm thuần (tool, chấm điểm ticket tương tự, tìm trùng, tính số liệu tóm
   tắt...) xuất ở window.AIX.pure để test được ngoài trình duyệt. */
(function () {
  "use strict";

  /* ================= Cấu hình =================
     Địa chỉ Worker mặc định. Admin cũng có thể đặt ở trang Trợ lý AI → Cấu hình
     (lưu vào Firestore meta/ai, dùng chung mọi máy). Tài khoản "reportonly"
     không đọc được meta/ai nên cần điền sẵn ở đây nếu muốn họ dùng AI đọc hóa đơn. */
  const AI_ENDPOINT_DEFAULT = "";
  const AGENT_MAX_STEPS = 8;
  const TOOL_RESULT_MAX_CHARS = 24000;

  /* ================= Chuỗi giao diện (VI / EN / ZH) ================= */
  const T = {
    "nav.ai": ["Trợ lý AI", "AI assistant", "AI助手"],
    "nav.ai.desc": ["Hỏi đáp dữ liệu IT, tóm tắt điều hành, chuẩn hóa dữ liệu", "Ask about IT data, executive summary, data clean-up", "IT数据问答、管理摘要、数据规范化"],
    "ai.title": ["🤖 Trợ lý AI", "🤖 AI assistant", "🤖 AI助手"],
    "ai.off": ["Chức năng AI chưa được cấu hình. Admin vào mục Cấu hình bên dưới để nhập địa chỉ AI Worker.", "AI is not configured yet. An admin must enter the AI Worker URL in Settings below.", "AI尚未配置。管理员需在下方配置中填写AI Worker地址。"],
    "ai.chat.title": ["💬 Hỏi đáp dữ liệu IT", "💬 Ask about IT data", "💬 IT数据问答"],
    "ai.chat.hint": ["AI chỉ đọc dữ liệu bạn được phép xem, trả lời dựa trên số liệu thật trong app. AI không tự sửa/xóa dữ liệu.", "The AI only reads data your role may see and answers from real app data. It never edits or deletes anything.", "AI只读取您有权查看的数据，并基于应用中的真实数据回答，不会修改或删除任何数据。"],
    "ai.chat.ph": ["VD: Tổ Cắt có bao nhiêu laptop chưa kiểm?", "e.g. How many laptops in Cutting are unchecked?", "例如：裁剪部有多少台笔记本未盘点？"],
    "ai.chat.send": ["Gửi", "Send", "发送"],
    "ai.chat.new": ["🧹 Hội thoại mới", "🧹 New chat", "🧹 新对话"],
    "ai.chat.thinking": ["Đang suy nghĩ...", "Thinking...", "思考中..."],
    "ai.chat.stepLimit": ["Đã dừng sau {{n}} bước tra cứu — hãy hỏi cụ thể hơn.", "Stopped after {{n}} lookup steps — please ask more specifically.", "已在 {{n}} 步查询后停止——请提问得更具体些。"],
    "ai.chat.results": ["{{n}} kết quả", "{{n}} results", "{{n}} 条结果"],
    "ai.chat.you": ["Bạn", "You", "您"],
    "ai.s1": ["Tổng quan tài sản theo loại và trạng thái kiểm kê", "Asset overview by type and inventory status", "按类型和盘点状态的资产概况"],
    "ai.s2": ["Máy nào có nhiều ticket nhất 3 tháng qua?", "Which devices had the most tickets in the last 3 months?", "过去3个月哪些设备工单最多？"],
    "ai.s3": ["Ticket Khẩn/Cao nào đang chưa xong?", "Which Urgent/High tickets are still open?", "哪些紧急/高优先级工单仍未完成？"],
    "ai.s4": ["Hợp đồng thuê máy in nào sắp hết hạn, công nợ nào quá hạn?", "Which printer leases expire soon, which invoices are overdue?", "哪些打印机租约即将到期，哪些账款已逾期？"],
    "ai.draft.title": ["📝 Bản nháp ticket (chưa lưu)", "📝 Draft ticket (not saved)", "📝 工单草稿（未保存）"],
    "ai.draft.open": ["Mở form để kiểm tra & Lưu", "Open the form to review & save", "打开表单核对并保存"],
    "ai.sum.title": ["📝 Tóm tắt điều hành", "📝 Executive summary", "📝 管理摘要"],
    "ai.sum.hint": ["App tự tính số liệu (tài sản, ticket, dự án, máy in, công nợ) → AI viết thành bản tóm tắt ngắn cho Ban giám đốc.", "The app computes the figures (assets, tickets, projects, printers, payables) → the AI writes a short summary for management.", "应用先计算数据（资产、工单、项目、打印机、应付款）→ AI为管理层撰写简短摘要。"],
    "ai.sum.p.last30": ["30 ngày qua", "Last 30 days", "最近30天"],
    "ai.sum.p.thisMonth": ["Tháng này", "This month", "本月"],
    "ai.sum.p.lastMonth": ["Tháng trước", "Last month", "上月"],
    "ai.sum.p.last90": ["90 ngày qua", "Last 90 days", "最近90天"],
    "ai.sum.run": ["✨ Tạo tóm tắt", "✨ Generate summary", "✨ 生成摘要"],
    "ai.sum.copy": ["📋 Sao chép", "📋 Copy", "📋 复制"],
    "ai.sum.highlights": ["Điểm chính", "Highlights", "要点"],
    "ai.sum.risks": ["Rủi ro / cần chú ý", "Risks / attention", "风险/需关注"],
    "ai.sum.recs": ["Đề xuất", "Recommendations", "建议"],
    "ai.clean.title": ["🧹 Chuẩn hóa dữ liệu tài sản", "🧹 Asset data clean-up", "🧹 资产数据规范化"],
    "ai.clean.hint": ["(1) Tìm tài sản trùng Serial/MAC/IP — chạy ngay trên máy, không dùng AI. (2) AI chuẩn hóa Model/Cấu hình theo mẫu “CPU / RAM xGB / Ổ cứng”, bạn duyệt từng thay đổi trước khi áp dụng (có ghi lịch sử).", "(1) Find assets sharing Serial/MAC/IP — runs locally, no AI. (2) AI normalises Model/Spec to “CPU / RAM xGB / Disk”; you review every change before applying (history is recorded).", "(1) 查找序列号/MAC/IP重复的资产——本地运行，不用AI。(2) AI将型号/配置规范为“CPU / RAM xGB / 硬盘”，每项更改由您审核后再应用（记录历史）。"],
    "ai.clean.dup": ["🔎 Tìm trùng lặp", "🔎 Find duplicates", "🔎 查找重复"],
    "ai.clean.scope.pending": ["PC/Laptop chưa chuẩn hóa", "PCs/laptops not yet normalised", "尚未规范化的PC/笔记本"],
    "ai.clean.scope.all": ["Tất cả tài sản có Model/Cấu hình", "All assets with model/spec", "所有有型号/配置的资产"],
    "ai.clean.run": ["✨ AI chuẩn hóa (tối đa 40 tài sản/lượt)", "✨ AI normalise (max 40 assets per run)", "✨ AI规范化（每次最多40项）"],
    "ai.clean.apply": ["✅ Áp dụng các thay đổi đã chọn", "✅ Apply selected changes", "✅ 应用所选更改"],
    "ai.clean.none": ["Không còn tài sản nào cần chuẩn hóa trong phạm vi này.", "Nothing left to normalise in this scope.", "此范围内没有需要规范化的资产。"],
    "ai.clean.noChange": ["AI không đề xuất thay đổi nào cho {{n}} tài sản này — đã đánh dấu là đã kiểm tra.", "No changes proposed for these {{n}} assets — marked as checked.", "AI未对这 {{n}} 项资产提出更改——已标记为已检查。"],
    "ai.clean.applied": ["Đã áp dụng {{n}} thay đổi (có ghi lịch sử).", "Applied {{n}} changes (history recorded).", "已应用 {{n}} 项更改（已记录历史）。"],
    "ai.clean.col.asset": ["Tài sản", "Asset", "资产"],
    "ai.clean.col.change": ["Thay đổi đề xuất", "Proposed change", "建议更改"],
    "ai.dup.none": ["Không phát hiện tài sản trùng Serial/MAC/IP.", "No assets share a Serial/MAC/IP.", "未发现序列号/MAC/IP重复的资产。"],
    "ai.dup.serial": ["Trùng Serial", "Same serial", "序列号重复"],
    "ai.dup.mac": ["Trùng MAC", "Same MAC", "MAC重复"],
    "ai.dup.ip": ["Trùng IP (có thể do DHCP — chỉ tham khảo)", "Same IP (may be DHCP — for reference)", "IP重复（可能因DHCP——仅供参考）"],
    "ai.cfg.title": ["⚙ Cấu hình AI", "⚙ AI settings", "⚙ AI配置"],
    "ai.cfg.hint": ["Dán địa chỉ Cloudflare Worker (vd https://it-main-ai.xxx.workers.dev). Lưu vào Firestore nên mọi máy/tài khoản dùng chung. API key Claude chỉ nằm trong Worker, không bao giờ nằm trong app.", "Paste the Cloudflare Worker URL (e.g. https://it-main-ai.xxx.workers.dev). Saved to Firestore, shared by all devices/accounts. The Claude API key lives only in the Worker, never in the app.", "粘贴Cloudflare Worker地址（如 https://it-main-ai.xxx.workers.dev）。保存到Firestore，所有设备/账户共用。Claude API密钥只存在于Worker中，绝不放在应用里。"],
    "ai.cfg.endpoint": ["Địa chỉ AI Worker", "AI Worker URL", "AI Worker地址"],
    "ai.cfg.save": ["💾 Lưu", "💾 Save", "💾 保存"],
    "ai.cfg.test": ["🔌 Kiểm tra kết nối", "🔌 Test connection", "🔌 测试连接"],
    "ai.cfg.saved": ["Đã lưu cấu hình AI.", "AI settings saved.", "AI配置已保存。"],
    "ai.cfg.ok": ["Kết nối OK — vai trò: {{role}}, phiên bản prompt {{v}}.", "Connection OK — role: {{role}}, prompt version {{v}}.", "连接正常——角色：{{role}}，提示词版本 {{v}}。"],
    "ai.cfg.usage": ["Phiên này: {{n}} lần gọi AI · {{i}} token vào · {{o}} token ra", "This session: {{n}} AI calls · {{i}} input tokens · {{o}} output tokens", "本次会话：{{n}} 次AI调用 · 输入 {{i}} token · 输出 {{o}} token"],
    "ai.err": ["Lỗi AI: {{err}}", "AI error: {{err}}", "AI错误：{{err}}"],
    "ai.errOffline": ["Cần Internet để dùng AI.", "AI needs an Internet connection.", "使用AI需要联网。"],
    "ai.notConfigured": ["Chưa cấu hình địa chỉ AI Worker", "AI Worker URL not configured", "未配置AI Worker地址"],
    "ai.busy": ["AI đang xử lý...", "AI is working...", "AI处理中..."],
    "ai.t.title": ["🤖 Trợ lý AI", "🤖 AI assistant", "🤖 AI助手"],
    "ai.t.hint": ["Dán tin nhắn Zalo / nội dung người dùng báo → AI điền sẵn form. Bạn vẫn kiểm tra rồi mới bấm Lưu.", "Paste the user's Zalo message / report → the AI pre-fills the form. You still review before saving.", "粘贴用户的Zalo消息/报修内容 → AI预填表单。保存前仍需您核对。"],
    "ai.t.ph": ["VD: chị Lan tổ may 3 báo máy in không in được, gấp", "e.g. Lan from sewing line 3 says the printer won't print, urgent", "例如：缝制3组的Lan说打印机无法打印，很急"],
    "ai.t.parse": ["✨ Phân tích & điền form", "✨ Analyse & fill the form", "✨ 分析并填写表单"],
    "ai.t.suggest": ["💡 Gợi ý nguyên nhân & cách xử lý", "💡 Suggest cause & fix", "💡 建议原因与处理方法"],
    "ai.t.needDesc": ["Nhập Mô tả sự cố trước.", "Enter the issue description first.", "请先填写问题描述。"],
    "ai.t.filled": ["Đã điền form — kiểm tra lại trước khi Lưu.", "Form filled — review before saving.", "已填写表单——保存前请核对。"],
    "ai.t.pickEmp": ["Có nhiều nhân viên khớp “{{n}}” — bấm để chọn:", "Several employees match “{{n}}” — click to choose:", "有多名员工匹配“{{n}}”——点击选择："],
    "ai.t.category": ["Nhóm", "Category", "类别"],
    "ai.t.why": ["Lý do mức ưu tiên", "Priority reason", "优先级理由"],
    "ai.t.ask": ["Nên hỏi thêm", "Ask the user", "建议追问"],
    "ai.t.causes": ["Nguyên nhân khả dĩ", "Likely causes", "可能原因"],
    "ai.t.steps": ["Cách xử lý đề xuất", "Suggested fix", "建议处理步骤"],
    "ai.t.related": ["Ticket có thể cùng lỗi", "Possibly the same issue", "可能为同一问题的工单"],
    "ai.t.link": ["＋ Liên kết", "＋ Link", "＋ 关联"],
    "ai.t.applyCause": ["↳ Điền vào Nguyên nhân", "↳ Put into Cause", "↳ 填入原因"],
    "ai.t.applyFix": ["↳ Điền vào Cách xử lý", "↳ Put into Resolution", "↳ 填入处理方法"],
    "ai.t.noCand": ["(Chưa có ticket cũ tương tự — gợi ý dựa trên kinh nghiệm chung.)", "(No similar past tickets — suggestion based on general experience.)", "（没有类似的历史工单——建议基于通用经验。）"],
    "pq.ai": ["🤖 Đọc bằng AI", "🤖 Read with AI", "🤖 用AI读取"],
    "pq.aiBusy": ["AI đang đọc chứng từ...", "AI is reading the document...", "AI正在读取凭证..."],
    "pq.aiDone": ["AI đã đọc xong — kiểm tra lại các ô trước khi tạo file.", "AI finished — review the fields before building the file.", "AI读取完成——生成文件前请核对各字段。"],
    "pq.aiFail": ["AI không đọc được chứng từ này: {{err}}", "AI could not read this document: {{err}}", "AI无法读取此凭证：{{err}}"],
    "pq.aiKind": ["AI nhận định đây là “{{k}}”, không phải hóa đơn — kiểm tra có cần lập đề nghị không.", "The AI thinks this is a “{{k}}”, not an invoice — check whether it should be paid.", "AI判断这是“{{k}}”而非发票——请确认是否需要付款。"],
    "pq.w.ai": ["🤖 Số liệu do AI đọc (độ tin cậy: {{c}}) — kiểm tra kỹ.", "🤖 Figures read by AI (confidence: {{c}}) — double-check.", "🤖 数据由AI读取（可信度：{{c}}）——请仔细核对。"],
    "pq.w.aiNote": ["🤖 {{m}}", "🤖 {{m}}", "🤖 {{m}}"]
  };
  ["vi", "en", "zh"].forEach((lang, li) => {
    if (typeof I18N === "undefined" || !I18N[lang]) return;
    Object.keys(T).forEach(k => { I18N[lang][k] = T[k][li]; });
  });
  const L = (k, v) => (typeof tr === "function" ? tr(k, v) : (T[k] ? T[k][0] : k).replace(/\{\{(\w+)\}\}/g, (m, x) => (v && v[x] != null ? v[x] : m)));

  /* ================= Hàm thuần ================= */
  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/\s+/g, " ").trim();
  const pad = n => String(n).padStart(2, "0");
  const ymd = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const clampInt = (v, lo, hi, def) => { const n = parseInt(v, 10); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
  const has = (v, q) => norm(v).includes(q);
  const dayStart = s => (/^\d{4}-\d{2}-\d{2}$/.test(s || "") ? new Date(s + "T00:00:00").getTime() : null);
  const dayEnd = s => (/^\d{4}-\d{2}-\d{2}$/.test(s || "") ? new Date(s + "T23:59:59.999").getTime() : null);
  const tsMs = v => (v && typeof v.toMillis === "function" ? v.toMillis() : v && v.seconds ? v.seconds * 1000 : typeof v === "number" ? v : 0);

  function assetMs(a) {
    if (typeof assetCreatedMs === "function") { try { return assetCreatedMs(a) || 0; } catch (e) { /* bỏ qua */ } }
    return tsMs(a.createdAt) || ((a.history || []).find(h => h.action === "create") || {}).at || 0;
  }
  function ticketMs(t) {
    if (typeof ticketCreatedMs === "function") { try { const v = ticketCreatedMs(t); if (v) return v; } catch (e) { /* bỏ qua */ } }
    const c = tsMs(t.createdAt) || ((t.history || []).find(h => h.action === "create") || {}).at;
    if (c) return c;
    const m = /IT-(\d{4})(\d{2})(\d{2})/.exec(t.ticketId || "");
    return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T08:00:00`).getTime() : 0;
  }
  function projectMs(p) {
    return tsMs(p.createdAt) || ((p.history || []).find(h => h.action === "create") || {}).at || (p.startDate ? new Date(p.startDate + "T00:00:00").getTime() : 0);
  }
  const checkOf = a => a.checkStatus || "Chưa kiểm";

  // Bản "gọn" của bản ghi để gửi cho AI: bỏ ảnh base64, history dài, id nội bộ.
  const slimAsset = a => ({
    code: a.code || a._id, type: a.type || "", user: a.user || "", employeeCode: a.employeeCode || "", section: a.section || "", group: a.group || "",
    deviceName: a.deviceName || "", model: a.model || "", serial: a.serial || "", ip: a.ip || "", mac: a.mac || "",
    spec: a.spec || "", winInfo: a.winInfo || "", status: a.status || "", checkStatus: checkOf(a), note: String(a.note || "").slice(0, 200),
    created: assetMs(a) ? ymd(assetMs(a)) : ""
  });
  const slimTicket = t => ({
    ticketId: t.ticketId || t._id, created: ticketMs(t) ? ymd(ticketMs(t)) : "", priority: t.priority || "", status: t.status || "",
    requester: t.requester || "", employeeCode: t.employeeCode || "", department: t.department || "", assetCode: t.assetCode || "",
    device: t.device || "", description: String(t.description || "").slice(0, 300), cause: String(t.cause || "").slice(0, 200),
    resolution: String(t.resolution || "").slice(0, 300), repeatLinks: (t.linkedTicketCodes || []).length
  });
  const slimProject = p => ({
    projectCode: p.projectCode || p._id, name: p.name || "", status: p.status || "", priority: p.priority || "", owner: p.owner || "",
    department: p.department || "", startDate: p.startDate || "", endDate: p.endDate || "", progress: p.progress || 0,
    description: String(p.description || "").slice(0, 300)
  });
  const page = (list, limit, mapFn) => ({ total: list.length, returned: Math.min(list.length, limit), truncated: list.length > limit, items: list.slice(0, limit).map(mapFn) });
  const inRange = (ms, from, to) => (from == null || ms >= from) && (to == null || ms <= to);

  /* ---------- Tool (agent) — chạy trên dữ liệu trong bộ nhớ ---------- */
  const TOOLS = {
    search_assets(i, D) {
      const q = norm(i.query), sec = norm(i.section), st = norm(i.status);
      const list = D.assets.filter(a =>
        (!q || [a.code, a.user, a.employeeCode, a.deviceName, a.model, a.serial, a.ip, a.mac, a.note].some(v => has(v, q))) &&
        (!i.type || a.type === i.type) && (!sec || has(a.section, sec) || has(a.group, sec)) &&
        (!st || has(a.status, st)) && (!i.checkStatus || checkOf(a) === i.checkStatus));
      list.sort((a, b) => String(a.code).localeCompare(String(b.code)));
      return page(list, clampInt(i.limit, 1, 50, 20), slimAsset);
    },
    get_asset(i, D) {
      const c = norm(i.code);
      const a = D.assets.find(x => norm(x.code) === c || norm(x._id) === c);
      if (!a) return { found: false, message: "Không có tài sản mã " + i.code };
      const tickets = D.tickets.filter(t => (a._id && t.assetId === a._id) || norm(t.assetCode) === norm(a.code));
      tickets.sort((x, y) => ticketMs(y) - ticketMs(x));
      const history = (a.history || []).slice().sort((x, y) => (y.at || 0) - (x.at || 0)).slice(0, 10).map(h => ({
        date: h.at ? ymd(h.at) : "", by: h.by || "", action: h.action || "",
        changes: (h.changes || []).map(c2 => `${c2.field}: ${String(c2.from || "").slice(0, 60)} → ${String(c2.to || "").slice(0, 60)}`)
      }));
      return { found: true, asset: slimAsset(a), history, tickets: page(tickets, 20, slimTicket) };
    },
    search_tickets(i, D) {
      const q = norm(i.query), from = dayStart(i.dateFrom), to = dayEnd(i.dateTo), dep = norm(i.department), ac = norm(i.assetCode), ec = norm(i.employeeCode);
      const list = D.tickets.filter(t =>
        (!q || [t.ticketId, t.description, t.cause, t.resolution, t.device, t.requester, t.note].some(v => has(v, q))) &&
        (!i.status || (t.status || "Chờ") === i.status) && (!i.priority || t.priority === i.priority) &&
        (!ec || norm(t.employeeCode) === ec) && (!ac || norm(t.assetCode) === ac) && (!dep || has(t.department, dep)) &&
        inRange(ticketMs(t), from, to));
      list.sort((a, b) => ticketMs(b) - ticketMs(a));
      return page(list, clampInt(i.limit, 1, 50, 20), slimTicket);
    },
    get_ticket(i, D) {
      const id = norm(i.ticketId);
      const t = D.tickets.find(x => norm(x.ticketId) === id || norm(x._id) === id);
      if (!t) return { found: false, message: "Không có ticket " + i.ticketId };
      return {
        found: true, ticket: Object.assign(slimTicket(t), { note: String(t.note || "").slice(0, 300), linkedTickets: t.linkedTicketCodes || [] }),
        progress: (t.progressLog || []).slice(-15).map(p => ({ date: p.at ? ymd(p.at) : "", by: p.by || "", note: String(p.note || "").slice(0, 200) }))
      };
    },
    find_employee(i, D) {
      const q = norm(i.query);
      if (!q) return { total: 0, items: [] };
      let list = D.employees.filter(e => norm(e.code) === q);
      if (!list.length) list = D.employees.filter(e => has(e.name, q) || has(e.code, q));
      return page(list, 10, e => {
        const code = String(e.code || "").trim();
        const held = D.assets.filter(a => String(a.employeeCode || "").trim() === code);
        return {
          code, name: e.name || "", section: e.section || "", group: e.group || "", active: e.active !== false,
          takeLaptopHome: !!e.takeLaptopHome, assets: held.slice(0, 10).map(a => `${a.code} (${a.type || ""}${a.model ? " " + a.model : ""})`),
          ticketCount: D.tickets.filter(t => String(t.employeeCode || "").trim() === code).length
        };
      });
    },
    count_by(i, D) {
      const src = i.dataset === "tickets" ? D.tickets : i.dataset === "projects" ? D.projects : D.assets;
      const msOf = i.dataset === "tickets" ? ticketMs : i.dataset === "projects" ? projectMs : assetMs;
      const from = dayStart(i.dateFrom), to = dayEnd(i.dateTo), fv = norm(i.filterValue);
      const valOf = (r, f) => {
        if (f === "month") { const ms = msOf(r); return ms ? ymd(ms).slice(0, 7) : ""; }
        if (f === "checkStatus" && i.dataset !== "tickets" && i.dataset !== "projects") return checkOf(r);
        if (f === "status" && i.dataset === "tickets") return r.status || "Chờ";
        return r[f] == null ? "" : String(r[f]);
      };
      const rows = src.filter(r => ((from == null && to == null) || inRange(msOf(r), from, to)) &&
        (!i.filterField || !fv || has(valOf(r, i.filterField), fv)));
      const map = new Map();
      rows.forEach(r => { const k = valOf(r, i.field).trim() || "(trống)"; map.set(k, (map.get(k) || 0) + 1); });
      let groups = Array.from(map, ([key, count]) => ({ key, count }));
      groups.sort((a, b) => (i.field === "month" ? a.key.localeCompare(b.key) : b.count - a.count || a.key.localeCompare(b.key)));
      const top = clampInt(i.top, 1, 50, 15);
      return { dataset: i.dataset, field: i.field, total: rows.length, groupCount: groups.length, truncated: groups.length > top, groups: groups.slice(0, top) };
    },
    search_projects(i, D) {
      const q = norm(i.query);
      const list = D.projects.filter(p => (!q || [p.projectCode, p.name, p.owner, p.department, p.description].some(v => has(v, q))) && (!i.status || p.status === i.status));
      return page(list, 30, p => Object.assign(slimProject(p), { overdue: !!(p.endDate && p.endDate < D.today && !["Hoàn thành", "Hủy"].includes(p.status)) }));
    },
    printer_alerts(i, D) {
      const P = D.printer;
      if (!P) return { available: false, message: "Không có dữ liệu máy in (vai trò không được xem hoặc chưa tải)." };
      const rentVal = P.E && P.E.own ? P.E.own[0] : null;
      const rent = P.printers.filter(p => p.ownership === rentVal);
      const todayMs = dayStart(D.today);
      const alerts = rent.filter(p => p.rentEnd).map(p => ({ code: p.code, model: [p.brand, p.model].filter(Boolean).join(" "), section: p.section || "", vendor: p.vendorName || "", rentEnd: p.rentEnd, daysLeft: Math.round((dayStart(p.rentEnd) - todayMs) / 86400000) }))
        .filter(x => x.daysLeft <= 60).sort((a, b) => a.daysLeft - b.daysLeft);
      const monthly = rent.reduce((s, p) => s + (Number(p.monthlyFee) || 0) * (1 + (Number(p.vatRate) || 0) / 100), 0);
      return { printers: P.printers.length, rented: rent.length, owned: P.printers.length - rent.length, monthlyRentInclVat: Math.round(monthly), leaseAlerts: alerts };
    },
    payables(i, D) {
      const out = { items: [], totalRemaining: 0, overdueCount: 0, overdueAmount: 0 };
      const add = (mod, inv, vendor) => {
        const paid = (inv.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
        const remaining = Math.max(0, (Number(inv.amount) || 0) - paid);
        if (remaining <= 0) return;
        const overdue = !!inv.dueDate && inv.dueDate < D.today;
        if (i.onlyOverdue && !overdue) return;
        out.totalRemaining += remaining;
        if (overdue) { out.overdueCount++; out.overdueAmount += remaining; }
        out.items.push({ module: mod, vendor, invoiceNo: inv.invoiceNo || "", date: inv.invoiceDate || inv.date || "", dueDate: inv.dueDate || "", amount: Number(inv.amount) || 0, remaining, overdue });
      };
      if (i.module !== "network" && D.printer) D.printer.invoices.forEach(inv => { const v = D.printer.vendors.find(x => x._id === inv.vendorId); add("printer", inv, v ? v.name : inv.vendorName || ""); });
      if (i.module !== "printer" && D.net) D.net.bills.forEach(b => { const p = D.net.providers.find(x => x._id === b.providerId); add("network", b, p ? p.name : b.providerName || ""); });
      if (!D.printer && !D.net) return { available: false, message: "Không có dữ liệu công nợ (vai trò không được xem hoặc chưa tải)." };
      out.items.sort((a, b) => (a.dueDate || "9").localeCompare(b.dueDate || "9"));
      const all = out.items.length;
      out.items = out.items.slice(0, 40);
      out.truncated = all > 40;
      return out;
    },
    draft_ticket(i) {
      return { ok: true, shownToUser: true, message: "Bản nháp đã hiện cho người dùng kèm nút mở form. CHƯA lưu — người dùng tự kiểm tra và bấm Lưu.", draft: i };
    }
  };
  function runTool(name, input, D) {
    const fn = TOOLS[name];
    if (!fn) return { error: "Tool không tồn tại: " + name };
    try { return fn(input || {}, D); } catch (e) { return { error: e.message }; }
  }

  /* ---------- Chọn ticket cũ tương tự (gửi làm candidates cho AI) ---------- */
  // Tiếng Việt là ngôn ngữ đơn âm tiết ("máy in", "kẹt giấy") → dùng cả từ đơn (≥3 ký tự, bỏ từ phổ biến)
  // lẫn cặp âm tiết liền nhau ("may_in", "ket_giay") để so khớp.
  const STOP = new Set(["khong", "duoc", "may", "cua", "cho", "voi", "nhung", "dang", "the", "and", "not", "can", "mot", "cac", "nay", "khi", "lai", "bao", "nen", "roi"]);
  function tokens(s) {
    const syl = norm(s).split(/[^a-z0-9]+/).filter(Boolean);
    const out = new Set();
    syl.forEach((w, k) => {
      if (w.length >= 3 && !STOP.has(w)) out.add(w);
      if (k > 0) out.add(syl[k - 1] + "_" + w);
    });
    return Array.from(out);
  }
  function similarTickets(cur, all, limit) {
    const curToks = new Set(tokens([cur.description, cur.device, cur.cause].join(" ")));
    const devN = norm(cur.device);
    const scored = all.filter(t => t._id !== cur._id && (!cur.ticketId || t.ticketId !== cur.ticketId)).map(t => {
      let s = 0;
      if ((cur.assetId && t.assetId === cur.assetId) || (cur.assetCode && norm(t.assetCode) === norm(cur.assetCode))) s += 6;
      if (cur.employeeCode && norm(t.employeeCode) === norm(cur.employeeCode)) s += 2;
      if (devN && norm(t.device) && (norm(t.device) === devN || norm(t.device).includes(devN) || devN.includes(norm(t.device)))) s += 2;
      tokens([t.description, t.cause].join(" ")).forEach(w => { if (curToks.has(w)) s += w.includes("_") ? 1.5 : 1; });
      if (s > 0 && t.resolution) s += 1;
      return { t, s };
    }).filter(x => x.s >= 2.5);
    scored.sort((a, b) => b.s - a.s || ticketMs(b.t) - ticketMs(a.t));
    return scored.slice(0, limit || 15).map(x => x.t);
  }

  /* ---------- Khớp nhân viên theo tên/mã (AI không bao giờ tự đoán mã NV) ---------- */
  function matchEmployees(name, code, department, employees) {
    const c = norm(code);
    if (c) { const byCode = employees.filter(e => norm(e.code) === c); if (byCode.length) return byCode; }
    const n = norm(name).replace(/^(anh|chi|em|co|chu|ong|ba|a|c|e)\s+/, "");
    if (!n) return [];
    let list = employees.filter(e => norm(e.name) === n);
    if (!list.length) {
      const toks = n.split(" ");
      list = employees.filter(e => { const et = norm(e.name).split(" "); return toks.every(t => et.includes(t)) && et[et.length - 1] === toks[toks.length - 1]; });
    }
    const d = norm(department);
    if (d && list.length > 1) { const byDep = list.filter(e => has(e.section, d) || has(e.group, d)); if (byDep.length) list = byDep; }
    const active = list.filter(e => e.active !== false);
    return active.length ? active : list;
  }

  /* ---------- Tìm tài sản trùng Serial / MAC / IP ---------- */
  const JUNK_SERIAL = new Set(["", "0", "na", "n/a", "none", "default string", "to be filled by o.e.m.", "system serial number", "123456789", "0123456789", "chassis serial number"]);
  function findDuplicates(list) {
    const groups = [];
    const collect = (kind, keysOf) => {
      const map = new Map();
      list.forEach(a => keysOf(a).forEach(k => { if (!map.has(k)) map.set(k, []); if (!map.get(k).includes(a)) map.get(k).push(a); }));
      map.forEach((arr, key) => { if (arr.length > 1) groups.push({ kind, key, assets: arr.map(a => ({ id: a._id, code: a.code, type: a.type || "", user: a.user || "" })) }); });
    };
    collect("serial", a => { const s = norm(a.serial); return JUNK_SERIAL.has(s) ? [] : [s.toUpperCase()]; });
    collect("mac", a => (String(a.mac || "").match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/gi) || []).map(m => m.toUpperCase().replace(/-/g, ":")).filter(m => m !== "00:00:00:00:00:00"));
    collect("ip", a => (["Thanh lý", "Mất", "Thu hồi"].includes(a.status) ? [] : (String(a.ip || "").match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) || []).filter(ip => !/^(127\.|169\.254\.)/.test(ip))));
    return groups;
  }

  /* ---------- Số liệu cho Tóm tắt điều hành (app tự tính, AI chỉ diễn đạt) ---------- */
  function periodRange(kind, now) {
    const d = new Date(now);
    if (kind === "thisMonth") return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: now, label: `${pad(d.getMonth() + 1)}/${d.getFullYear()}` };
    if (kind === "lastMonth") { const s = new Date(d.getFullYear(), d.getMonth() - 1, 1); const e = new Date(d.getFullYear(), d.getMonth(), 1).getTime() - 1; return { from: s.getTime(), to: e, label: `${pad(s.getMonth() + 1)}/${s.getFullYear()}` }; }
    const days = kind === "last90" ? 90 : 30;
    return { from: now - days * 86400000, to: now, label: `${ymd(now - days * 86400000)} → ${ymd(now)}` };
  }
  function countBy(list, fn, top) {
    const m = new Map();
    list.forEach(x => { const k = fn(x) || "(trống)"; m.set(k, (m.get(k) || 0) + 1); });
    return Array.from(m, ([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n).slice(0, top || 10).reduce((o, x) => { o[x.k] = x.n; return o; }, {});
  }
  function doneAt(t) {
    let at = 0;
    (t.history || []).forEach(h => (h.changes || []).forEach(c => { if (c.field === "status" && c.to === "Hoàn thành" && (h.at || 0) > at) at = h.at; }));
    return at;
  }
  function buildSummaryStats(D, range) {
    const { from, to } = range;
    const tIn = D.tickets.filter(t => inRange(ticketMs(t), from, to));
    const open = D.tickets.filter(t => (t.status || "Chờ") !== "Hoàn thành");
    const nowMs = to;
    const resolved = D.tickets.map(t => ({ t, d: doneAt(t) })).filter(x => x.d && inRange(x.d, from, to) && ticketMs(x.t));
    const days = resolved.map(x => (x.d - ticketMs(x.t)) / 86400000).filter(x => x >= 0).sort((a, b) => a - b);
    const perAsset = countBy(tIn.filter(t => t.assetCode), t => t.assetCode, 50);
    const stats = {
      assets: {
        total: D.assets.length, byType: countBy(D.assets, a => a.type, 12), byStatus: countBy(D.assets, a => a.status, 10),
        byInventoryCheck: countBy(D.assets, checkOf, 6), createdInPeriod: D.assets.filter(a => inRange(assetMs(a), from, to)).length
      },
      tickets: {
        createdInPeriod: tIn.length, byPriorityInPeriod: countBy(tIn, t => t.priority, 4), byDepartmentInPeriod: countBy(tIn, t => t.department, 8),
        topDevicesInPeriod: countBy(tIn, t => t.device, 8),
        assetsWith2PlusTicketsInPeriod: Object.keys(perAsset).filter(k => perAsset[k] >= 2).reduce((o, k) => { o[k] = perAsset[k]; return o; }, {}),
        resolvedInPeriod: resolved.length,
        resolutionDaysAvg: days.length ? +(days.reduce((s, x) => s + x, 0) / days.length).toFixed(1) : null,
        resolutionDaysMedian: days.length ? +days[Math.floor(days.length / 2)].toFixed(1) : null,
        openNow: open.length, openUrgentOrHigh: open.filter(t => ["Khẩn", "Cao"].includes(t.priority)).length,
        openOlderThan7Days: open.filter(t => ticketMs(t) && nowMs - ticketMs(t) > 7 * 86400000).length
      },
      projects: {
        total: D.projects.length, byStatus: countBy(D.projects, p => p.status, 6),
        overdue: D.projects.filter(p => p.endDate && p.endDate < D.today && !["Hoàn thành", "Hủy"].includes(p.status)).map(p => `${p.projectCode || ""} ${p.name || ""} (hạn ${p.endDate}, ${p.progress || 0}%)`).slice(0, 8)
      }
    };
    const pa = D.printer ? TOOLS.printer_alerts({}, D) : null;
    if (pa && pa.printers != null) stats.printers = { total: pa.printers, rented: pa.rented, monthlyRentInclVat: pa.monthlyRentInclVat, leaseAlerts: pa.leaseAlerts.slice(0, 6) };
    const pay = (D.printer || D.net) ? TOOLS.payables({ module: "all", onlyOverdue: false }, D) : null;
    if (pay && pay.items) stats.payables = { totalRemaining: pay.totalRemaining, overdueCount: pay.overdueCount, overdueAmount: pay.overdueAmount };
    return stats;
  }

  /* ---------- Chuyển kết quả AI (hóa đơn) sang đúng dạng PrPay.parseInvoiceText ---------- */
  function invoiceToParsed(d) {
    const s = d.seller || {}, b = d.buyer || {};
    const digitsDash = v => String(v || "").replace(/[^\d-]/g, "");
    const out = {
      serial: d.serial || "", number: String(d.number || "").trim(), date: /^\d{4}-\d{2}-\d{2}$/.test(d.date || "") ? d.date : "",
      seller: { name: s.name || "", tax: digitsDash(s.tax), account: String(s.account || "").replace(/\D/g, ""), bank: s.bank || "", phone: s.phone || "", address: s.address || "" },
      buyer: { name: b.name || "", tax: digitsDash(b.tax) },
      items: (d.items || []).map((it, k) => ({ no: String(k + 1), desc: it.desc || "", qty: it.qty || "", price: Math.round(Number(it.price) || 0), amount: Math.round(Number(it.amount) || 0) })),
      exVat: Math.round(Number(d.exVat) || 0), vatRate: Number(d.vatRate) >= 0 ? Number(d.vatRate) : null, vat: Math.round(Number(d.vat) || 0),
      total: Math.round(Number(d.total) || 0), words: d.words || "", payment: d.payment || "",
      docKind: d.docKind || "invoice", period: /^\d{4}-\d{2}$/.test(d.period || "") ? d.period : "", confidence: d.confidence || "low", warnings: d.warnings || []
    };
    if (!out.exVat && out.items.length) out.exVat = out.items.reduce((x, it) => x + it.amount, 0);
    if (!out.total && out.exVat) out.total = out.exVat + out.vat;
    out.ok = !!(out.total && (out.number || out.docKind === "notice"));
    return out;
  }

  /* ---------- Markdown tối giản cho câu trả lời chat (luôn escape trước) ---------- */
  function mdLite(src, linkify) {
    const lk = linkify || (s => s);
    const inline = s => lk(esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>"));
    const lines = String(src || "").split(/\r?\n/);
    let html = "", list = null, table = [];
    const flushList = () => { if (list) { html += `<${list.tag}>${list.items.map(x => `<li>${x}</li>`).join("")}</${list.tag}>`; list = null; } };
    const flushTable = () => {
      if (!table.length) return;
      const rows = table.filter(r => !/^\s*\|?[\s|:-]+\|?\s*$/.test(r)).map(r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
      html += `<div class="ai-table-wrap"><table class="ai-table">${rows.map((r, k) => `<tr>${r.map(c => k === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</table></div>`;
      table = [];
    };
    lines.forEach(line => {
      if (/^\s*\|.*\|\s*$/.test(line)) { flushList(); table.push(line); return; }
      flushTable();
      let m;
      if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) { if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; } list.items.push(inline(m[1])); return; }
      if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; } list.items.push(inline(m[1])); return; }
      flushList();
      if ((m = /^\s*#{1,4}\s+(.*)$/.exec(line))) { html += `<h4>${inline(m[1])}</h4>`; return; }
      if (line.trim()) html += `<p>${inline(line)}</p>`;
    });
    flushList(); flushTable();
    return html;
  }

  const pure = { TOOLS, runTool, similarTickets, matchEmployees, findDuplicates, buildSummaryStats, periodRange, invoiceToParsed, mdLite, norm, ticketMs };

  /* ================= Phần chạy trên trình duyệt ================= */
  const $ = id => document.getElementById(id);
  if (typeof document === "undefined" || !$("aiAssistant")) {
    if (typeof window !== "undefined") window.AIX = { pure };
    return;
  }

  let metaEndpoint = "";
  let usage = { n: 0, i: 0, o: 0 };
  const localOverride = () => { try { return localStorage.getItem("aiEndpoint") || ""; } catch (e) { return ""; } };
  const endpoint = () => (localOverride() || metaEndpoint || AI_ENDPOINT_DEFAULT || "").trim().replace(/\/+$/, "");
  const ready = () => !!endpoint();
  const role = () => (typeof isAdmin !== "undefined" && isAdmin ? "admin" : typeof isCollector !== "undefined" && isCollector ? "collector" : typeof isViewer !== "undefined" && isViewer ? "viewer" : typeof isReportOnly !== "undefined" && isReportOnly ? "reportonly" : "");
  const lang = () => (typeof getLang === "function" ? getLang() : "vi");
  const today = () => ymd(Date.now());

  function refreshAvailability() {
    document.body.classList.toggle("ai-on", ready());
    const off = $("aiOffNotice"); if (off) off.classList.toggle("hidden", ready());
    const inp = $("aiEndpointInput"); if (inp && document.activeElement !== inp) inp.value = endpoint();
    if (typeof window.renderPayReq === "function" && typeof isReportOnly !== "undefined") { try { window.renderPayReq(); } catch (e) { /* bỏ qua */ } }
  }

  async function call(task, input) {
    if (!ready()) throw new Error(L("ai.notConfigured"));
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error(L("ai.errOffline"));
    const user = typeof auth !== "undefined" && auth.currentUser;
    if (!user) throw new Error("Chưa đăng nhập");
    const token = await user.getIdToken();
    let res;
    try {
      res = await fetch(endpoint() + "/ai", {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ task, input, lang: lang(), today: today() })
      });
    } catch (e) { throw new Error(L("ai.errOffline") + " (" + e.message + ")"); }
    const data = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    if (data.usage) { usage.n++; usage.i += (data.usage.input_tokens || 0) + (data.usage.cache_read_input_tokens || 0) + (data.usage.cache_creation_input_tokens || 0); usage.o += data.usage.output_tokens || 0; renderUsage(); }
    return data;
  }

  function liveData() {
    let printer = null, net = null;
    try { if (window.PrCore && (role() === "admin" || role() === "viewer")) printer = { printers: window.PrCore.printers || [], vendors: window.PrCore.vendors || [], invoices: window.PrCore.invoices || [], E: window.PrCore.E }; } catch (e) { /* bỏ qua */ }
    try { if (window.NetIsp && window.NetIsp.state && (role() === "admin" || role() === "viewer")) net = window.NetIsp.state(); } catch (e) { /* bỏ qua */ }
    return {
      assets: typeof assets !== "undefined" ? assets : [], tickets: typeof ticketRecords !== "undefined" ? ticketRecords : [],
      projects: typeof projectRecords !== "undefined" ? projectRecords : [], employees: window.EMPLOYEES || [],
      printer, net, today: today()
    };
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(r.error || new Error("Không đọc được file"));
      r.readAsDataURL(file);
    });
  }

  /* ---------- 1. Hóa đơn ---------- */
  async function extractInvoice(file, text) {
    if (!file && !text) throw new Error("Không có file");
    const input = { fileName: file ? file.name : "", text: text || "" };
    if (file) {
      if (file.size > 8 * 1024 * 1024) throw new Error("File > 8MB");
      const b64 = await fileToBase64(file);
      if (/pdf/i.test(file.type) || /\.pdf$/i.test(file.name)) input.pdfBase64 = b64;
      else { input.imageBase64 = b64; input.mediaType = file.type || "image/jpeg"; }
    }
    const res = await call("invoice", input);
    return invoiceToParsed(res.data);
  }

  /* ---------- 2 + 3. Ticket ---------- */
  const tOut = () => $("ticketAiOut");
  const formEditable = () => $("ticketDescription") && !$("ticketDescription").disabled && !$("ticketDescription").readOnly;
  function setIfEmpty(id, v) { const el = $(id); if (el && v && !String(el.value || "").trim()) el.value = v; }
  function applyEmployee(e) {
    $("ticketEmployeeCode").value = e.code || "";
    $("ticketRequester").value = e.name || "";
    $("ticketDepartment").value = e.section || "";
    if (typeof autoLinkAssetByEmployeeCode === "function") autoLinkAssetByEmployeeCode(e.code);
  }
  function applyAssetCode(code) {
    if (!code || typeof assets === "undefined") return false;
    const a = assets.find(x => norm(x.code) === norm(code));
    if (!a) { setIfEmpty("ticketAsset", code); return false; }
    $("ticketAsset").value = a.code; $("ticketAssetId").value = a._id;
    setIfEmpty("ticketDevice", [a.type, a.model].filter(Boolean).join(" - "));
    setIfEmpty("ticketDepartment", a.section || "");
    setIfEmpty("ticketEmployeeCode", a.employeeCode || "");
    setIfEmpty("ticketRequester", a.user || "");
    return true;
  }
  // Điền form ticket từ dữ liệu có cấu trúc (dùng cho ticket_parse và draft_ticket của agent).
  function fillTicketDraft(d) {
    if (d.priority && typeof TICKET_PRIORITIES !== "undefined" && TICKET_PRIORITIES.includes(d.priority)) $("ticketPriority").value = d.priority;
    setIfEmpty("ticketDescription", d.description);
    setIfEmpty("ticketDevice", d.device);
    const linked = applyAssetCode(d.assetCode);
    const cands = matchEmployees(d.requesterName || d.requester, d.employeeCode, d.department, window.EMPLOYEES || []);
    let pickHtml = "";
    if (cands.length === 1) applyEmployee(cands[0]);
    else {
      setIfEmpty("ticketRequester", d.requesterName || d.requester);
      if (!$("ticketDepartment").value && d.department) $("ticketDepartment").value = d.department;
      if (cands.length > 1) {
        pickHtml = `<div class="ai-pick"><div class="muted">${esc(L("ai.t.pickEmp", { n: d.requesterName || d.requester || "" }))}</div>` +
          cands.slice(0, 8).map((e, k) => `<button type="button" class="chip ai-emp" data-k="${k}">${esc(e.name)} · ${esc(e.code)}${e.section ? " · " + esc(e.section) : ""}</button>`).join("") + "</div>";
      }
    }
    return { cands: cands.slice(0, 8), pickHtml, linked };
  }
  function bindEmpPick(box, cands) {
    box.querySelectorAll(".ai-emp").forEach(b => b.addEventListener("click", () => {
      const e = cands[+b.getAttribute("data-k")]; if (!e) return;
      applyEmployee(e);
      const pick = b.closest(".ai-pick"); if (pick) pick.remove();
    }));
  }
  async function ticketParse() {
    const text = $("ticketAiText").value.trim();
    if (!text) { $("ticketAiText").focus(); return; }
    const box = tOut(); box.innerHTML = `<div class="muted">${esc(L("ai.busy"))}</div>`;
    const btn = $("ticketAiParseBtn"); btn.disabled = true;
    try {
      const sections = Array.from(new Set((window.EMPLOYEES || []).map(e => e.section).filter(Boolean))).sort();
      const { data } = await call("ticket_parse", { text, sections, today: today() });
      const r = fillTicketDraft(data);
      box.innerHTML = `<div class="ai-result"><div class="pr-alert info">${esc(L("ai.t.filled"))}</div>
        <div><b>${esc(L("ai.t.category"))}:</b> ${esc(data.category)} · <b>${esc(L("field.priority"))}:</b> ${esc(data.priority)}</div>
        <div class="muted">${esc(L("ai.t.why"))}: ${esc(data.priorityReason)}</div>
        ${data.missingInfo && data.missingInfo.length ? `<div><b>${esc(L("ai.t.ask"))}:</b><ul>${data.missingInfo.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
        ${r.pickHtml}</div>`;
      bindEmpPick(box, r.cands);
      const note = $("ticketNote");
      if (note && !note.value.trim()) note.value = "Tin nhắn gốc: " + text.slice(0, 500);
    } catch (e) {
      box.innerHTML = `<div class="pr-alert warn">${esc(L("ai.err", { err: e.message }))}</div>`;
    } finally { btn.disabled = false; }
  }
  async function ticketSuggest() {
    const desc = $("ticketDescription").value.trim();
    if (!desc) { alert(L("ai.t.needDesc")); return; }
    const box = tOut(); box.innerHTML = `<div class="muted">${esc(L("ai.busy"))}</div>`;
    const btn = $("ticketAiSuggestBtn"); btn.disabled = true;
    try {
      const assetId = $("ticketAssetId").value;
      const asset = assetId && typeof assets !== "undefined" ? assets.find(a => a._id === assetId) : null;
      const cur = {
        _id: $("ticketDocId").value, ticketId: $("ticketId").value.trim(), description: desc, device: $("ticketDevice").value.trim(),
        cause: $("ticketCause").value.trim(), resolution: $("ticketResolution").value.trim(), assetId,
        assetCode: asset ? asset.code : $("ticketAsset").value.trim(), employeeCode: $("ticketEmployeeCode").value.trim(),
        asset: asset ? { type: asset.type, model: asset.model, spec: asset.spec } : null
      };
      const candRecs = similarTickets(cur, typeof ticketRecords !== "undefined" ? ticketRecords : [], 15);
      const candidates = candRecs.map(t => Object.assign(slimTicket(t), { date: ticketMs(t) ? ymd(ticketMs(t)) : "" }));
      const { data } = await call("ticket_suggest", { ticket: cur, candidates });
      const canEdit = formEditable();
      const byCode = new Map(candRecs.map(t => [t.ticketId, t]));
      const alreadyLinked = new Set((typeof currentLinkedTickets !== "undefined" ? currentLinkedTickets : []).map(x => x.id));
      const causesTxt = (data.likelyCauses || []).map(c => c.cause).join("; ");
      const stepsTxt = (data.resolutionSteps || []).map((s, k) => `${k + 1}. ${s}`).join("\n");
      box.innerHTML = `<div class="ai-result">
        ${candidates.length ? "" : `<div class="muted">${esc(L("ai.t.noCand"))}</div>`}
        ${data.recurrenceNote ? `<div class="pr-alert warn">🔁 ${esc(data.recurrenceNote)}</div>` : ""}
        <b>${esc(L("ai.t.causes"))}</b>
        <ul>${(data.likelyCauses || []).map(c => `<li>${esc(c.cause)} <span class="badge">${esc(c.likelihood)}</span>${c.basedOn && c.basedOn.length ? ` <span class="muted">(${c.basedOn.map(esc).join(", ")})</span>` : ""}</li>`).join("")}</ul>
        ${canEdit && causesTxt ? `<button type="button" class="secondary pq-mini" data-ai-apply="cause">${esc(L("ai.t.applyCause"))}</button>` : ""}
        <b>${esc(L("ai.t.steps"))}</b>
        <ol>${(data.resolutionSteps || []).map(s => `<li>${esc(s)}</li>`).join("")}</ol>
        ${canEdit && stepsTxt ? `<button type="button" class="secondary pq-mini" data-ai-apply="fix">${esc(L("ai.t.applyFix"))}</button>` : ""}
        ${data.needMoreInfo && data.needMoreInfo.length ? `<div><b>${esc(L("ai.t.ask"))}:</b><ul>${data.needMoreInfo.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
        ${(data.relatedTicketIds || []).length ? `<b>${esc(L("ai.t.related"))}</b><div class="ai-related">${data.relatedTicketIds.map(id => {
          const t = byCode.get(id); if (!t) return "";
          const linkBtn = (typeof isAdmin !== "undefined" && isAdmin && canEdit && !alreadyLinked.has(t._id)) ? `<button type="button" class="pq-mini" data-ai-link="${esc(t._id)}">${esc(L("ai.t.link"))}</button>` : "";
          return `<div class="ai-rel"><a href="#" data-ticket="${esc(t._id)}">${esc(t.ticketId)}</a> <span class="muted">${esc(String(t.description || "").slice(0, 80))}</span> ${linkBtn}</div>`;
        }).join("")}</div>` : ""}
      </div>`;
      box.querySelectorAll("[data-ai-apply]").forEach(b => b.addEventListener("click", () => {
        if (b.getAttribute("data-ai-apply") === "cause") $("ticketCause").value = ($("ticketCause").value.trim() ? $("ticketCause").value.trim() + "\n" : "") + causesTxt;
        else $("ticketResolution").value = ($("ticketResolution").value.trim() ? $("ticketResolution").value.trim() + "\n" : "") + stepsTxt;
      }));
      box.querySelectorAll("[data-ai-link]").forEach(b => b.addEventListener("click", () => {
        const t = (typeof ticketRecords !== "undefined" ? ticketRecords : []).find(x => x._id === b.getAttribute("data-ai-link"));
        if (!t || typeof currentLinkedTickets === "undefined") return;
        if (!currentLinkedTickets.some(x => x.id === t._id)) currentLinkedTickets.push({ id: t._id, ticketId: t.ticketId });
        if (typeof renderTicketLinkedChips === "function") renderTicketLinkedChips();
        b.remove();
      }));
    } catch (e) {
      box.innerHTML = `<div class="pr-alert warn">${esc(L("ai.err", { err: e.message }))}</div>`;
    } finally { btn.disabled = false; }
  }

  /* ---------- Liên kết mã tài sản / ticket trong câu trả lời ---------- */
  function linkify(html) {
    if (typeof assets === "undefined") return html;
    const aMap = new Map(assets.map(a => [String(a.code || "").toUpperCase(), a._id]));
    const tMap = new Map((typeof ticketRecords !== "undefined" ? ticketRecords : []).map(t => [String(t.ticketId || "").toUpperCase(), t._id]));
    return html.replace(/\b[A-Z]{2,6}(?:-[A-Z0-9]{1,8}){1,3}\b/g, m => {
      if (tMap.has(m)) return `<a href="#" data-ticket="${esc(tMap.get(m))}">${m}</a>`;
      if (aMap.has(m)) return `<a href="#" data-asset="${esc(aMap.get(m))}">${m}</a>`;
      return m;
    });
  }
  document.addEventListener("click", e => {
    const a = e.target.closest && e.target.closest("[data-asset],[data-ticket]");
    if (!a || !a.closest(".ai-log, .ai-result, #aiDupOut, #aiCleanOut")) return;
    e.preventDefault();
    if (a.hasAttribute("data-asset") && typeof editAsset === "function") editAsset(a.getAttribute("data-asset"));
    else if (a.hasAttribute("data-ticket") && typeof window.editTicket === "function") window.editTicket(a.getAttribute("data-ticket"));
  });

  /* ---------- 4. Trợ lý IT (agent) ---------- */
  let chat = [];      // lịch sử theo định dạng Messages API
  let chatBusy = false;
  const log = () => $("aiChatLog");
  function addBubble(cls, html) {
    const div = document.createElement("div");
    div.className = "ai-msg " + cls;
    div.innerHTML = html;
    log().appendChild(div);
    log().scrollTop = log().scrollHeight;
    return div;
  }
  function summarizeResult(r) {
    if (!r || typeof r !== "object") return "";
    if (r.error) return "⚠ " + r.error;
    if (r.found === false) return r.message || "0";
    if (typeof r.total === "number") return L("ai.chat.results", { n: r.total });
    if (r.found) return "✓";
    return "";
  }
  function draftCard(d) {
    const div = addBubble("ai-bot", `<div class="ai-draft"><b>${esc(L("ai.draft.title"))}</b>
      <div>${esc(d.priority || "")} · ${esc(d.requester || "")}${d.department ? " · " + esc(d.department) : ""}${d.assetCode ? " · " + esc(d.assetCode) : ""}</div>
      <div>${esc(d.device || "")}</div><div class="muted">${esc(d.description || "")}</div>
      <button type="button" class="pq-mini">${esc(L("ai.draft.open"))}</button></div>`);
    div.querySelector("button").addEventListener("click", () => {
      if (typeof clearTicketForm === "function") clearTicketForm();
      goPage("ticketForm");
      const r = fillTicketDraft({ priority: d.priority, description: d.description, device: d.device, assetCode: d.assetCode, requester: d.requester, employeeCode: d.employeeCode, department: d.department });
      if (r.pickHtml) { tOut().innerHTML = `<div class="ai-result">${r.pickHtml}</div>`; bindEmpPick(tOut(), r.cands); }
    });
  }
  async function sendChat(text) {
    if (chatBusy || !text.trim()) return;
    chatBusy = true; $("aiSendBtn").disabled = true;
    $("aiSamples").classList.add("hidden");
    addBubble("ai-user", `<div class="ai-who">${esc(L("ai.chat.you"))}</div>${esc(text).replace(/\n/g, "<br>")}`);
    const base = chat.length;
    chat.push({ role: "user", content: text });
    const wait = addBubble("ai-bot ai-wait", esc(L("ai.chat.thinking")));
    try {
      let step = 0;
      while (true) {
        step++;
        const res = await call("agent", { messages: chat });
        chat.push({ role: "assistant", content: res.content });
        const toolUses = res.content.filter(b => b.type === "tool_use");
        res.content.filter(b => b.type === "text" && b.text.trim()).forEach(b => addBubble("ai-bot", mdLite(b.text, linkify)));
        if (res.stop_reason !== "tool_use" || !toolUses.length) break;
        const D = liveData();
        const results = toolUses.map(b => {
          const out = runTool(b.name, b.input, D);
          if (b.name === "draft_ticket") draftCard(b.input);
          let s = JSON.stringify(out);
          if (s.length > TOOL_RESULT_MAX_CHARS) s = s.slice(0, TOOL_RESULT_MAX_CHARS) + '..."[CẮT BỚT — kết quả quá dài, hãy lọc hẹp hơn]"';
          addBubble("ai-tool", `🔧 ${esc(b.name)} <span class="muted">${esc(Object.entries(b.input || {}).filter(([, v]) => v !== "" && v != null).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ").slice(0, 140))}</span> → ${esc(summarizeResult(out))}`);
          return { type: "tool_result", tool_use_id: b.id, content: s, is_error: !!out.error };
        });
        chat.push({ role: "user", content: results });
        if (step >= AGENT_MAX_STEPS) { addBubble("ai-bot", esc(L("ai.chat.stepLimit", { n: step }))); chat.push({ role: "assistant", content: L("ai.chat.stepLimit", { n: step }) }); break; }
        log().appendChild(wait);
      }
    } catch (e) {
      addBubble("ai-bot ai-err", esc(L("ai.err", { err: e.message })));
      // Bỏ cả lượt hỏi lỗi khỏi lịch sử để hội thoại vẫn hợp lệ cho lần sau.
      chat.length = base;
    } finally {
      wait.remove();
      chatBusy = false; $("aiSendBtn").disabled = false;
    }
  }
  function resetChat() {
    chat = [];
    log().innerHTML = "";
    renderSamples();
  }
  function renderSamples() {
    const keys = ["ai.s1", "ai.s2", "ai.s3"].concat(role() === "admin" || role() === "viewer" ? ["ai.s4"] : []);
    $("aiSamples").innerHTML = keys.map(k => `<button type="button" class="chip ai-sample">${esc(L(k))}</button>`).join("");
    $("aiSamples").classList.remove("hidden");
    $("aiSamples").querySelectorAll(".ai-sample").forEach(b => b.addEventListener("click", () => sendChat(b.textContent)));
  }

  /* ---------- 5a. Tóm tắt điều hành ---------- */
  let lastSummaryText = "";
  async function runSummary() {
    const out = $("aiSummaryOut"), btn = $("aiSummaryBtn");
    out.innerHTML = `<div class="muted">${esc(L("ai.busy"))}</div>`; btn.disabled = true;
    try {
      const range = periodRange($("aiSummaryPeriod").value, Date.now());
      const stats = buildSummaryStats(liveData(), range);
      const { data } = await call("report_summary", { stats, periodLabel: range.label });
      const sec = (title, arr) => arr && arr.length ? `<b>${esc(title)}</b><ul>${arr.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
      out.innerHTML = `<div class="ai-result"><p class="ai-headline">${esc(data.headline)}</p>${sec(L("ai.sum.highlights"), data.highlights)}${sec(L("ai.sum.risks"), data.risks)}${sec(L("ai.sum.recs"), data.recommendations)}
        <div class="muted">${esc(range.label)}</div></div>`;
      const li = arr => (arr || []).map(x => "- " + x).join("\n");
      lastSummaryText = `${L("ai.sum.title").replace(/^\S+\s/, "")} (${range.label})\n\n${data.headline}\n\n${L("ai.sum.highlights")}:\n${li(data.highlights)}\n\n${L("ai.sum.risks")}:\n${li(data.risks)}\n\n${L("ai.sum.recs")}:\n${li(data.recommendations)}`;
      $("aiSummaryCopy").classList.remove("hidden");
    } catch (e) {
      out.innerHTML = `<div class="pr-alert warn">${esc(L("ai.err", { err: e.message }))}</div>`;
    } finally { btn.disabled = false; }
  }

  /* ---------- 5b. Chuẩn hóa dữ liệu ---------- */
  function renderDup() {
    const groups = findDuplicates(typeof assets !== "undefined" ? assets : []);
    const out = $("aiDupOut");
    if (!groups.length) { out.innerHTML = `<div class="pr-alert info">${esc(L("ai.dup.none"))}</div>`; return; }
    const lbl = { serial: L("ai.dup.serial"), mac: L("ai.dup.mac"), ip: L("ai.dup.ip") };
    out.innerHTML = ["serial", "mac", "ip"].map(kind => {
      const gs = groups.filter(g => g.kind === kind); if (!gs.length) return "";
      return `<h4>${esc(lbl[kind])} (${gs.length})</h4>` + gs.slice(0, 50).map(g => `<div class="ai-dup ${kind === "ip" ? "" : "warn"}"><code>${esc(g.key)}</code> → ${g.assets.map(a => `<a href="#" data-asset="${esc(a.id)}">${esc(a.code)}</a> <span class="muted">${esc(a.type)}${a.user ? " · " + esc(a.user) : ""}</span>`).join(" · ")}</div>`).join("");
    }).join("");
  }
  let cleanBatch = [], cleanProposals = [];
  async function runClean() {
    const out = $("aiCleanOut"), btn = $("aiCleanBtn");
    const scope = $("aiCleanScope").value;
    const all = typeof assets !== "undefined" ? assets : [];
    const pool = all.filter(a => (a.model || a.spec) && (scope === "all" || ((a.type === "Máy tính (PC)" || a.type === "Laptop") && !a.aiCleanedAt)));
    cleanBatch = pool.slice(0, 40);
    if (!cleanBatch.length) { out.innerHTML = `<div class="pr-alert info">${esc(L("ai.clean.none"))}</div>`; return; }
    out.innerHTML = `<div class="muted">${esc(L("ai.busy"))} (${cleanBatch.length})</div>`; btn.disabled = true;
    try {
      const { data } = await call("asset_clean", { assets: cleanBatch.map(a => ({ code: a.code, type: a.type, deviceName: a.deviceName, model: a.model, spec: a.spec, serial: a.serial })) });
      cleanProposals = [];
      (data.items || []).forEach(it => {
        const a = cleanBatch.find(x => x.code === it.code); if (!a) return;
        [["model", it.model], ["spec", it.spec], ["type", it.type]].forEach(([f, v]) => {
          if (v && String(v).trim() && String(v).trim() !== String(a[f] || "").trim()) cleanProposals.push({ a, field: f, from: a[f] || "", to: String(v).trim(), confidence: it.confidence, issues: it.issues || [] });
        });
        if (it.issues && it.issues.length && ![["model", it.model], ["spec", it.spec], ["type", it.type]].some(([, v]) => v)) cleanProposals.push({ a, field: "", issues: it.issues, confidence: it.confidence });
      });
      const changes = cleanProposals.filter(p => p.field);
      if (!changes.length) {
        await markCleaned(cleanBatch);
        out.innerHTML = `<div class="pr-alert info">${esc(L("ai.clean.noChange", { n: cleanBatch.length }))}</div>` + issuesHtml();
        return;
      }
      out.innerHTML = `<div class="ai-table-wrap"><table class="ai-table"><tr><th></th><th>${esc(L("ai.clean.col.asset"))}</th><th>${esc(L("ai.clean.col.change"))}</th></tr>` +
        cleanProposals.map((p, k) => p.field ? `<tr><td><input type="checkbox" data-k="${k}" ${p.confidence === "low" ? "" : "checked"}></td>
          <td><a href="#" data-asset="${esc(p.a._id)}">${esc(p.a.code)}</a><div class="muted">${esc(p.field)} · ${esc(p.confidence)}</div></td>
          <td><div class="ai-from">${esc(p.from || "—")}</div><div class="ai-to">${esc(p.to)}</div>${p.issues.length ? `<div class="muted">⚠ ${p.issues.map(esc).join("; ")}</div>` : ""}</td></tr>` : "").join("") +
        `</table></div>${issuesHtml()}<button type="button" id="aiCleanApply">${esc(L("ai.clean.apply"))}</button>`;
      $("aiCleanApply").addEventListener("click", applyClean);
    } catch (e) {
      out.innerHTML = `<div class="pr-alert warn">${esc(L("ai.err", { err: e.message }))}</div>`;
    } finally { btn.disabled = false; }
  }
  function issuesHtml() {
    const list = cleanProposals.filter(p => !p.field);
    return list.length ? `<div class="muted" style="margin:8px 0">${list.map(p => `<div><a href="#" data-asset="${esc(p.a._id)}">${esc(p.a.code)}</a>: ⚠ ${p.issues.map(esc).join("; ")}</div>`).join("")}</div>` : "";
  }
  async function markCleaned(list, extra) {
    const batch = db.batch();
    list.forEach(a => {
      const data = Object.assign({ aiCleanedAt: Date.now() }, (extra && extra[a._id]) || {});
      batch.set(db.collection(COLLECTION).doc(a._id), data, { merge: true });
    });
    await batch.commit();
  }
  async function applyClean() {
    const btn = $("aiCleanApply"); btn.disabled = true;
    try {
      const chosen = Array.from(document.querySelectorAll("#aiCleanOut input[type=checkbox][data-k]:checked")).map(el => cleanProposals[+el.getAttribute("data-k")]);
      const perAsset = {};
      chosen.forEach(p => { (perAsset[p.a._id] = perAsset[p.a._id] || { a: p.a, data: {} }).data[p.field] = p.to; });
      const extra = {};
      Object.keys(perAsset).forEach(id => {
        const { a, data } = perAsset[id];
        const changes = diffAssetFields(a, Object.assign({}, a, data), Object.keys(data));
        extra[id] = Object.assign({}, data, { updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        if (changes.length) extra[id].history = firebase.firestore.FieldValue.arrayUnion(historyEntry("update", changes.map(c => Object.assign(c, { label: c.label + " (AI)" }))));
      });
      await markCleaned(cleanBatch, extra);
      $("aiCleanOut").innerHTML = `<div class="pr-alert info">${esc(L("ai.clean.applied", { n: chosen.length }))}</div>`;
    } catch (e) {
      btn.disabled = false;
      alert(L("ai.err", { err: e.message }));
    }
  }

  /* ---------- Cấu hình ---------- */
  function renderUsage() { const el = $("aiUsage"); if (el) el.textContent = L("ai.cfg.usage", { n: usage.n, i: usage.i.toLocaleString(), o: usage.o.toLocaleString() }); }
  async function saveConfig() {
    const v = $("aiEndpointInput").value.trim().replace(/\/+$/, "");
    try {
      await db.collection("meta").doc("ai").set({ endpoint: v, updatedBy: typeof currentEmail !== "undefined" ? currentEmail : "", updatedAt: Date.now() }, { merge: true });
      metaEndpoint = v;
      try { localStorage.removeItem("aiEndpoint"); } catch (e) { /* bỏ qua */ }
      $("aiCfgStatus").textContent = L("ai.cfg.saved");
      refreshAvailability();
    } catch (e) { $("aiCfgStatus").textContent = L("ai.err", { err: e.message }); }
  }
  async function testConfig() {
    const v = $("aiEndpointInput").value.trim().replace(/\/+$/, "");
    const prev = localOverride();
    try {
      localStorage.setItem("aiEndpoint", v);
      const r = await call("ping", {});
      $("aiCfgStatus").textContent = L("ai.cfg.ok", { role: r.role, v: r.promptVersion });
    } catch (e) {
      $("aiCfgStatus").textContent = L("ai.err", { err: e.message });
    } finally {
      try { if (prev) localStorage.setItem("aiEndpoint", prev); else localStorage.removeItem("aiEndpoint"); } catch (e) { /* bỏ qua */ }
    }
  }
  let unsubMeta = null;
  function watchMeta() {
    if (unsubMeta) { unsubMeta(); unsubMeta = null; }
    if (!["admin", "collector", "viewer"].includes(role())) { refreshAvailability(); return; }
    unsubMeta = db.collection("meta").doc("ai").onSnapshot(doc => {
      metaEndpoint = doc.exists ? String(doc.data().endpoint || "") : "";
      refreshAvailability();
    }, () => refreshAvailability());
  }

  /* ---------- Gắn sự kiện ---------- */
  $("aiChatForm").addEventListener("submit", e => {
    e.preventDefault();
    const v = $("aiChatInput").value; $("aiChatInput").value = "";
    sendChat(v);
  });
  $("aiChatInput").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("aiChatForm").requestSubmit(); } });
  $("aiNewChat").addEventListener("click", resetChat);
  $("aiSummaryBtn").addEventListener("click", runSummary);
  $("aiSummaryCopy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(lastSummaryText); } catch (e) { prompt("", lastSummaryText); } });
  $("aiDupBtn").addEventListener("click", renderDup);
  $("aiCleanBtn").addEventListener("click", runClean);
  $("aiCfgSave").addEventListener("click", saveConfig);
  $("aiCfgTest").addEventListener("click", testConfig);
  if ($("ticketAiParseBtn")) $("ticketAiParseBtn").addEventListener("click", ticketParse);
  if ($("ticketAiSuggestBtn")) $("ticketAiSuggestBtn").addEventListener("click", ticketSuggest);
  // Form ticket mới → xóa kết quả AI cũ.
  ["quickAddTicketBtn", "ticketsAddBtn", "resetTicketForm"].forEach(id => { const b = $(id); if (b) b.addEventListener("click", () => { if (tOut()) tOut().innerHTML = ""; if ($("ticketAiText")) $("ticketAiText").value = ""; }); });

  window.aiPageBlocked = name => name === "aiAssistant" && role() === "reportonly";
  window.onAiPage = function (name) {
    // Mở form ticket (tạo mới / xem ticket khác) → xóa kết quả AI của ticket trước.
    if (name === "ticketForm" && tOut()) { tOut().innerHTML = ""; if ($("ticketAiText")) $("ticketAiText").value = ""; }
    if (name !== "aiAssistant") return;
    refreshAvailability(); renderUsage();
    if (!chat.length) renderSamples();
  };
  if (typeof auth !== "undefined") auth.onAuthStateChanged(user => {
    if (!user) { if (unsubMeta) { unsubMeta(); unsubMeta = null; } metaEndpoint = ""; resetChat(); refreshAvailability(); return; }
    // Đợi app.js xác định vai trò (loadRole) xong rồi mới đọc meta/ai.
    let n = 0;
    const wait = () => { if (role() || n++ > 40) watchMeta(); else setTimeout(wait, 150); };
    wait();
  });
  refreshAvailability();

  window.AIX = { pure, ready, call, extractInvoice, liveData };
})();
