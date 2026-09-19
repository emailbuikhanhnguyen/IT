/* printers.js — Module "Máy in": theo dõi máy thuê & tự mua, nhà cung cấp
   (NCC), công nợ/thanh toán và lịch sử sửa chữa.

   Nạp SAU app.js (dùng lại các hàm/biến toàn cục của app.js: $, tr,
   escapeHtml, db, isAdmin/isViewer, goPage, setupAutocomplete, filterList,
   filterEmployeesBy, historyEntry, formatHistoryTime, assets, ticketRecords,
   currentEmail...). Chuỗi giao diện nằm ở printers-i18n.js.

   Dữ liệu (Firestore) — 3 collection, xem thêm firestore.rules:
   - printers/{mã máy in}        : 1 doc / máy in; lịch sử sửa chữa nằm trong
                                   field `repairs` (mảng), lịch sử thay đổi
                                   trong `history` — giống cách Tài sản/Dự án.
   - printer_vendors/{autoId}    : nhà cung cấp (cho thuê / sửa chữa / mực...).
   - printer_invoices/{autoId}   : hóa đơn phải trả NCC; các lần thanh toán
                                   nằm trong field `payments` (mảng). Công nợ
                                   = amount − tổng payments (luôn TỰ TÍNH, không
                                   lưu số dư để khỏi lệch).

   Phân quyền: chỉ Admin ghi; Viewer (Ban giám đốc) đọc; Collector không
   thấy module này (dữ liệu có giá thuê/công nợ). Enforce thật ở Rules. */
(function () {
  "use strict";

  const PRINTER_COLLECTION = "printers";
  const VENDOR_COLLECTION = "printer_vendors";
  const INVOICE_COLLECTION = "printer_invoices";
  const PRINTER_PAGES = ["printers", "printerList", "printerForm", "printerVendors", "vendorForm", "printerDebts", "invoiceForm"];
  const EXPIRING_DAYS = 60; // cảnh báo hợp đồng thuê còn <= N ngày
  const E = window.PR_ENUMS;

  let printerRecords = [];
  let vendorRecords = [];
  let invoiceRecords = [];
  let unsubs = [];

  const esc = s => escapeHtml(s);
  const canSee = () => !!(isAdmin || isViewer);

  /* ---------- Tiện ích ---------- */
  const pad = n => String(n).padStart(2, "0");
  function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function fmtDate(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || ""); }
  function daysDiff(fromStr, toStr) { return Math.round((Date.parse(toStr + "T00:00:00") - Date.parse(fromStr + "T00:00:00")) / 86400000); }
  function addDays(dateStr, n) { const d = new Date(dateStr + "T00:00:00"); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function money(n) { return (Number(n) || 0).toLocaleString("vi-VN") + " ₫"; }
  function num(v) { const n = parseFloat(v); return isFinite(n) && n > 0 ? n : 0; }
  function enumLabel(g, v) { const i = E[g].indexOf(v); return i >= 0 ? tr(`pr.${g}.${i}`) : (v || ""); }
  function ownIsRent(v) { return v === E.own[0]; }

  // Đổ danh sách option vào <select>, giữ lại giá trị đang chọn nếu vẫn còn.
  function setOptions(sel, items, keepValue) {
    if (!sel) return;
    const prev = keepValue === undefined ? sel.value : keepValue;
    sel.innerHTML = items.map(it => `<option value="${esc(it.value)}">${esc(it.label)}</option>`).join("");
    if (items.some(it => it.value === prev)) sel.value = prev;
  }
  const enumItems = g => E[g].map(v => ({ value: v, label: enumLabel(g, v) }));
  function vendorItems(placeholderKey) {
    const list = vendorRecords.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "", "vi"))
      .map(v => ({ value: v._id, label: v.name || v._id }));
    return [{ value: "", label: tr(placeholderKey) }].concat(list);
  }
  const vendorById = id => vendorRecords.find(v => v._id === id);
  function vendorNameOf(rec) { const v = rec && rec.vendorId ? vendorById(rec.vendorId) : null; return v ? v.name : ((rec && rec.vendorName) || ""); }
  const printerById = id => printerRecords.find(p => p._id === id);

  /* ---------- Công nợ: mọi số liệu đều tự tính từ amount & payments ---------- */
  const invPaid = i => (i.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const invRemaining = i => Math.max(0, (Number(i.amount) || 0) - invPaid(i));
  function invStatus(i) {
    if ((Number(i.amount) || 0) > 0 && invRemaining(i) <= 0) return E.is[2];
    return invPaid(i) > 0 ? E.is[1] : E.is[0];
  }
  const invOverdue = i => invRemaining(i) > 0 && !!i.dueDate && i.dueDate < todayStr();
  const vendorDebt = id => invoiceRecords.filter(i => i.vendorId === id).reduce((s, i) => s + invRemaining(i), 0);

  // Trạng thái hợp đồng thuê: "expired" | "expiring" | null
  function rentState(p) {
    if (!ownIsRent(p.ownership) || p.status === E.st[4] || !p.rentEnd) return null;
    const d = daysDiff(todayStr(), p.rentEnd);
    if (d < 0) return { state: "expired", days: d };
    if (d <= EXPIRING_DAYS) return { state: "expiring", days: d };
    return null;
  }

  function statusBadgeClass(st) {
    return { [E.st[0]]: "ok", [E.st[1]]: "info", [E.st[2]]: "warn", [E.st[3]]: "bad" }[st] || "";
  }

  /* ---------- Đồng bộ Firestore ---------- */
  window.initPrinterSync = function () {
    if (unsubs.length || !canSee()) return;
    const listen = (col, setter) => db.collection(col).onSnapshot(snap => {
      setter(snap.docs.map(d => Object.assign({ _id: d.id }, d.data())));
      window.renderPrinterAll();
    }, err => console.error("Printer sync error (" + col + "):", err));
    unsubs = [
      listen(PRINTER_COLLECTION, a => { printerRecords = a; }),
      listen(VENDOR_COLLECTION, a => { vendorRecords = a; }),
      listen(INVOICE_COLLECTION, a => { invoiceRecords = a; })
    ];
  };
  window.stopPrinterSync = function () {
    unsubs.forEach(u => u());
    unsubs = [];
    printerRecords = []; vendorRecords = []; invoiceRecords = [];
  };
  window.printerPageBlocked = name => PRINTER_PAGES.indexOf(name) !== -1 && !canSee();
  window.onPrinterPage = function (name) {
    if (name !== "printerForm") stopPrinterScanner(); // rời form -> tắt camera
    if (PRINTER_PAGES.indexOf(name) === -1) return;
    renderPrinterAll();
  };

  /* ---------- Render tổng ---------- */
  function renderPrinterAll() {
    if (!canSee()) return;
    populateStaticSelects();
    renderHub();
    renderPrinterList();
    renderVendorList();
    renderDebtPage();
  }
  window.renderPrinterAll = renderPrinterAll;

  function populateStaticSelects() {
    setOptions($("prOwnership"), enumItems("own"));
    setOptions($("prType"), enumItems("pt"));
    setOptions($("prStatus"), enumItems("st"));
    setOptions($("prRepairKind"), enumItems("rk"));
    setOptions($("prVendorRole"), enumItems("vr"));
    setOptions($("prInvKind"), enumItems("ik"));
    setOptions($("prFilterOwn"), [{ value: "", label: tr("pr.filter.allOwn") }].concat(enumItems("own")));
    setOptions($("prFilterStatus"), [{ value: "", label: tr("pr.filter.allStatus") }].concat(enumItems("st")));
    setOptions($("prFilterVendor"), vendorItems("pr.filter.allVendor"));
    setOptions($("prVendor"), vendorItems("pr.f.selectVendor"));
    setOptions($("prRepairVendor"), vendorItems("pr.f.selectVendor"));
    setOptions($("prInvVendor"), vendorItems("pr.f.selectVendor"));
    setOptions($("prInvFilterVendor"), vendorItems("pr.filter.allVendor"));
    setOptions($("prInvFilterStatus"), [
      { value: "", label: tr("pr.d.filter.allPay") },
      { value: "open", label: tr("pr.d.filter.open") },
      { value: "overdue", label: tr("pr.d.filter.overdue") }
    ].concat(E.is.map(v => ({ value: v, label: enumLabel("is", v) }))));
    setOptions($("prInvPrinter"), [{ value: "", label: tr("pr.i.noPrinter") }].concat(
      printerRecords.slice().sort((a, b) => (a.code || "").localeCompare(b.code || ""))
        .map(p => ({ value: p._id, label: `${p.code}${p.model ? " — " + p.model : ""}` }))));
  }

  /* ---------- Trang tổng quan ---------- */
  function renderHub() {
    if (!$("prStatTotal")) return;
    const rent = printerRecords.filter(p => ownIsRent(p.ownership)).length;
    const expiring = printerRecords.filter(p => rentState(p)).length;
    const debt = invoiceRecords.reduce((s, i) => s + invRemaining(i), 0);
    const overdue = invoiceRecords.filter(invOverdue).reduce((s, i) => s + invRemaining(i), 0);
    $("prStatTotal").textContent = printerRecords.length;
    $("prStatRent").textContent = rent;
    $("prStatOwn").textContent = printerRecords.length - rent;
    $("prStatExpiring").textContent = expiring;
    $("prStatDebt").textContent = money(debt);
    $("prStatOverdue").textContent = money(overdue);
    ["prStatDebt", "prStatOverdue"].forEach(id => $(id).classList.add("pr-money-stat"));

    const alerts = [];
    printerRecords.forEach(p => {
      const rs = rentState(p);
      if (!rs) return;
      alerts.push({
        sort: rs.days, cls: rs.state === "expired" ? "bad" : "warn",
        text: rs.state === "expired"
          ? tr("pr.alert.expired", { code: p.code, date: fmtDate(p.rentEnd) })
          : tr("pr.alert.expiring", { code: p.code, date: fmtDate(p.rentEnd), days: rs.days }),
        click: `prOpenPrinter('${p._id}')`
      });
    });
    invoiceRecords.filter(invOverdue).forEach(i => {
      const days = daysDiff(i.dueDate, todayStr());
      alerts.push({
        sort: -days, cls: "bad",
        text: tr("pr.alert.overdue", { no: i.invoiceNo || i._id.slice(0, 6), vendor: vendorNameOf(i), days, amount: money(invRemaining(i)) }),
        click: `prOpenInvoice('${i._id}')`
      });
    });
    alerts.sort((a, b) => a.sort - b.sort);
    $("prAlerts").innerHTML = alerts.length
      ? alerts.slice(0, 12).map(a => `<div class="pr-alert ${a.cls}" onclick="${a.click}">${esc(a.text)}</div>`).join("")
      : `<div class="muted">${tr("pr.alerts.none")}</div>`;
  }

  /* ---------- Danh sách máy in ---------- */
  function printerRepairTotal(p) { return (p.repairs || []).reduce((s, r) => s + (Number(r.cost) || 0), 0); }

  function renderPrinterList() {
    const box = $("prListBox");
    if (!box) return;
    const q = ($("prSearch").value || "").trim().toLowerCase();
    const ownF = $("prFilterOwn").value, stF = $("prFilterStatus").value, vF = $("prFilterVendor").value;
    let list = printerRecords.slice().sort((a, b) => (a.code || "").localeCompare(b.code || "", undefined, { numeric: true }));
    if (q) list = list.filter(p => [p.code, p.brand, p.model, p.serial, p.section, p.location, p.ip, vendorNameOf(p), p.contractNo].some(v => (v || "").toLowerCase().includes(q)));
    if (ownF) list = list.filter(p => p.ownership === ownF);
    if (stF) list = list.filter(p => p.status === stF);
    if (vF) list = list.filter(p => p.vendorId === vF);
    if (!list.length) { box.innerHTML = `<div class="empty">${tr("pr.none")}</div>`; return; }
    box.innerHTML = list.map(p => {
      const rent = ownIsRent(p.ownership);
      const rs = rentState(p);
      const repairs = (p.repairs || []).length;
      const editBtn = `<button onclick="prOpenPrinter('${p._id}')">${isAdmin ? "✎ " + tr("action.edit") : "👁 " + tr("action.view")}</button>`;
      const delBtn = isAdmin ? `<button class="secondary" onclick="prDeletePrinter('${p._id}')">🗑 ${tr("action.delete")}</button>` : "";
      return `<div class="asset">
        <div>
          <h3>${esc(p.code)}${p.brand || p.model ? " — " + esc((p.brand || "") + " " + (p.model || "")) : ""}</h3>
          <div class="muted">${esc(enumLabel("pt", p.type))}${p.serial ? " · S/N " + esc(p.serial) : ""}</div>
          <div class="muted">${p.section ? "🏢 " + esc(p.section) : ""}${p.location ? " · 📍 " + esc(p.location) : ""}${p.ip ? " · 🌐 " + esc(p.ip) : ""}</div>
          ${vendorNameOf(p) ? `<div class="muted">🤝 ${esc(vendorNameOf(p))}</div>` : ""}
          ${rent ? `<div class="muted">📄 ${p.monthlyFee ? esc(tr("pr.card.rentFee", { fee: money(p.monthlyFee) })) : ""}${p.rentEnd ? " · " + esc(tr("pr.card.until", { date: fmtDate(p.rentEnd) })) : ""}${p.contractNo ? " · " + esc(p.contractNo) : ""}</div>` : ""}
          ${repairs ? `<div class="muted">🔧 ${esc(tr("pr.card.repairCount", { count: repairs }))} · ${esc(tr("pr.card.repairCost", { amount: money(printerRepairTotal(p)) }))}</div>` : ""}
          <span class="badge ${rent ? "info" : "ok"}">${esc(enumLabel("own", p.ownership))}</span>
          <span class="badge ${statusBadgeClass(p.status)}">${esc(enumLabel("st", p.status))}</span>
          ${rs ? `<span class="badge ${rs.state === "expired" ? "bad" : "warn"}">⚠ ${tr(rs.state === "expired" ? "pr.card.expired" : "pr.card.expiring")}</span>` : ""}
          ${!isAdmin ? `<span class="badge view-only-tag">👁 ${tr("action.viewOnly")}</span>` : ""}
        </div>
        <div class="asset-actions">${editBtn}${delBtn}</div>
      </div>`;
    }).join("");
  }
  ["prSearch"].forEach(id => $(id).addEventListener("input", renderPrinterList));
  ["prFilterOwn", "prFilterStatus", "prFilterVendor"].forEach(id => $(id).addEventListener("change", renderPrinterList));

  /* ---------- Form máy in ---------- */
  let currentRepairs = [];
  const PRINTER_FIELD_LABELS = () => [
    ["ownership", tr("pr.f.ownership")], ["brand", tr("pr.f.brand")], ["model", tr("pr.f.model")], ["serial", tr("pr.f.serial")],
    ["type", tr("pr.f.type")], ["status", tr("pr.f.status")], ["section", tr("pr.f.section")], ["location", tr("pr.f.location")],
    ["ip", tr("pr.f.ip")], ["assetCode", tr("pr.f.asset")], ["vendorName", tr("pr.f.vendor")],
    ["purchaseDate", tr("pr.f.purchaseDate")], ["purchasePrice", tr("pr.f.purchasePrice")], ["warrantyEnd", tr("pr.f.warrantyEnd")],
    ["contractNo", tr("pr.f.contractNo")], ["rentStart", tr("pr.f.rentStart")], ["rentEnd", tr("pr.f.rentEnd")],
    ["monthlyFee", tr("pr.f.monthlyFee")], ["includedPages", tr("pr.f.includedPages")], ["extraPageFee", tr("pr.f.extraPageFee")],
    ["note", tr("pr.f.note")]
  ].map(([k, l]) => [k, l.replace("*", "").replace(/（可选）| \(optional\)| \(không bắt buộc\)/, "")]);

  function diffPrinter(oldP, data) {
    const changes = [];
    PRINTER_FIELD_LABELS().forEach(([key, label]) => {
      const ov = ((oldP && oldP[key] != null) ? oldP[key] : "").toString().trim();
      const nv = ((data && data[key] != null) ? data[key] : "").toString().trim();
      if (ov !== nv && !(ov === "0" && nv === "") && !(ov === "" && nv === "0")) changes.push({ field: key, label, from: ov, to: nv });
    });
    const oc = ((oldP && oldP.repairs) || []).length, nc = (data.repairs || []).length;
    if (oc !== nc) changes.push({ field: "repairs", label: tr("pr.rp.title").replace(/^[^\p{L}]+/u, ""), from: String(oc), to: String(nc) });
    return changes;
  }

  function renderHistoryInto(boxId, listId, entries) {
    const box = $(boxId), list = $(listId);
    if (!box || !list) return;
    const sorted = (entries || []).slice().sort((x, y) => (y.at || 0) - (x.at || 0));
    if (!sorted.length) { box.classList.add("hidden"); list.innerHTML = ""; return; }
    box.classList.remove("hidden");
    list.innerHTML = sorted.map(e => {
      const ch = (e.changes || []).map(c => {
        const f = c.from ? esc(c.from) : "<i>(" + tr("common.empty") + ")</i>";
        const t = c.to ? esc(c.to) : "<i>(" + tr("common.empty") + ")</i>";
        return `<div class="history-change"><b>${esc(c.label)}:</b> ${f} → ${t}</div>`;
      }).join("");
      return `<div class="history-entry"><div class="history-head">
        <span class="history-action">${esc(HISTORY_ACTION_LABEL[e.action] || e.action || "")}</span>
        <span class="muted">${formatHistoryTime(e.at)} · ${esc(e.by || "")}</span></div>
        ${ch || '<div class="history-change muted">' + tr("history.noChanges") + "</div>"}</div>`;
    }).join("");
  }

  function setFormLocked(formId, noticeId, locked) {
    $(formId).querySelectorAll("input, select, textarea, button").forEach(el => { el.disabled = locked; });
    $(noticeId).classList.toggle("hidden", !locked);
  }

  function applyOwnershipVisibility() {
    const rent = ownIsRent($("prOwnership").value);
    document.querySelectorAll(".pr-rent-only").forEach(el => el.classList.toggle("hidden", !rent));
    document.querySelectorAll(".pr-own-only").forEach(el => el.classList.toggle("hidden", rent));
  }
  $("prOwnership").addEventListener("change", applyOwnershipVisibility);

  function nextPrinterCode() {
    let max = 0;
    printerRecords.forEach(p => { const m = /^MI-(\d+)$/i.exec(p.code || ""); if (m) max = Math.max(max, parseInt(m[1], 10)); });
    return "MI-" + String(max + 1).padStart(4, "0");
  }

  function renderRepairList() {
    const box = $("prRepairList");
    if (!currentRepairs.length) { box.innerHTML = `<div class="muted" style="padding:4px 0 10px">${tr("pr.rp.none")}</div>`; return; }
    const total = currentRepairs.reduce((s, r) => s + (Number(r.cost) || 0), 0);
    const rows = currentRepairs.map((r, i) => ({ r, i })).sort((a, b) => (b.r.date || "").localeCompare(a.r.date || "") || (b.r.at || 0) - (a.r.at || 0));
    box.innerHTML = `<div class="pr-summary">${esc(tr("pr.rp.total", { amount: money(total), count: currentRepairs.length }))}</div>` +
      rows.map(({ r, i }) => `<div class="history-entry">
        <div class="history-head">
          <span><b>${esc(fmtDate(r.date))}</b> · ${esc(enumLabel("rk", r.kind))}${r.cost ? " · " + esc(money(r.cost)) : ""}</span>
          <button type="button" class="secondary admin-only" style="padding:3px 8px;font-size:11px" onclick="prRemoveRepair(${i})">🗑</button>
        </div>
        <div class="history-change">${esc(r.description || "")}</div>
        <div class="muted">${r.vendorId || r.vendorName ? "🤝 " + esc(vendorNameOf(r)) : ""}${r._makeInvoice ? " · 💳 " + tr("pr.rp.invoiceQueued") : (r.invoiceId ? " · 💳 " + tr("pr.rp.invoiceLinked") : "")}${r.by ? " · " + esc(r.by) : ""}</div>
      </div>`).join("");
  }
  window.prRemoveRepair = function (i) { currentRepairs.splice(i, 1); renderRepairList(); };

  $("prRepairAddBtn").addEventListener("click", () => {
    const description = $("prRepairDesc").value.trim();
    if (!description) { alert(tr("pr.rp.needDesc")); return; }
    const cost = num($("prRepairCost").value);
    const vendorId = $("prRepairVendor").value;
    const makeInvoice = $("prRepairMakeInvoice").checked;
    if (makeInvoice && (!vendorId || cost <= 0)) { alert(tr("pr.rp.needVendorForInvoice")); return; }
    const entry = {
      id: Date.now().toString(36), at: Date.now(), by: currentEmail || "?",
      date: $("prRepairDate").value || todayStr(), kind: $("prRepairKind").value, description, cost,
      vendorId, vendorName: vendorId ? (vendorById(vendorId) || {}).name || "" : ""
    };
    if (makeInvoice) entry._makeInvoice = true;
    currentRepairs.push(entry);
    $("prRepairDesc").value = ""; $("prRepairCost").value = ""; $("prRepairMakeInvoice").checked = false;
    $("prRepairDate").value = todayStr();
    renderRepairList();
  });

  function renderRelatedTickets(p) {
    const box = $("prTicketList");
    if (!p || !p._id) { box.innerHTML = `<div class="muted">${tr("pr.tk.none")}</div>`; return; }
    const code = (p.code || "").toLowerCase();
    const list = ticketRecords.filter(t => (p.assetCode && t.assetCode === p.assetCode) || (code && (t.device || "").toLowerCase().includes(code)))
      .sort((a, b) => (b.ticketId || "").localeCompare(a.ticketId || ""));
    if (!list.length) { box.innerHTML = `<div class="muted">${tr("pr.tk.none")}</div>`; return; }
    box.innerHTML = list.slice(0, 20).map(t => `<div class="attach-item">
      <div><b>${esc(t.ticketId)}</b> <span class="badge ${ticketBadgeClass(t.status)}">${esc(ticketStatusLabel(t.status))}</span>
        <div class="attach-meta">${esc((t.description || "").slice(0, 120))}</div></div>
      <button type="button" class="secondary" onclick="editTicket('${t._id}')">${tr("pr.tk.open")}</button></div>`).join("");
  }

  function clearPrinterForm() {
    $("prFormEl").reset();
    ["prDocId", "prAssetId"].forEach(id => { $(id).value = ""; });
    populateStaticSelects();
    $("prFormTitle").textContent = tr("pr.form.create");
    $("prCode").readOnly = false;
    $("prCode").value = nextPrinterCode();
    currentRepairs = [];
    renderRepairList();
    $("prRepairDate").value = todayStr();
    renderRelatedTickets(null);
    $("prHistoryBox").classList.add("hidden");
    $("prHistoryList").innerHTML = "";
    ["prSectionSuggest", "prAssetSuggest"].forEach(id => { $(id).classList.add("hidden"); $(id).innerHTML = ""; });
    applyOwnershipVisibility();
    setFormLocked("prFormEl", "prLockedNotice", false);
    stopPrinterScanner(); $("prScanResult").classList.add("hidden"); $("prScanResult").innerHTML = "";
  }
  $("prResetBtn").addEventListener("click", clearPrinterForm);
  $("prAddBtn").addEventListener("click", clearPrinterForm);

  function fillPrinterForm(p) {
    populateStaticSelects();
    $("prDocId").value = p._id;
    $("prCode").value = p.code || "";
    $("prCode").readOnly = true;
    $("prOwnership").value = p.ownership || E.own[0];
    $("prBrand").value = p.brand || ""; $("prModel").value = p.model || ""; $("prSerial").value = p.serial || "";
    $("prType").value = p.type || E.pt[0]; $("prStatus").value = p.status || E.st[0];
    $("prSection").value = p.section || ""; $("prLocation").value = p.location || ""; $("prIp").value = p.ip || "";
    $("prAssetId").value = p.assetId || ""; $("prAssetCode").value = p.assetCode || "";
    $("prVendor").value = p.vendorId || "";
    $("prPurchaseDate").value = p.purchaseDate || ""; $("prPurchasePrice").value = p.purchasePrice || "";
    $("prWarrantyEnd").value = p.warrantyEnd || "";
    $("prContractNo").value = p.contractNo || ""; $("prRentStart").value = p.rentStart || ""; $("prRentEnd").value = p.rentEnd || "";
    $("prMonthlyFee").value = p.monthlyFee || ""; $("prIncludedPages").value = p.includedPages || ""; $("prExtraPageFee").value = p.extraPageFee || "";
    $("prNote").value = p.note || "";
    currentRepairs = Array.isArray(p.repairs) ? p.repairs.map(r => Object.assign({}, r)) : [];
    renderRepairList();
    $("prRepairDate").value = todayStr();
    renderRelatedTickets(p);
    renderHistoryInto("prHistoryBox", "prHistoryList", p.history);
    $("prFormTitle").textContent = tr("pr.form.edit", { id: p.code || "" });
    applyOwnershipVisibility();
    setFormLocked("prFormEl", "prLockedNotice", !isAdmin);
    stopPrinterScanner(); $("prScanResult").classList.add("hidden"); $("prScanResult").innerHTML = "";
  }
  window.prOpenPrinter = function (id) {
    const p = printerById(id);
    if (!p) return;
    fillPrinterForm(p);
    goPage("printerForm");
  };
  window.prDeletePrinter = function (id) {
    if (!isAdmin) return;
    const p = printerById(id);
    if (!p || !confirm(tr("pr.msg.confirmDelete", { id: p.code }))) return;
    db.collection(PRINTER_COLLECTION).doc(id).delete().catch(err => alert(tr("pr.msg.errDelete", { err: err.message })));
  };

  // Gõ tay vào ô "Liên kết tài sản" thì hủy liên kết cũ (giống form Ticket).
  $("prAssetCode").addEventListener("input", () => { $("prAssetId").value = ""; });
  setupAutocomplete("prAssetCode", "prAssetSuggest",
    q => {
      const s = q.trim().toLowerCase();
      const pool = s ? assets : assets.filter(a => a.type === "Máy in");
      return pool.filter(a => !s || [a.code, a.model, a.serial, a.deviceName, a.user].some(v => (v || "").toLowerCase().includes(s))).slice(0, 50);
    },
    a => `${esc(a.code)}<span class="muted">${esc(a.type || "")}${a.model ? " · " + esc(a.model) : ""}${a.serial ? " · " + esc(a.serial) : ""}</span>`,
    a => {
      $("prAssetCode").value = a.code; $("prAssetId").value = a._id;
      if (!$("prModel").value.trim()) $("prModel").value = a.model || "";
      if (!$("prSerial").value.trim()) $("prSerial").value = a.serial || "";
      if (!$("prIp").value.trim()) $("prIp").value = a.ip || "";
      if (!$("prSection").value.trim()) $("prSection").value = a.section || "";
    });
  setupAutocomplete("prSection", "prSectionSuggest",
    q => filterList(Array.from(new Set((window.EMPLOYEES || []).map(e => e.section).filter(Boolean))), q, 100).map(v => ({ value: v })),
    it => esc(it.value), it => { $("prSection").value = it.value; });

  $("prAddVendorLink").addEventListener("click", e => { e.preventDefault(); clearVendorForm(); goPage("vendorForm"); });

  $("prFormEl").addEventListener("submit", e => {
    e.preventDefault();
    if (!isAdmin) { alert(tr("pr.msg.noPerm")); return; }
    const code = $("prCode").value.trim();
    if (!code) { alert(tr("pr.msg.needCode")); return; }
    const id = sanitizeId(code);
    const oldId = $("prDocId").value;
    const oldP = oldId ? printerById(oldId) : null;
    if (!oldId && printerById(id)) { alert(tr("pr.msg.dupCode", { id: code })); return; }

    const rent = ownIsRent($("prOwnership").value);
    const vendorId = $("prVendor").value;
    const asset = $("prAssetId").value ? assets.find(a => a._id === $("prAssetId").value) : null;
    const data = {
      code, ownership: $("prOwnership").value,
      brand: $("prBrand").value.trim(), model: $("prModel").value.trim(), serial: $("prSerial").value.trim(),
      type: $("prType").value, status: $("prStatus").value,
      section: $("prSection").value.trim(), location: $("prLocation").value.trim(), ip: $("prIp").value.trim(),
      assetId: asset ? asset._id : "", assetCode: asset ? asset.code : $("prAssetCode").value.trim(),
      vendorId, vendorName: vendorId ? (vendorById(vendorId) || {}).name || "" : "",
      purchaseDate: rent ? "" : $("prPurchaseDate").value, purchasePrice: rent ? 0 : num($("prPurchasePrice").value),
      warrantyEnd: rent ? "" : $("prWarrantyEnd").value,
      contractNo: rent ? $("prContractNo").value.trim() : "", rentStart: rent ? $("prRentStart").value : "", rentEnd: rent ? $("prRentEnd").value : "",
      monthlyFee: rent ? num($("prMonthlyFee").value) : 0, includedPages: rent ? num($("prIncludedPages").value) : 0,
      extraPageFee: rent ? num($("prExtraPageFee").value) : 0,
      note: $("prNote").value.trim(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    // Lần sửa chữa có tick "Ghi nhận công nợ" -> tạo hóa đơn cùng lúc (1 batch).
    const batch = db.batch();
    const repairs = currentRepairs.map(r => Object.assign({}, r));
    repairs.forEach(r => {
      if (!r._makeInvoice) return;
      const v = vendorById(r.vendorId);
      const ref = db.collection(INVOICE_COLLECTION).doc();
      const date = r.date || todayStr();
      batch.set(ref, {
        vendorId: r.vendorId, vendorName: v ? v.name : (r.vendorName || ""), printerId: id, printerCode: code,
        kind: r.kind === E.rk[3] ? E.ik[2] : E.ik[1], invoiceNo: "", invoiceDate: date, period: date.slice(0, 7),
        dueDate: addDays(date, v && v.paymentTerms != null ? Number(v.paymentTerms) : 30),
        amount: Number(r.cost) || 0, note: r.description || "", payments: [], source: "repair",
        createdBy: currentEmail || "?", createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      r.invoiceId = ref.id;
      delete r._makeInvoice;
    });
    data.repairs = repairs;

    const changes = diffPrinter(oldP, data);
    if (!oldId || changes.length) {
      data.history = firebase.firestore.FieldValue.arrayUnion(historyEntry(oldId ? "update" : "create", changes));
    }
    if (!oldId) data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    batch.set(db.collection(PRINTER_COLLECTION).doc(id), data, { merge: true });

    const btn = $("prSubmitBtn"), label = btn.textContent;
    btn.disabled = true; btn.textContent = tr("common.saving");
    // Ghi ngay vào bộ nhớ offline của Firestore; UI chuyển trang luôn (giống
    // form Dự án) — lỗi máy chủ (nếu có) báo bằng alert.
    batch.commit().catch(err => alert(tr("pr.msg.errSave", { err: err.message }) + "\n\n" + tr("msg.errSyncServerHint")));
    setTimeout(() => {
      btn.disabled = false; btn.textContent = label;
      $("prDocId").value = id;
      goPage("printerList");
    }, 150);
  });

  /* ---------- Nhà cung cấp ---------- */
  function renderVendorList() {
    const box = $("prVendorListBox");
    if (!box) return;
    const q = ($("prVendorSearch").value || "").trim().toLowerCase();
    let list = vendorRecords.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "", "vi"));
    if (q) list = list.filter(v => [v.name, v.contact, v.phone, v.email, v.taxCode].some(x => (x || "").toLowerCase().includes(q)));
    if (!list.length) { box.innerHTML = `<div class="empty">${tr("pr.v.none")}</div>`; return; }
    box.innerHTML = list.map(v => {
      const debt = vendorDebt(v._id);
      const pc = printerRecords.filter(p => p.vendorId === v._id).length;
      return `<div class="asset">
        <div>
          <h3>${esc(v.name)}</h3>
          <div class="muted">${esc(enumLabel("vr", v.role))}${v.contact ? " · 👤 " + esc(v.contact) : ""}${v.phone ? " · 📞 " + esc(v.phone) : ""}</div>
          <div class="muted">🖨 ${esc(tr("pr.v.printers", { count: pc }))}</div>
          <span class="badge ${debt > 0 ? "warn" : "ok"}">${esc(tr("pr.v.debt", { amount: money(debt) }))}</span>
        </div>
        <div class="asset-actions">
          <button onclick="prOpenVendor('${v._id}')">${isAdmin ? "✎ " + tr("action.edit") : "👁 " + tr("action.view")}</button>
          ${isAdmin ? `<button class="secondary" onclick="prDeleteVendor('${v._id}')">🗑 ${tr("action.delete")}</button>` : ""}
        </div>
      </div>`;
    }).join("");
  }
  $("prVendorSearch").addEventListener("input", renderVendorList);

  function renderVendorRelated(v) {
    const box = $("prVendorRelated");
    if (!v) { box.innerHTML = ""; return; }
    const ps = printerRecords.filter(p => p.vendorId === v._id);
    const inv = invoiceRecords.filter(i => i.vendorId === v._id).sort((a, b) => (b.invoiceDate || "").localeCompare(a.invoiceDate || "")).slice(0, 15);
    box.innerHTML =
      `<div class="pr-summary">${esc(tr("pr.v.debt", { amount: money(vendorDebt(v._id)) }))}</div>` +
      (ps.length ? `<h3 class="subhead">${tr("pr.v.printersHead")}</h3>` + ps.map(p => `<div class="attach-item"><div><b>${esc(p.code)}</b> ${esc((p.brand || "") + " " + (p.model || ""))}
        <div class="attach-meta">${esc(enumLabel("own", p.ownership))} · ${esc(enumLabel("st", p.status))}</div></div>
        <button type="button" class="secondary" onclick="prOpenPrinter('${p._id}')">${tr("pr.tk.open")}</button></div>`).join("") : "") +
      (inv.length ? `<h3 class="subhead">${tr("pr.v.invoicesHead")}</h3>` + inv.map(i => `<div class="attach-item"><div><b>${esc(i.invoiceNo || i._id.slice(0, 6))}</b> · ${esc(money(i.amount))}
        <div class="attach-meta">${esc(enumLabel("is", invStatus(i)))} · ${esc(tr("pr.d.remaining", { amount: money(invRemaining(i)) }))}</div></div>
        <button type="button" class="secondary" onclick="prOpenInvoice('${i._id}')">${tr("pr.tk.open")}</button></div>`).join("") : "");
  }

  function clearVendorForm() {
    $("prVendorFormEl").reset();
    $("prVendorDocId").value = "";
    populateStaticSelects();
    $("prVendorTerms").value = 30;
    $("prVendorFormTitle").textContent = tr("pr.v.createTitle");
    renderVendorRelated(null);
    setFormLocked("prVendorFormEl", "prVendorLockedNotice", false);
  }
  $("prVendorResetBtn").addEventListener("click", clearVendorForm);
  $("prVendorAddBtn").addEventListener("click", clearVendorForm);

  window.prOpenVendor = function (id) {
    const v = vendorById(id);
    if (!v) return;
    populateStaticSelects();
    $("prVendorDocId").value = v._id;
    $("prVendorName").value = v.name || ""; $("prVendorRole").value = v.role || E.vr[0];
    $("prVendorContact").value = v.contact || ""; $("prVendorPhone").value = v.phone || ""; $("prVendorEmail").value = v.email || "";
    $("prVendorAddress").value = v.address || ""; $("prVendorTax").value = v.taxCode || "";
    $("prVendorTerms").value = v.paymentTerms != null ? v.paymentTerms : 30;
    $("prVendorNote").value = v.note || "";
    $("prVendorFormTitle").textContent = tr("pr.v.editTitle", { name: v.name || "" });
    renderVendorRelated(v);
    setFormLocked("prVendorFormEl", "prVendorLockedNotice", !isAdmin);
    goPage("vendorForm");
  };
  window.prDeleteVendor = function (id) {
    if (!isAdmin) return;
    const v = vendorById(id);
    if (!v) return;
    const pc = printerRecords.filter(p => p.vendorId === id).length;
    const ic = invoiceRecords.filter(i => i.vendorId === id).length;
    if (pc || ic) { alert(tr("pr.v.inUse", { printers: pc, invoices: ic })); return; }
    if (!confirm(tr("pr.v.confirmDelete", { name: v.name }))) return;
    db.collection(VENDOR_COLLECTION).doc(id).delete().catch(err => alert(tr("pr.msg.errDelete", { err: err.message })));
  };
  $("prVendorFormEl").addEventListener("submit", e => {
    e.preventDefault();
    if (!isAdmin) { alert(tr("pr.msg.noPerm")); return; }
    const name = $("prVendorName").value.trim();
    if (!name) { alert(tr("pr.v.needName")); return; }
    const id = $("prVendorDocId").value || db.collection(VENDOR_COLLECTION).doc().id;
    const terms = parseInt($("prVendorTerms").value, 10);
    const data = {
      name, role: $("prVendorRole").value, contact: $("prVendorContact").value.trim(), phone: $("prVendorPhone").value.trim(),
      email: $("prVendorEmail").value.trim(), address: $("prVendorAddress").value.trim(), taxCode: $("prVendorTax").value.trim(),
      paymentTerms: isFinite(terms) && terms >= 0 ? terms : 30, note: $("prVendorNote").value.trim(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (!$("prVendorDocId").value) data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    db.collection(VENDOR_COLLECTION).doc(id).set(data, { merge: true })
      .catch(err => alert(tr("pr.msg.errSave", { err: err.message }) + "\n\n" + tr("msg.errSyncServerHint")));
    // Quay về form máy in nếu vừa bấm "＋ Thêm NCC mới" từ đó? Đơn giản: về danh sách NCC.
    setTimeout(() => { $("prVendorDocId").value = id; goPage("printerVendors"); }, 150);
  });

  /* ---------- Công nợ & hóa đơn ---------- */
  let debtVendorFilter = "";
  function renderDebtPage() {
    const box = $("prInvoiceListBox");
    if (!box) return;
    const openList = invoiceRecords.filter(i => invRemaining(i) > 0);
    $("prDebtTotal").textContent = money(openList.reduce((s, i) => s + invRemaining(i), 0));
    $("prDebtOverdue").textContent = money(openList.filter(invOverdue).reduce((s, i) => s + invRemaining(i), 0));
    ["prDebtTotal", "prDebtOverdue"].forEach(id => $(id).classList.add("pr-money-stat"));

    // Công nợ theo NCC (bấm để lọc)
    const byV = {};
    openList.forEach(i => { byV[i.vendorId] = (byV[i.vendorId] || 0) + invRemaining(i); });
    const rows = Object.keys(byV).sort((a, b) => byV[b] - byV[a]);
    $("prDebtByVendor").innerHTML = rows.length
      ? rows.map(id => `<div class="pr-vrow ${debtVendorFilter === id ? "active" : ""}" onclick="prFilterVendorDebt('${id}')"><span>${esc(vendorNameOf({ vendorId: id, vendorName: (invoiceRecords.find(i => i.vendorId === id) || {}).vendorName }) || "?")}</span><b>${esc(money(byV[id]))}</b></div>`).join("")
      : `<div class="muted">${tr("pr.d.none")}</div>`;

    const q = ($("prInvSearch").value || "").trim().toLowerCase();
    const vF = $("prInvFilterVendor").value, sF = $("prInvFilterStatus").value;
    let list = invoiceRecords.slice();
    if (q) list = list.filter(i => [i.invoiceNo, vendorNameOf(i), i.printerCode, i.note, i.period].some(v => (v || "").toLowerCase().includes(q)));
    if (vF) list = list.filter(i => i.vendorId === vF);
    if (sF === "open") list = list.filter(i => invRemaining(i) > 0);
    else if (sF === "overdue") list = list.filter(invOverdue);
    else if (sF) list = list.filter(i => invStatus(i) === sF);
    // Còn nợ lên trước (hạn gần nhất trước), đã trả xong xuống cuối.
    list.sort((a, b) => {
      const ao = invRemaining(a) > 0, bo = invRemaining(b) > 0;
      if (ao !== bo) return ao ? -1 : 1;
      return ao ? (a.dueDate || "9999").localeCompare(b.dueDate || "9999") : (b.invoiceDate || "").localeCompare(a.invoiceDate || "");
    });
    if (!list.length) { box.innerHTML = `<div class="empty">${tr("pr.d.none")}</div>`; return; }
    box.innerHTML = list.map(i => {
      const st = invStatus(i), od = invOverdue(i);
      return `<div class="asset">
        <div>
          <h3>${esc(i.invoiceNo || "#" + i._id.slice(0, 6))} — ${esc(vendorNameOf(i))}</h3>
          <div class="muted">${esc(enumLabel("ik", i.kind))}${i.printerCode ? " · 🖨 " + esc(i.printerCode) : ""}${i.period ? " · " + esc(i.period) : ""}</div>
          <div class="muted">${esc(tr("pr.d.paid", { paid: money(invPaid(i)), amount: money(i.amount) }))}${i.dueDate ? " · " + esc(tr("pr.d.due", { date: fmtDate(i.dueDate) })) : ""}</div>
          ${i.note ? `<div class="muted">${esc(i.note)}</div>` : ""}
          <span class="badge ${st === E.is[2] ? "ok" : st === E.is[1] ? "info" : "warn"}">${esc(enumLabel("is", st))}</span>
          ${invRemaining(i) > 0 ? `<span class="badge warn">${esc(tr("pr.d.remaining", { amount: money(invRemaining(i)) }))}</span>` : ""}
          ${od ? `<span class="badge bad">⚠ ${esc(tr("pr.d.overdueBy", { days: daysDiff(i.dueDate, todayStr()) }))}</span>` : ""}
        </div>
        <div class="asset-actions">
          <button onclick="prOpenInvoice('${i._id}')">${isAdmin ? "💰 " + tr("action.edit") : "👁 " + tr("action.view")}</button>
          ${isAdmin ? `<button class="secondary" onclick="prDeleteInvoice('${i._id}')">🗑 ${tr("action.delete")}</button>` : ""}
        </div>
      </div>`;
    }).join("");
  }
  ["prInvSearch"].forEach(id => $(id).addEventListener("input", renderDebtPage));
  $("prInvFilterVendor").addEventListener("change", () => { debtVendorFilter = $("prInvFilterVendor").value; renderDebtPage(); });
  $("prInvFilterStatus").addEventListener("change", renderDebtPage);
  window.prFilterVendorDebt = function (id) {
    debtVendorFilter = debtVendorFilter === id ? "" : id;
    $("prInvFilterVendor").value = debtVendorFilter;
    renderDebtPage();
  };

  let currentPayments = [];
  let dueAutoFilled = true;
  function suggestDue() {
    if (!dueAutoFilled || $("prInvoiceDocId").value) return;
    const v = vendorById($("prInvVendor").value), d = $("prInvDate").value;
    if (!d) return;
    $("prInvDue").value = addDays(d, v && v.paymentTerms != null ? Number(v.paymentTerms) : 30);
  }
  $("prInvDue").addEventListener("input", () => { dueAutoFilled = false; });
  $("prInvVendor").addEventListener("change", suggestDue);
  $("prInvDate").addEventListener("change", () => { if (!$("prInvPeriod").value && $("prInvDate").value) $("prInvPeriod").value = $("prInvDate").value.slice(0, 7); suggestDue(); });

  function renderPayments() {
    const amount = num($("prInvAmount").value);
    const paid = currentPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    $("prInvSummary").textContent = tr("pr.i.summary", { amount: money(amount), paid: money(paid), remaining: money(Math.max(0, amount - paid)) });
    const box = $("prPaymentList");
    if (!currentPayments.length) { box.innerHTML = `<div class="muted" style="padding:4px 0 10px">${tr("pr.i.pay.none")}</div>`; return; }
    box.innerHTML = currentPayments.map((p, i) => ({ p, i })).sort((a, b) => (b.p.date || "").localeCompare(a.p.date || ""))
      .map(({ p, i }) => `<div class="history-entry"><div class="history-head">
        <span><b>${esc(fmtDate(p.date))}</b> · ${esc(money(p.amount))}</span>
        <button type="button" class="secondary admin-only" style="padding:3px 8px;font-size:11px" onclick="prRemovePayment(${i})">🗑</button></div>
        <div class="history-change">${esc(p.note || "")}</div>
        <div class="muted">${esc(p.by || "")}</div></div>`).join("");
  }
  $("prInvAmount").addEventListener("input", renderPayments);
  window.prRemovePayment = function (i) { currentPayments.splice(i, 1); renderPayments(); };
  $("prPayAddBtn").addEventListener("click", () => {
    const amount = num($("prPayAmount").value);
    if (amount <= 0) { alert(tr("pr.i.pay.needAmount")); return; }
    currentPayments.push({ id: Date.now().toString(36), date: $("prPayDate").value || todayStr(), amount, note: $("prPayNote").value.trim(), by: currentEmail || "?", at: Date.now() });
    $("prPayAmount").value = ""; $("prPayNote").value = "";
    renderPayments();
  });

  function clearInvoiceForm() {
    $("prInvoiceFormEl").reset();
    $("prInvoiceDocId").value = "";
    populateStaticSelects();
    $("prInvDate").value = todayStr();
    $("prInvPeriod").value = todayStr().slice(0, 7);
    $("prPayDate").value = todayStr();
    currentPayments = [];
    dueAutoFilled = true;
    suggestDue();
    $("prInvoiceFormTitle").textContent = tr("pr.i.createTitle");
    renderPayments();
    setFormLocked("prInvoiceFormEl", "prInvoiceLockedNotice", false);
  }
  $("prInvoiceResetBtn").addEventListener("click", clearInvoiceForm);
  $("prInvoiceAddBtn").addEventListener("click", clearInvoiceForm);

  window.prOpenInvoice = function (id) {
    const i = invoiceRecords.find(x => x._id === id);
    if (!i) return;
    populateStaticSelects();
    $("prInvoiceDocId").value = i._id;
    $("prInvVendor").value = i.vendorId || ""; $("prInvPrinter").value = i.printerId || "";
    $("prInvKind").value = i.kind || E.ik[0]; $("prInvNo").value = i.invoiceNo || "";
    $("prInvDate").value = i.invoiceDate || ""; $("prInvDue").value = i.dueDate || ""; $("prInvPeriod").value = i.period || "";
    $("prInvAmount").value = i.amount || ""; $("prInvNote").value = i.note || "";
    currentPayments = Array.isArray(i.payments) ? i.payments.map(p => Object.assign({}, p)) : [];
    $("prPayDate").value = todayStr();
    $("prPayAmount").value = invRemaining(i) > 0 ? invRemaining(i) : "";
    $("prInvoiceFormTitle").textContent = tr("pr.i.editTitle", { id: i.invoiceNo || i._id.slice(0, 6) });
    renderPayments();
    setFormLocked("prInvoiceFormEl", "prInvoiceLockedNotice", !isAdmin);
    goPage("invoiceForm");
  };
  window.prDeleteInvoice = function (id) {
    if (!isAdmin) return;
    const i = invoiceRecords.find(x => x._id === id);
    if (!i || !confirm(tr("pr.i.confirmDelete", { id: i.invoiceNo || i._id.slice(0, 6) }))) return;
    db.collection(INVOICE_COLLECTION).doc(id).delete().catch(err => alert(tr("pr.msg.errDelete", { err: err.message })));
  };
  $("prInvoiceFormEl").addEventListener("submit", e => {
    e.preventDefault();
    if (!isAdmin) { alert(tr("pr.msg.noPerm")); return; }
    const vendorId = $("prInvVendor").value;
    if (!vendorId) { alert(tr("pr.i.needVendor")); return; }
    const amount = num($("prInvAmount").value);
    if (amount <= 0) { alert(tr("pr.i.needAmount")); return; }
    const oldId = $("prInvoiceDocId").value;
    const id = oldId || db.collection(INVOICE_COLLECTION).doc().id;
    const printer = printerById($("prInvPrinter").value);
    const data = {
      vendorId, vendorName: (vendorById(vendorId) || {}).name || "",
      printerId: printer ? printer._id : "", printerCode: printer ? printer.code : "",
      kind: $("prInvKind").value, invoiceNo: $("prInvNo").value.trim(),
      invoiceDate: $("prInvDate").value, period: $("prInvPeriod").value, dueDate: $("prInvDue").value,
      amount, note: $("prInvNote").value.trim(), payments: currentPayments,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (!oldId) { data.createdBy = currentEmail || "?"; data.createdAt = firebase.firestore.FieldValue.serverTimestamp(); }
    db.collection(INVOICE_COLLECTION).doc(id).set(data, { merge: true })
      .catch(err => alert(tr("pr.msg.errSave", { err: err.message }) + "\n\n" + tr("msg.errSyncServerHint")));
    setTimeout(() => { $("prInvoiceDocId").value = id; goPage("printerDebts"); }, 150);
  });

  // Tạo hóa đơn tiền thuê tháng hiện tại cho mọi máy thuê đang trong hợp đồng.
  $("prGenRentBtn").addEventListener("click", async () => {
    if (!isAdmin) return;
    const today = todayStr(), period = today.slice(0, 7);
    const first = period + "-01", last = period + "-31";
    const targets = printerRecords.filter(p =>
      ownIsRent(p.ownership) && p.status !== E.st[4] && p.monthlyFee > 0 && p.vendorId &&
      (!p.rentStart || p.rentStart <= last) && (!p.rentEnd || p.rentEnd >= first) &&
      !invoiceRecords.some(i => i.printerId === p._id && i.kind === E.ik[0] && i.period === period));
    if (!targets.length) { alert(tr("pr.d.genRent.none", { period })); return; }
    if (!confirm(tr("pr.d.genRent.confirm", { count: targets.length, period }))) return;
    try {
      const batch = db.batch();
      targets.forEach(p => {
        const v = vendorById(p.vendorId);
        batch.set(db.collection(INVOICE_COLLECTION).doc(), {
          vendorId: p.vendorId, vendorName: v ? v.name : (p.vendorName || ""), printerId: p._id, printerCode: p.code,
          kind: E.ik[0], invoiceNo: "", invoiceDate: today, period,
          dueDate: addDays(today, v && v.paymentTerms != null ? Number(v.paymentTerms) : 30),
          amount: Number(p.monthlyFee) || 0, note: tr("pr.i.rentNote", { code: p.code, period }), payments: [], source: "rent",
          createdBy: currentEmail || "?", createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
      await batch.commit();
      alert(tr("pr.d.genRent.done", { count: targets.length }));
    } catch (err) { alert(tr("pr.msg.errSave", { err: err.message })); }
  });

  /* ---------- Xuất Excel ---------- */
  function sheetFrom(rows, widths) {
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = widths.map(w => ({ wch: w }));
    if (rows.length) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: widths.length - 1 } }) };
    return ws;
  }
  const lbl = k => tr(k).replace("*", "");
  $("prExportBtn").addEventListener("click", () => {
    if (!printerRecords.length && !invoiceRecords.length) { alert(tr("pr.export.none")); return; }
    const wb = XLSX.utils.book_new();
    const printers = printerRecords.slice().sort((a, b) => (a.code || "").localeCompare(b.code || "", undefined, { numeric: true })).map(p => ({
      [lbl("pr.f.code")]: p.code, [lbl("pr.f.ownership")]: enumLabel("own", p.ownership), [lbl("pr.f.brand")]: p.brand || "", [lbl("pr.f.model")]: p.model || "",
      [lbl("pr.f.serial")]: p.serial || "", [lbl("pr.f.type")]: enumLabel("pt", p.type), [lbl("pr.f.status")]: enumLabel("st", p.status),
      [lbl("pr.f.section")]: p.section || "", [lbl("pr.f.location")]: p.location || "", [lbl("pr.f.ip")]: p.ip || "",
      [lbl("pr.f.vendor")]: vendorNameOf(p), [lbl("pr.f.contractNo")]: p.contractNo || "", [lbl("pr.f.rentStart")]: fmtDate(p.rentStart),
      [lbl("pr.f.rentEnd")]: fmtDate(p.rentEnd), [lbl("pr.f.monthlyFee")]: p.monthlyFee || 0, [lbl("pr.f.includedPages")]: p.includedPages || 0,
      [lbl("pr.f.extraPageFee")]: p.extraPageFee || 0, [lbl("pr.f.purchaseDate")]: fmtDate(p.purchaseDate), [lbl("pr.f.purchasePrice")]: p.purchasePrice || 0,
      [lbl("pr.f.warrantyEnd")]: fmtDate(p.warrantyEnd), [lbl("pr.x.repairCount")]: (p.repairs || []).length, [lbl("pr.x.repairCost")]: printerRepairTotal(p),
      [lbl("pr.f.note")]: p.note || ""
    }));
    XLSX.utils.book_append_sheet(wb, sheetFrom(printers, [12, 10, 12, 20, 18, 16, 14, 16, 22, 15, 22, 16, 13, 13, 14, 12, 14, 13, 14, 13, 10, 16, 30]), tr("pr.x.sheetPrinters"));

    const vendors = vendorRecords.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "", "vi")).map(v => ({
      [lbl("pr.v.name")]: v.name, [lbl("pr.v.role")]: enumLabel("vr", v.role), [lbl("pr.v.contact")]: v.contact || "", [lbl("pr.v.phone")]: v.phone || "",
      [lbl("pr.v.email")]: v.email || "", [lbl("pr.v.address")]: v.address || "", [lbl("pr.v.taxCode")]: v.taxCode || "",
      [lbl("pr.v.terms")]: v.paymentTerms != null ? v.paymentTerms : "", [lbl("pr.x.debt")]: vendorDebt(v._id), [lbl("pr.f.note")]: v.note || ""
    }));
    XLSX.utils.book_append_sheet(wb, sheetFrom(vendors, [28, 16, 18, 14, 24, 30, 14, 12, 16, 30]), tr("pr.x.sheetVendors"));

    const invoices = invoiceRecords.slice().sort((a, b) => (b.invoiceDate || "").localeCompare(a.invoiceDate || "")).map(i => ({
      [lbl("pr.i.vendor")]: vendorNameOf(i), [lbl("pr.i.no")]: i.invoiceNo || "", [lbl("pr.i.kind")]: enumLabel("ik", i.kind), [lbl("pr.x.printerCode")]: i.printerCode || "",
      [lbl("pr.i.period")]: i.period || "", [lbl("pr.i.date")]: fmtDate(i.invoiceDate), [lbl("pr.i.due")]: fmtDate(i.dueDate),
      [lbl("pr.i.amount")]: Number(i.amount) || 0, [lbl("pr.x.paid")]: invPaid(i), [lbl("pr.x.remaining")]: invRemaining(i),
      [lbl("pr.x.payStatus")]: enumLabel("is", invStatus(i)), [lbl("pr.x.overdue")]: invOverdue(i) ? tr("pr.x.yes") : "", [lbl("pr.i.note")]: i.note || ""
    }));
    XLSX.utils.book_append_sheet(wb, sheetFrom(invoices, [26, 16, 14, 12, 10, 13, 13, 16, 16, 16, 20, 9, 34]), tr("pr.x.sheetInvoices"));

    const repairs = [];
    printerRecords.forEach(p => (p.repairs || []).forEach(r => repairs.push({
      [lbl("pr.x.printerCode")]: p.code, [lbl("pr.rp.date")]: fmtDate(r.date), [lbl("pr.rp.kind")]: enumLabel("rk", r.kind), [lbl("pr.rp.desc")]: r.description || "",
      [lbl("pr.rp.cost")]: Number(r.cost) || 0, [lbl("pr.x.vendorName")]: vendorNameOf(r), [lbl("pr.x.by")]: r.by || "", _d: r.date || ""
    })));
    repairs.sort((a, b) => b._d.localeCompare(a._d)).forEach(r => delete r._d);
    XLSX.utils.book_append_sheet(wb, sheetFrom(repairs, [12, 13, 18, 44, 16, 24, 26]), tr("pr.x.sheetRepairs"));

    const ts = new Date().toISOString().slice(0, 10);
    const tag = typeof currentUserFileTag === "function" ? currentUserFileTag() : "";
    XLSX.writeFile(wb, `may-in-cong-no-${ts}${tag ? ` (${tag})` : ""}.xlsx`);
  });
  /* ---------- Quét QR / barcode trên máy in để điền form ----------
     Dùng html5-qrcode (đã nạp sẵn cho trang Quét QR của app) với instance
     RIÊNG (#prReader) để không đụng máy quét tài sản. Nhận dạng:
     - Tem tài sản của app (ITASSET:<mã> hoặc link ?code=) -> liên kết tài sản
       kiểm kê + điền model/serial/IP/bộ phận còn trống.
     - DEVINFO:<base64> (QR từ script PowerShell) -> model/serial/IP.
     - QR/barcode của hãng: tìm "S/N:", "Serial:", "Model:", tham số ?sn= trong
       URL...; barcode trơn (Code128/39...) coi là Serial.
     Không nhận dạng được thì hiện nút để chọn điền vào Serial/Model/Mã/Ghi chú. */
  let prScanner = null, prScanning = false, lastScanRaw = "";
  const BRANDS = ["HP", "Canon", "Brother", "Ricoh", "Epson", "Xerox", "Samsung", "Kyocera", "Konica", "Fujifilm", "Sharp", "Lexmark", "Pantum", "Zebra", "Toshiba", "Oki"];

  function scannerConfig() {
    const cfg = { verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } };
    const F = window.Html5QrcodeSupportedFormats;
    if (F) {
      cfg.formatsToSupport = ["QR_CODE", "CODE_128", "CODE_39", "CODE_93", "EAN_13", "EAN_8", "UPC_A", "UPC_E", "ITF", "CODABAR", "DATA_MATRIX", "PDF_417", "AZTEC"]
        .filter(k => F[k] !== undefined).map(k => F[k]);
    }
    return cfg;
  }
  function stopPrinterScanner() {
    if (!prScanning || !prScanner) { prScanning = false; return; }
    const sc = prScanner;
    prScanning = false;
    sc.stop().then(() => sc.clear()).catch(() => {});
  }
  function startPrinterScanner() {
    if (prScanning) return;
    prScanning = true;
    // Khung quét rộng + ngang (barcode 1 chiều cần vùng rộng), ưu tiên độ phân giải cao.
    const base = { fps: 12, qrbox: (w, h) => ({ width: Math.floor(w * 0.9), height: Math.floor(Math.min(h * 0.6, 220)) }) };
    const attempt = cfg => {
      prScanner = new Html5Qrcode("prReader", scannerConfig());
      return prScanner.start({ facingMode: "environment" }, cfg,
        text => { stopPrinterScanner(); applyScan(text); }, () => {});
    };
    attempt(Object.assign({ videoConstraints: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } } }, base))
      .catch(() => attempt(base)) // máy không hỗ trợ ràng buộc độ phân giải -> thử lại cấu hình cơ bản
      .catch(err => { prScanning = false; alert(tr("msg.cameraError", { err })); });
  }
  $("prScanStart").addEventListener("click", startPrinterScanner);
  $("prScanStop").addEventListener("click", stopPrinterScanner);
  ["prScanFile", "prScanCam"].forEach(id => $(id).addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) handleImage(file);
  }));

  /* ---- Ảnh chụp: (1) đọc mọi QR/barcode, (2) đọc chữ trên tem (OCR) ---- */
  function loadBitmap(file) { return typeof createImageBitmap === "function" ? createImageBitmap(file) : Promise.reject(new Error("no bitmap")); }
  async function scaledBlob(bmp, maxDim, type) {
    const k = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise(res => c.toBlob(b => res(b), type || "image/png"));
  }
  async function decodeImageCodes(file) {
    const found = [];
    let bmp = null;
    try { bmp = await loadBitmap(file); } catch (e) { /* HEIC... -> bỏ qua BarcodeDetector */ }
    // 1) BarcodeDetector gốc của trình duyệt (Chrome/Android): nhanh, đọc tốt barcode 1 chiều.
    if (window.BarcodeDetector) {
      try { (await new window.BarcodeDetector().detect(bmp || file)).forEach(r => r.rawValue && found.push(r.rawValue)); } catch (e) { /* bỏ qua */ }
    }
    // 2) html5-qrcode trên ảnh gốc rồi ảnh thu nhỏ (ảnh điện thoại quá lớn đôi khi đọc hỏng).
    if (!found.length && window.Html5Qrcode) {
      const tries = [file];
      if (bmp) { for (const d of [1600, 1000]) { const b = await scaledBlob(bmp, d, "image/png"); if (b) tries.push(new File([b], "s.png", { type: "image/png" })); } }
      for (const f of tries) {
        const sc = new Html5Qrcode("prReader", scannerConfig());
        try { found.push(await sc.scanFile(f, false)); break; } catch (e) { /* thử kích thước khác */ } finally { try { sc.clear(); } catch (x) { /* bỏ qua */ } }
      }
    }
    return Array.from(new Set(found.filter(Boolean)));
  }
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    return new Promise((ok, ko) => {
      const el = document.createElement("script");
      el.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
      el.onload = ok; el.onerror = () => ko(new Error("Không tải được bộ đọc chữ"));
      document.head.appendChild(el);
    });
  }
  async function ocrImage(file) {
    await loadTesseract();
    let src = file;
    try { const bmp = await loadBitmap(file); src = (await scaledBlob(bmp, 1800, "image/png")) || file; } catch (e) { /* dùng ảnh gốc */ }
    const r = await window.Tesseract.recognize(src, "eng");
    return (r && r.data && r.data.text) || "";
  }
  async function handleImage(file) {
    stopPrinterScanner();
    const box = $("prScanResult");
    box.classList.remove("hidden");
    box.innerHTML = `<div class="hint">${tr("pr.sc.reading")}</div>`;
    let codes = [];
    try { codes = await decodeImageCodes(file); } catch (e) { codes = []; }
    codes.forEach((c, i) => applyScan(c, i > 0));
    let text = "";
    try { text = await ocrImage(file); } catch (e) { text = null; }
    if (!codes.length) box.innerHTML = `<div class="scan-row">ℹ ${esc(tr("pr.sc.noCode"))}</div>`;
    if (text === null) { box.insertAdjacentHTML("beforeend", `<div class="scan-row">⚠ ${esc(tr("pr.sc.ocrFail"))}</div>`); return; }
    applyOcr(text);
  }

  // Phân tích nội dung mã -> { fields:{serial,model,ip,brand,deviceName}, assetCode }
  function parseScanText(raw, ocr) {
    let text = (raw || "").trim();
    if (/^\*[A-Za-z0-9\-. $\/+%]{3,}\*$/.test(text)) text = text.slice(1, -1); // Code39: bỏ dấu * bao quanh
    const out = { fields: {}, assetCode: "" };
    if (/^DEVINFO:/i.test(text)) {
      try {
        const bin = atob(text.slice(8).trim());
        const d = JSON.parse(new TextDecoder("utf-8").decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
        if (d.MODEL) out.fields.model = String(d.MODEL);
        if (d.SERIAL) out.fields.serial = String(d.SERIAL);
        if (d.IP) out.fields.ip = String(d.IP);
        return out;
      } catch (e) { /* không giải mã được -> xử lý như chữ thường */ }
    }
    if (/^ITASSET:/i.test(text) || (typeof SEC_APP_URL === "string" && text.indexOf(SEC_APP_URL) === 0)) {
      const code = extractAssetCodeFromScan(text);
      if (code) { out.assetCode = code; return out; }
    }
    const grab = (obj, keys) => { for (const k of keys) { const v = obj.get(k); if (v) return v.trim(); } return ""; };
    let host = "";
    try {
      const u = new URL(text);
      host = u.hostname.toLowerCase();
      const q = new URLSearchParams(); u.searchParams.forEach((v, k) => q.set(k.toLowerCase(), v));
      const sn = grab(q, ["sn", "serial", "serialnumber", "serial_number", "serialno", "s/n"]);
      const md = grab(q, ["model", "modelname", "product", "pn"]);
      if (sn) out.fields.serial = sn;
      if (md) out.fields.model = md;
    } catch (e) { /* không phải URL */ }
    if (!out.fields.serial && ocr) {
      // Nhãn Brother/Canon...: "SER.NO. E81703J3N219227", "SER NO", "S/N", "SERIAL NO" (OCR hay lẫn O/0 nên chỉ nhận chuỗi >= 8 ký tự)
      const m = /\bSER(?:IAL)?[.\s]*(?:NO|NUMBER|NR|#)?[.:\s#]*([A-Z0-9][A-Z0-9\-]{7,24})\b/.exec(text.toUpperCase());
      if (m) { out.fields.serial = m[1]; out.labelSerial = true; }
    }
    if (!out.fields.serial) {
      const m = /(?:serial(?:\s*(?:number|no\.?|#))?|s\/n|\bsn)\s*[:=#]?\s*([A-Za-z0-9][A-Za-z0-9\-_.\/]{3,39})/i.exec(text);
      if (m) out.fields.serial = m[1];
    }
    if (!out.fields.model) {
      const m = /model(?:\s*(?:name|no\.?|number))?\s*[:=]\s*([^\n\r;,|]{2,60})/i.exec(text);
      if (m) out.fields.model = m[1].trim();
    }
    const ip = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(text);
    if (ip) out.fields.ip = ip[1];
    const hay = (text + " " + host).toLowerCase();
    const brand = BRANDS.find(b => new RegExp("(^|[^a-z0-9])" + b.toLowerCase() + "([^a-z0-9]|$)").test(hay));
    if (brand) out.fields.brand = brand;
    if (ocr) {
      const up = text.toUpperCase();
      if (!out.fields.model) {
        const m = /\bMODEL(?:\s*(?:NO\.?|NAME|NUMBER))?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-\/]{2,24})/.exec(up)
          || /\b((?:HL|MFC|DCP|DS|ADS|LBP|MF|IR|IMAGERUNNER|MP|IM|SP|FS|ECOSYS|ET|WF|XP|L\d|M\d|P\d|B\d|C\d|WC)[-\s]?[A-Z]?\d{2,5}[A-Z]{0,5})\b/.exec(up);
        if (m) out.fields.model = m[1].trim();
      }
      if (/COLOU?R|BERWARNA|彩色|MÀU|\bMFC-?J|\bMFC-?L\d{4}C|CDW\b|\bCW\b/.test(up)) out.fields.type = "Laser màu";
      else if (/\bMFC\b|MULTI-?FUNCTION|ALL-IN-ONE|\bMFP\b/.test(up)) out.fields.type = "Đa năng (MFP)";
    }
    // Barcode trơn (Code128/39...): coi cả chuỗi là Serial.
    if (!out.fields.serial && !ocr && /^[A-Za-z0-9][A-Za-z0-9\-_.\/+]{4,39}$/.test(text)) out.fields.serial = text;
    return out;
  }

  const SCAN_TARGETS = { serial: "prSerial", model: "prModel", brand: "prBrand", ip: "prIp", type: "prType" };
  function linkAssetToForm(a) {
    $("prAssetCode").value = a.code; $("prAssetId").value = a._id;
    if (!$("prModel").value.trim()) $("prModel").value = a.model || "";
    if (!$("prSerial").value.trim()) $("prSerial").value = a.serial || "";
    if (!$("prIp").value.trim()) $("prIp").value = a.ip || "";
    if (!$("prSection").value.trim()) $("prSection").value = a.section || "";
  }
  window.prScanLinkAsset = function (id) {
    const a = assets.find(x => x._id === id);
    if (a) { linkAssetToForm(a); $("prScanResult").insertAdjacentHTML("beforeend", `<div class="scan-row">✅ ${esc(tr("pr.sc.assetLinked", { code: a.code }))}</div>`); }
  };
  window.prScanAssign = function (field) {
    const map = { serial: "prSerial", model: "prModel", code: "prCode", note: "prNote" };
    if (field === "code" && $("prCode").readOnly) return;
    const el = $(map[field]);
    if (!el || !lastScanRaw) return;
    el.value = field === "note" && el.value ? el.value + "\n" + lastScanRaw : lastScanRaw;
    $("prScanResult").insertAdjacentHTML("beforeend", `<div class="scan-row">✅ ${esc(tr(field === "code" ? "pr.f.code" : field === "note" ? "pr.f.note" : "pr.f." + field).replace("*", ""))}</div>`);
  };

  function applyScan(raw, keep) {
    lastScanRaw = (raw || "").trim();
    const box = $("prScanResult");
    box.classList.remove("hidden");
    const p = parseScanText(lastScanRaw);
    const lines = [];
    let recognised = false;

    if (p.assetCode) {
      recognised = true;
      const a = assets.find(x => x.code === p.assetCode);
      if (a) { linkAssetToForm(a); lines.push("✅ " + tr("pr.sc.assetLinked", { code: a.code })); }
      else lines.push("⚠ " + tr("pr.sc.assetNotFound", { code: p.assetCode }));
    } else {
      // Serial luôn ghi đè (đó là mục đích quét); model/hãng/IP chỉ điền khi đang trống.
      const filled = [];
      Object.keys(p.fields).forEach(k => {
        const el = $(SCAN_TARGETS[k]);
        if (!el || !p.fields[k]) return;
        if (k === "serial" || !el.value.trim()) { el.value = p.fields[k]; filled.push(tr("pr.f." + k)); }
      });
      if (filled.length) { recognised = true; lines.push("✅ " + tr("pr.sc.filled", { fields: filled.join(", ") })); }
      const sn = p.fields.serial;
      if (sn) {
        const cur = $("prDocId").value;
        const dup = printerRecords.find(x => (x.serial || "").toLowerCase() === sn.toLowerCase() && x._id !== cur);
        if (dup) lines.push(`⚠ ${esc(tr("pr.sc.dupPrinter", { code: dup.code }))} <button type="button" class="secondary" style="margin-top:6px" onclick="prOpenPrinter('${dup._id}')">${tr("pr.tk.open")}</button>`);
        const am = assets.find(x => (x.serial || "").toLowerCase() === sn.toLowerCase());
        if (am && $("prAssetId").value !== am._id) lines.push(`🔗 ${esc(tr("pr.sc.matchAsset", { code: am.code }))} <button type="button" class="secondary" style="margin-top:6px" onclick="prScanLinkAsset('${am._id}')">${tr("pr.sc.linkAsset")}</button>`);
      }
    }
    if (!recognised) lines.push("❔ " + tr("pr.sc.nothing"));
    const assign = `<div class="scan-info"><span class="muted">${tr("pr.sc.assignTo")}</span>
      <div class="qr-btn-row" style="margin-top:6px">
        <button type="button" class="secondary" onclick="prScanAssign('serial')">${esc(tr("pr.f.serial"))}</button>
        <button type="button" class="secondary" onclick="prScanAssign('model')">${esc(tr("pr.f.model"))}</button>
        <button type="button" class="secondary" onclick="prScanAssign('code')">${esc(tr("pr.f.code").replace("*", ""))}</button>
        <button type="button" class="secondary" onclick="prScanAssign('note')">${esc(tr("pr.f.note"))}</button>
      </div></div>`;
    const html = `<div class="muted">${tr("pr.sc.raw")}:</div><div style="word-break:break-all;margin-bottom:6px"><b>${esc(lastScanRaw.slice(0, 300))}</b></div>` +
      lines.map(l => `<div class="scan-row">${l.indexOf("<button") === -1 ? esc(l) : l}</div>`).join("") + assign;
    box.innerHTML = keep ? box.innerHTML + "<hr>" + html : html;
  }

  // Kết quả OCR: chỉ điền ô đang trống (không đè dữ liệu đã gõ); loại máy chỉ đổi khi còn mặc định.
  function applyOcr(text) {
    const box = $("prScanResult");
    const p = parseScanText(text, true);
    const filled = [];
    let extraNote = "";
    Object.keys(p.fields).forEach(k => {
      const el = $(SCAN_TARGETS[k]);
      if (!el || !p.fields[k]) return;
      const empty = k === "type" ? el.selectedIndex === 0 : !el.value.trim();
      // Serial in trên nhãn ("SER.NO.") đáng tin hơn mã vạch phụ (vd D02DSZ001) -> ghi đè.
      const override = k === "serial" && p.labelSerial && el.value.trim() !== p.fields[k];
      if (override) { extraNote = tr("pr.sc.serialReplaced", { old: el.value.trim() || "—", now: p.fields[k] }); }
      if (empty || override) { el.value = p.fields[k]; if (el.value === p.fields[k]) filled.push(tr("pr.f." + k)); }
    });
    lastScanRaw = (text || "").trim();
    const shown = lastScanRaw.split(/\r?\n/).map(x => x.trim()).filter(Boolean).join(" · ").slice(0, 400);
    box.insertAdjacentHTML("beforeend", `<hr><div class="muted">${tr("pr.sc.ocrText")}:</div><div style="word-break:break-word;margin-bottom:6px">${esc(shown)}</div>` +
      (filled.length ? `<div class="scan-row">✅ ${esc(tr("pr.sc.filled", { fields: filled.join(", ") }))}</div>` : `<div class="scan-row">❔ ${esc(tr("pr.sc.ocrNone"))}</div>`) +
      (extraNote ? `<div class="scan-row">ℹ ${esc(extraNote)}</div>` : ""));
  }
})();
