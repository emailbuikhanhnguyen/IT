/* IT Asset Inventory — app.js
   Firestore (realtime + offline persistence) + QR + Camera + Excel + Backup
*/

/* ---------- Firebase init ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyC5W2yjCUZzTZOcFMAbD2uj9bo9rmGydEI",
  authDomain: "sec-it-asset.firebaseapp.com",
  projectId: "sec-it-asset",
  storageBucket: "sec-it-asset.firebasestorage.app",
  messagingSenderId: "936361007231",
  appId: "1:936361007231:web:3fbf98db47f74801d1c74a",
  measurementId: "G-0DDT153KD2"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();
const COLLECTION = "assets";
const TICKET_COLLECTION = "tickets";
const EMPLOYEES_COLLECTION = "employees";

try {
  db.enablePersistence({ synchronizeTabs: true }).catch(err => {
    console.warn("Offline persistence not enabled:", err.code);
  });
} catch (e) { console.warn(e); }

/* ---------- State ---------- */
let assets = [];              // local cache, synced from Firestore
let ticketRecords = [];       // local cache, synced from Firestore (tickets)
let html5QrCode = null;
let scanning = false;
let currentPhotoData = "";    // base64 dataURL of the photo currently in the form
let deferredInstallPrompt = null;

/* ---------- Role / permissions ----------
   Only 2 kinds of accounts exist:
   - "admin"     (IT): full read/write/delete on every asset, plus Excel/
     Backup/settings. Marked by a doc at users/{uid} with { role: "admin" }
     in Firestore (create manually per IT account — see firestore.rules).
   - "collector" (the single field account IT carries to every machine):
     can READ every asset (to browse/search and avoid duplicate codes) and
     CREATE new ones, but can NEVER update or delete an asset — including
     the one it just created — once it exists. If something was entered
     wrong, an admin has to log in and fix it. Marked by users/{uid} with
     { role: "collector" }.
   Any signed-in account with no matching users/{uid} doc is unauthorized
   and gets signed out immediately (safe default: deny, not "staff").
*/
let isAdmin = false;
let isCollector = false;
let currentEmail = "";
let currentUid = "";

const ASSET_TYPES = ["Máy tính (PC)", "Laptop", "Camera", "Máy in", "Switch mạng", "Router/WiFi", "Firewall", "Màn hình", "UPS", "Máy chiếu", "Khác"];

const CHECK_UNCHECKED = "Chưa kiểm";
const CHECK_OK = "Đã kiểm - OK";
const CHECK_NEW = "Thiết bị mới";
const CHECK_WRONG = "Sai thông tin";
const CHECK_MISSING = "Không tìm thấy";

/* ---------- Lịch sử thay đổi (vòng đời tài sản) ----------
   Lưu trực tiếp trong field `history` (mảng) của chính document tài sản đó —
   KHÔNG dùng subcollection/collection riêng, nên không cần sửa gì thêm ở
   firestore.rules: quyền ghi field này đi theo đúng quyền ghi cả document
   (collector tạo mới được, chỉ admin sửa được) như mọi field khác.
   Mỗi phần tử: { at: <epoch ms>, by: <email>, action: 'create'|'update'|'rename',
                  changes: [{ field, label, from, to }] }
   Lưu ý: dùng Date.now() (không dùng serverTimestamp()) cho từng phần tử,
   vì Firestore không cho phép serverTimestamp() bên trong arrayUnion(). */
const HISTORY_TRACK_FIELDS = [
  ["employeeCode", "Mã nhân viên"],
  ["user", "Người sử dụng"],
  ["section", "Bộ phận"],
  ["group", "Tổ/Chuyền"],
  ["type", "Loại thiết bị"],
  ["deviceName", "Device name"],
  ["model", "Model"],
  ["serial", "Serial Number"],
  ["ip", "IP"],
  ["mac", "MAC"],
  ["spec", "Cấu hình"],
  ["winInfo", "Thông tin Windows"],
  ["status", "Tình trạng"],
  ["checkStatus", "Trạng thái kiểm kê"],
  ["note", "Ghi chú"],
];
const HISTORY_ACTION_LABEL = { create: "Tạo mới", update: "Cập nhật", rename: "Đổi mã", import: "Nhập từ Excel" };

// So sánh 1 tài sản cũ (đang có trên hệ thống) với dữ liệu mới sắp lưu,
// trả về danh sách các trường thực sự thay đổi. Nếu truyền `onlyKeys` (vd:
// khi import Excel chỉ ghi vài cột), chỉ so sánh đúng các trường đó — tránh
// hiểu nhầm "xóa trắng" cho các trường mà dòng Excel không hề đề cập tới
// (vì .set(..., {merge:true}) không đụng tới field không có trong obj).
function diffAssetFields(oldA, newData, onlyKeys) {
  const fields = onlyKeys ? HISTORY_TRACK_FIELDS.filter(([key]) => onlyKeys.includes(key)) : HISTORY_TRACK_FIELDS;
  const changes = [];
  fields.forEach(([key, label]) => {
    const ov = ((oldA && oldA[key]) || "").toString().trim();
    const nv = ((newData && newData[key]) || "").toString().trim();
    if (ov !== nv) changes.push({ field: key, label, from: ov, to: nv });
  });
  return changes;
}

function historyEntry(action, changes) {
  return { at: Date.now(), by: currentEmail || "?", action, changes: changes || [] };
}

function formatHistoryTime(ms) {
  try { return new Date(ms).toLocaleString("vi-VN"); } catch (e) { return ""; }
}

function renderHistoryBox(a) {
  const box = $("historyBox");
  const list = $("historyList");
  if (!box || !list) return;
  const entries = Array.isArray(a && a.history) ? a.history.slice().sort((x, y) => (y.at || 0) - (x.at || 0)) : [];
  if (!entries.length) { box.classList.add("hidden"); list.innerHTML = ""; return; }
  box.classList.remove("hidden");
  list.innerHTML = entries.map(e => {
    const changesHtml = (e.changes || []).map(c => {
      const from = c.from ? escapeHtml(c.from) : "<i>(trống)</i>";
      const to = c.to ? escapeHtml(c.to) : "<i>(trống)</i>";
      return `<div class="history-change"><b>${escapeHtml(c.label)}:</b> ${from} → ${to}</div>`;
    }).join("");
    return `<div class="history-entry">
      <div class="history-head">
        <span class="history-action">${escapeHtml(HISTORY_ACTION_LABEL[e.action] || e.action || "")}</span>
        <span class="muted">${formatHistoryTime(e.at)} · ${escapeHtml(e.by || "")}</span>
      </div>
      ${changesHtml || '<div class="history-change muted">Không có thay đổi chi tiết được ghi nhận.</div>'}
    </div>`;
  }).join("");
}

/* ---------- Utilities ---------- */
function $(id) { return document.getElementById(id); }
function sanitizeId(code) {
  return (code || "").trim().toUpperCase().replace(/[^A-Z0-9\-_.]/g, "_");
}
function saveLocalCache() {
  try { localStorage.setItem("ita_assets_cache", JSON.stringify(assets)); } catch (e) {}
}
function loadLocalCache() {
  try {
    const raw = localStorage.getItem("ita_assets_cache");
    if (raw) { assets = JSON.parse(raw); renderAll(); }
  } catch (e) {}
}
function toast(msg) {
  const el = $("scanResult");
  if (el && !el.classList.contains("hidden") && location.hash === "#scan") return;
  alert(msg);
}

/* ---------- Navigation ---------- */
function goPage(name) {
  if (name === "settings" && !isAdmin) name = "dashboard"; // settings/backup/import are admin-only
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const target = $(name);
  if (target) target.classList.add("active");
  if (name !== "scan" && scanning) stopScanner();
  if (name === "assets") renderAssetList();
  if (name === "tickets") renderTicketList();
  if (name === "dashboard") renderDashboard();
}
document.querySelectorAll("[data-page]").forEach(btn => {
  btn.addEventListener("click", () => goPage(btn.getAttribute("data-page")));
});
// The two "add new asset" entry points must start from a clean, unlocked
// form — otherwise navigating here right after viewing a locked asset
// would carry over its disabled/read-only state.
["quickAddBtn", "assetsAddBtn"].forEach(id => {
  const btn = $(id);
  if (btn) btn.addEventListener("click", clearForm);
});

/* ---------- Firestore realtime sync ---------- */
let unsubscribeSync = null;
function initSync() {
  if (unsubscribeSync) return; // already listening
  unsubscribeSync = db.collection(COLLECTION).onSnapshot(snapshot => {
    assets = snapshot.docs.map(d => Object.assign({ _id: d.id }, d.data()));
    saveLocalCache();
    renderAll();
  }, err => {
    console.error("Sync error:", err);
  });
}
function stopSync() {
  if (unsubscribeSync) { unsubscribeSync(); unsubscribeSync = null; }
}

let unsubscribeTicketSync = null;
function initTicketSync() {
  if (unsubscribeTicketSync) return; // already listening
  unsubscribeTicketSync = db.collection(TICKET_COLLECTION).onSnapshot(snapshot => {
    ticketRecords = snapshot.docs.map(d => Object.assign({ _id: d.id }, d.data()));
    saveTicketsLocalCache();
    renderAll();
  }, err => {
    console.error("Ticket sync error:", err);
  });
}
function stopTicketSync() {
  if (unsubscribeTicketSync) { unsubscribeTicketSync(); unsubscribeTicketSync = null; }
}
function saveTicketsLocalCache() {
  try { localStorage.setItem("ita_tickets_cache", JSON.stringify(ticketRecords)); } catch (e) {}
}
function loadTicketsLocalCache() {
  try {
    const raw = localStorage.getItem("ita_tickets_cache");
    if (raw) { ticketRecords = JSON.parse(raw); renderAll(); }
  } catch (e) {}
}

/* ---------- Danh sách nhân viên (đồng bộ Firestore) ----------
   employees.js chỉ còn là danh sách "khởi tạo/dự phòng" (dùng khi mất
   mạng hoặc trước khi đăng nhập). Sau khi đăng nhập, nếu collection
   `employees` trên Firestore có dữ liệu (tức đã từng Nhập Excel từ HR —
   xem importEmployeesXlsx bên dưới), danh sách đó sẽ GHI ĐÈ window.EMPLOYEES
   và cập nhật realtime cho mọi tài khoản/thiết bị — không cần IT tự sửa
   tay employees.js mỗi khi HR có người mới nữa. */
let unsubscribeEmployeesSync = null;
function initEmployeesSync() {
  if (unsubscribeEmployeesSync) return;
  unsubscribeEmployeesSync = db.collection(EMPLOYEES_COLLECTION).onSnapshot(snapshot => {
    if (snapshot.empty) return; // chưa từng import từ HR -> giữ nguyên employees.js
    window.EMPLOYEES = snapshot.docs.map(d => d.data());
  }, err => {
    console.warn("Employees sync error (giữ danh sách employees.js):", err);
  });
}
function stopEmployeesSync() {
  if (unsubscribeEmployeesSync) { unsubscribeEmployeesSync(); unsubscribeEmployeesSync = null; }
}

function renderAll() {
  renderDashboard();
  renderAssetList();
  renderTicketList();
}

/* ---------- Dashboard ---------- */
function classifyCheck(status) {
  if (status === CHECK_OK || status === CHECK_NEW) return "checked";
  if (status === CHECK_WRONG || status === CHECK_MISSING) return "exception";
  return "unchecked";
}
function renderDashboard() {
  const total = assets.length;
  let checked = 0, unchecked = 0, exception = 0;
  assets.forEach(a => {
    const c = classifyCheck(a.checkStatus);
    if (c === "checked") checked++;
    else if (c === "exception") exception++;
    else unchecked++;
  });
  $("totalCount").textContent = total;
  $("checkedCount").textContent = checked;
  $("uncheckedCount").textContent = unchecked;
  $("exceptionCount").textContent = exception;

  const pct = total ? Math.round((checked / total) * 100) : 0;
  let html = `<div class="hint">Tổng tiến độ: ${checked}/${total} (${pct}%)</div>
    <div class="bar"><i style="width:${pct}%"></i></div>`;
  if (!total) html = `<div class="empty">Chưa có tài sản nào. Bấm "＋ Tạo tài sản" để bắt đầu.</div>`;
  $("checkStats").innerHTML = html;

  // Thống kê Ticket hỗ trợ trên dashboard
  const tTotal = ticketRecords.length;
  let tPending = 0, tInProgress = 0, tDone = 0;
  ticketRecords.forEach(t => {
    if (t.status === "Hoàn thành") tDone++;
    else if (t.status === "Đang xử lý") tInProgress++;
    else tPending++;
  });
  $("ticketTotalCount").textContent = tTotal;
  $("ticketPendingCount").textContent = tPending;
  $("ticketInProgressCount").textContent = tInProgress;
  $("ticketDoneCount").textContent = tDone;
}

/* ---------- Asset list ---------- */
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function badgeClass(status) {
  const c = classifyCheck(status);
  if (c === "checked") return "ok";
  if (c === "exception") return "bad";
  return "warn";
}
// Rebuilds the "Bộ phận" filter's option list from whatever sections
// currently exist in `assets`, keeping the user's current selection if it's
// still a valid option (falls back to "Tất cả khu vực" otherwise).
function populateSectionFilter() {
  const sel = $("filterSection");
  if (!sel) return;
  const prev = sel.value;
  const sections = Array.from(new Set(assets.map(a => (a.section || "").trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, "vi"));
  sel.innerHTML = `<option value="">Tất cả khu vực</option>` +
    sections.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  if (prev && sections.includes(prev)) sel.value = prev;
}

function renderAssetList() {
  populateSectionFilter();
  const q = ($("search").value || "").trim().toLowerCase();
  const checkF = $("filterCheck").value;
  const sectionF = $("filterSection").value;

  let list = assets.slice().sort((a, b) => (a.code || "").localeCompare(b.code || ""));
  if (q) {
    list = list.filter(a =>
      [a.code, a.serial, a.model, a.deviceName, a.user, a.employeeCode].some(v => (v || "").toLowerCase().includes(q))
    );
  }
  if (checkF) list = list.filter(a => classifyCheck(a.checkStatus) === checkF);
  if (sectionF) list = list.filter(a => (a.section || "").trim() === sectionF);

  if (!list.length) {
    $("assetList").innerHTML = `<div class="empty">Không có tài sản phù hợp.</div>`;
    return;
  }
  $("assetList").innerHTML = list.map(a => {
    const editBtn = isAdmin
      ? `<button onclick="editAsset('${a._id}')">✎ Sửa</button>`
      : `<button onclick="editAsset('${a._id}')">👁 Xem</button>`;
    const deleteBtn = isAdmin
      ? `<button class="secondary" onclick="deleteAsset('${a._id}')">🗑 Xóa</button>`
      : "";
    return `
    <div class="asset">
      <div>
        <h3>${escapeHtml(a.code)}</h3>
        <div class="muted">${escapeHtml(a.type || "")} ${a.model ? "· " + escapeHtml(a.model) : ""}</div>
        <div class="muted">${a.user ? "👤 " + escapeHtml(a.user) : ""}${a.employeeCode ? " (" + escapeHtml(a.employeeCode) + ")" : ""}</div>
        ${a.section ? `<div class="muted">🏢 ${escapeHtml(a.section)}</div>` : ""}
        <span class="badge ${badgeClass(a.checkStatus)}">${escapeHtml(a.checkStatus || CHECK_UNCHECKED)}</span>
        ${!isAdmin ? `<span class="badge view-only-tag">👁 Chỉ xem</span>` : ""}
      </div>
      <div class="asset-actions">
        ${editBtn}
        <button class="secondary" onclick="printLabel('${a._id}')">🏷 In tem</button>
        ${deleteBtn}
      </div>
    </div>
  `;
  }).join("");
}
$("search").addEventListener("input", renderAssetList);
$("filterCheck").addEventListener("change", renderAssetList);
$("filterSection").addEventListener("change", renderAssetList);

/* ---------- Autocomplete dropdowns (Người sử dụng / Mã NV / Bộ phận) ----------
   Dùng chung 1 cơ chế: gõ hoặc bấm vào ô sẽ hiện danh sách gợi ý (tối đa 20
   dòng), bấm chọn 1 dòng sẽ điền field đó (và có thể điền kèm field liên
   quan). Không có gợi ý khớp thì vẫn gõ tay/để trống bình thường — không
   ô nào bị bắt buộc chọn từ danh sách.
*/
function setupAutocomplete(inputId, boxId, getItems, renderItem, onSelect, opts = {}) {
  const input = $(inputId);
  const box = $(boxId);
  function selectItem(it) {
    onSelect(it);
    box.classList.add("hidden");
    box.innerHTML = "";
  }
  function show() {
    const items = getItems(input.value);
    // autoFillMinChars: nếu gõ đủ số ký tự này trở lên mà chỉ còn đúng 1
    // kết quả khớp (ví dụ gõ 4-5 số cuối Mã NV mà không trùng ai khác) thì
    // tự điền luôn, không cần bấm chọn. Query quá ngắn thì vẫn phải bấm
    // chọn như cũ để tránh tự điền nhầm.
    if (opts.autoFillMinChars && input.value.trim().length >= opts.autoFillMinChars && items.length === 1) {
      selectItem(items[0]);
      return;
    }
    if (!items.length) {
      box.innerHTML = `<div class="suggest-empty">Không có gợi ý khớp — vẫn có thể nhập tay hoặc để trống.</div>`;
      box.classList.remove("hidden");
      return;
    }
    box.innerHTML = items.map((it, i) => `<div class="suggest-item${it.inactive ? " inactive" : ""}" data-idx="${i}">${renderItem(it)}</div>`).join("");
    box.querySelectorAll(".suggest-item[data-idx]").forEach(el => {
      el.addEventListener("mousedown", ev => {
        ev.preventDefault(); // fire before the input's blur hides the box
        selectItem(items[Number(el.getAttribute("data-idx"))]);
      });
    });
    box.classList.remove("hidden");
  }
  input.addEventListener("input", show);
  input.addEventListener("focus", show);
  input.addEventListener("blur", () => setTimeout(() => box.classList.add("hidden"), 120));
}

function filterList(list, query, limit) {
  const q = query.trim().toLowerCase();
  const matched = q ? list.filter(v => v.toLowerCase().includes(q)) : list;
  return matched.slice(0, limit);
}

// Lọc trực tiếp trên mảng nhân viên (thay vì gom về mảng tên/mã rồi tìm
// ngược lại) — tránh việc 2 người trùng tên/mã bị "find" gộp về đúng 1
// người. Giới hạn nâng lên 200 (thay vì 20 trước đây) vì hộp gợi ý đã tự
// cuộn (CSS max-height:220px), và công ty có thể có hơn 20 người khớp
// cùng 1 từ khóa (VD: gõ tên đệm phổ biến, hoặc bấm vào ô rỗng để xem hết
// danh sách theo Bộ phận).
function filterEmployeesBy(field, query, limit) {
  const q = query.trim().toLowerCase();
  const list = window.EMPLOYEES || [];
  const matched = q ? list.filter(e => (e[field] || "").toLowerCase().includes(q)) : list;
  return matched.slice(0, limit).map(e => Object.assign({ inactive: !e.active }, e));
}

// Mã nhân viên — gõ/chọn theo mã, chọn xong điền kèm Tên / Bộ phận / Tổ-Chuyền
// (2 chiều với ô "Người sử dụng" bên dưới).
setupAutocomplete("employeeCode", "employeeCodeSuggest",
  q => filterEmployeesBy("code", q, 200),
  e => `${escapeHtml(e.code)}<span class="muted">${escapeHtml(e.name)}${e.section ? " · " + escapeHtml(e.section) : ""}${e.active ? "" : " · đã nghỉ việc"}</span>`,
  e => {
    $("employeeCode").value = e.code;
    $("user").value = e.name;
    $("section").value = e.section || "";
    $("group").value = e.group || "";
    maybeSuggestCode();
  },
  { autoFillMinChars: 3 }
);

// Người sử dụng — gợi ý từ danh sách nhân viên (employees.js), chọn xong
// điền kèm Mã NV / Bộ phận / Tổ-Chuyền.
setupAutocomplete("user", "userSuggest",
  q => filterEmployeesBy("name", q, 200),
  e => `${escapeHtml(e.name)}<span class="muted">${escapeHtml(e.code)}${e.section ? " · " + escapeHtml(e.section) : ""}${e.group ? " · " + escapeHtml(e.group) : ""}${e.active ? "" : " · đã nghỉ việc"}</span>`,
  e => {
    $("user").value = e.name;
    $("employeeCode").value = e.code;
    $("section").value = e.section || "";
    $("group").value = e.group || "";
    maybeSuggestCode();
  },
  { autoFillMinChars: 3 }
);

// Bộ phận (Section) — gợi ý từ các Section có trong danh sách nhân viên.
// Chọn ở đây CHỈ điền Bộ phận, không đụng Tên/Mã NV/Tổ-Chuyền, vì một Bộ
// phận có nhiều nhân viên nên không thể suy ngược ra 1 người cụ thể.
setupAutocomplete("section", "sectionSuggest",
  q => filterList(Array.from(new Set((window.EMPLOYEES || []).map(e => e.section).filter(Boolean))), q, 100).map(v => ({ value: v })),
  it => escapeHtml(it.value),
  it => { $("section").value = it.value; maybeSuggestCode(); }
);

/* ---------- Asset form ---------- */
function populateTypeSelect() {
  $("type").innerHTML = ASSET_TYPES.map(t => `<option>${t}</option>`).join("");
}

/* ---------- Mã tài sản: tự gợi ý theo Loại thiết bị + Bộ phận ----------
   Định dạng: [Viết tắt Thiết bị]-[Viết tắt Bộ phận]-[số thứ tự 4 số],
   ví dụ: LAP-AT-0001. Đây LÀ GỢI Ý — giống các ô autocomplete khác trong
   app, người dùng vẫn gõ tay/sửa lại thoải mái, không bị khóa. Nếu Bộ
   phận để trống thì bỏ đoạn đó, mã chỉ còn [Thiết bị]-[số thứ tự].

   Số thứ tự đếm theo local cache `assets` (đã đồng bộ realtime từ
   Firestore) cho từng cặp Loại thiết bị + Bộ phận — không phải giao dịch
   nguyên tử phía server, nên hai máy tạo tài sản cùng lúc khi cùng offline
   có thể trùng số thứ tự gợi ý. Không phải vấn đề lớn vì mã vẫn luôn sửa
   tay được trước khi lưu, và code là ID tài liệu Firestore nên hai tài
   sản trùng mã sẽ tự lộ ra ngay (ghi đè nhau) thay vì âm thầm sai dữ liệu.
*/
const ASSET_TYPE_ABBR = {
  "Máy tính (PC)": "PC",
  "Laptop": "LAP",
  "Camera": "CAM",
  "Máy in": "PRN",
  "Switch mạng": "SW",
  "Router/WiFi": "RT",
  "Firewall": "FW",
  "Màn hình": "MON",
  "UPS": "UPS",
  "Máy chiếu": "PRJ",
  "Khác": "KHAC"
};
// Viết tắt Bộ phận — chuẩn bị sẵn theo các Section có trong employees.js
// hiện tại. Khi HR có Section mới chưa nằm trong bảng này, app tự suy
// viết tắt từ chữ cái đầu mỗi từ (xem autoAbbr) — thêm entry vào đây khi
// muốn viết tắt đẹp hơn cho Section đó.
const SECTION_ABBR = {
  "Accounting": "ACC",
  "Automation and technology": "AT",
  "Compliance": "COM",
  "Customer service": "CS",
  "Embroidery": "EMB",
  "Genaral Purchasing": "GP",
  "Heat Transfer": "HT",
  "Human Resource": "HR",
  "IE - CI": "IE",
  "Import and Export": "IMEX",
  "Merchandise": "MER",
  "POD": "POD",
  "Packing": "PACK",
  "Production Planning Control": "PPC",
  "Quality Audit and Quanlity Control": "QA",
  "Sales And Marketing": "SM",
  "Sublimation": "SUB",
  "Warehouse": "WH"
};
const ABBR_STOPWORDS = new Set(["and", "và", "of", "the", "for", "&"]);
function autoAbbr(text) {
  const words = (text || "").trim().split(/[\s\-\/]+/).filter(w => w && !ABBR_STOPWORDS.has(w.toLowerCase()));
  if (!words.length) return "";
  const initials = words.map(w => w[0]).join("").toUpperCase();
  if (initials.length >= 2) return initials.slice(0, 4);
  return (text || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase();
}
function typeAbbr(type) { return ASSET_TYPE_ABBR[type] || autoAbbr(type); }
function sectionAbbr(section) { return section ? (SECTION_ABBR[section] || autoAbbr(section)) : ""; }

// false khi mã hiện tại KHÔNG phải do app tự gợi ý nữa (người dùng đã gõ
// tay, đang sửa tài sản có sẵn, hoặc mã đến từ QR đã in trước đó) — để
// khỏi ghi đè mất mã người dùng đã cố tình đặt.
let codeAutoFilled = true;
function suggestedCodeSeq(type, section) {
  const n = assets.filter(a => a.type === type && (a.section || "") === (section || "")).length + 1;
  return String(n).padStart(4, "0");
}
function maybeSuggestCode() {
  if (!codeAutoFilled) return;
  if ($("assetId").value) return; // đang sửa tài sản có sẵn — không đổi mã
  const type = $("type").value;
  const t = typeAbbr(type);
  if (!t) return;
  const section = $("section").value.trim();
  const s = sectionAbbr(section);
  const seq = suggestedCodeSeq(type, section);
  const code = s ? `${t}-${s}-${seq}` : `${t}-${seq}`;
  $("code").value = code;
  renderQR(code);
}
$("type").addEventListener("change", maybeSuggestCode);
$("section").addEventListener("input", maybeSuggestCode);
$("code").addEventListener("input", () => { codeAutoFilled = false; });
// Disables/enables every field+button inside the asset form (used for the
// read-only view staff get once their asset is locked). The section-head
// back button lives outside the <form>, so navigation still works.
function setFormLocked(locked) {
  $("assetFormEl").querySelectorAll("input, select, textarea, button").forEach(el => {
    el.disabled = locked;
  });
  $("lockedNotice").classList.toggle("hidden", !locked);
}

function clearForm() {
  $("assetFormEl").reset();
  $("assetId").value = "";
  $("formTitle").textContent = "Tạo tài sản";
  currentPhotoData = "";
  $("photoPreview").classList.add("hidden");
  $("photoPreview").src = "";
  $("qrcode").innerHTML = "";
  $("qrText").textContent = "";
  $("pasteInfoBox").value = "";
  $("userSuggest").classList.add("hidden");
  $("userSuggest").innerHTML = "";
  $("employeeCodeSuggest").classList.add("hidden");
  $("employeeCodeSuggest").innerHTML = "";
  $("sectionSuggest").classList.add("hidden");
  $("sectionSuggest").innerHTML = "";
  $("assetLocked").checked = false;
  $("code").readOnly = false;
  setFormLocked(false);
  codeAutoFilled = true;
  maybeSuggestCode(); // gợi ý sẵn mã cho tài sản mới (vd PC-0001)
  if ($("historyBox")) { $("historyBox").classList.add("hidden"); $("historyList").innerHTML = ""; }
}
$("resetForm").addEventListener("click", clearForm);

function fillFormFromAsset(a) {
  codeAutoFilled = false; // tài sản đã có mã thật — không tự sinh đè lên
  $("assetId").value = a._id || "";
  $("employeeCode").value = a.employeeCode || "";
  $("user").value = a.user || "";
  $("section").value = a.section || "";
  $("group").value = a.group || "";
  $("code").value = a.code || "";
  $("type").value = a.type || ASSET_TYPES[0];
  $("deviceName").value = a.deviceName || "";
  $("model").value = a.model || "";
  $("serial").value = a.serial || "";
  $("ip").value = a.ip || "";
  $("mac").value = a.mac || "";
  $("spec").value = a.spec || "";
  $("winInfo").value = a.winInfo || "";
  $("status").value = a.status || "Tốt";
  $("checkStatus").value = a.checkStatus || CHECK_UNCHECKED;
  $("note").value = a.note || "";
  currentPhotoData = a.photo || "";
  if (currentPhotoData) {
    $("photoPreview").src = currentPhotoData;
    $("photoPreview").classList.remove("hidden");
  } else {
    $("photoPreview").classList.add("hidden");
  }
  $("assetLocked").checked = !!a.locked;
  $("formTitle").textContent = "Sửa tài sản: " + (a.code || "");
  renderQR(a.code);
  renderHistoryBox(a);

  // Only admin can rename the doc ID (renaming = delete old + create new,
  // and only admins are allowed to delete) or edit an EXISTING record at
  // all — the collector account can create new assets but can never edit
  // one that already exists, including its own.
  $("code").readOnly = !isAdmin;
  setFormLocked(!isAdmin);
}
window.editAsset = function (id) {
  const a = assets.find(x => x._id === id);
  if (!a) return;
  fillFormFromAsset(a);
  goPage("assetForm");
};
window.deleteAsset = function (id) {
  if (!isAdmin) return; // UI already hides this button for non-admins; Firestore Rules enforce it server-side too
  const a = assets.find(x => x._id === id);
  if (!a) return;
  if (!confirm(`Xóa tài sản "${a.code}"? Không thể hoàn tác.`)) return;
  db.collection(COLLECTION).doc(id).delete().catch(err => alert("Lỗi xóa: " + err.message));
};

$("assetFormEl").addEventListener("submit", e => {
  e.preventDefault();
  const code = $("code").value.trim();
  if (!code) { alert("Vui lòng nhập Mã tài sản."); return; }
  const newId = sanitizeId(code);
  if (!newId) { alert("Mã tài sản không hợp lệ."); return; }
  const oldId = $("assetId").value;
  const oldAsset = oldId ? assets.find(a => a._id === oldId) : null;

  // Defense in depth: the form is already disabled for non-admins on any
  // EXISTING record, but double-check here too. Firestore Rules are the
  // real enforcement layer regardless — the collector account can only
  // ever create brand-new docs, never update one that already exists.
  if (!isAdmin && oldId) {
    alert("Bạn không có quyền sửa tài sản đã tồn tại. Liên hệ quản trị viên (IT) nếu cần chỉnh sửa.");
    return;
  }

  const data = {
    employeeCode: $("employeeCode").value.trim(),
    user: $("user").value.trim(),
    section: $("section").value.trim(),
    group: $("group").value.trim(),
    code,
    type: $("type").value,
    deviceName: $("deviceName").value.trim(),
    model: $("model").value.trim(),
    serial: $("serial").value.trim(),
    ip: $("ip").value.trim(),
    mac: $("mac").value.trim(),
    spec: $("spec").value.trim(),
    winInfo: $("winInfo").value.trim(),
    status: $("status").value,
    checkStatus: $("checkStatus").value,
    note: $("note").value.trim(),
    photo: currentPhotoData || "",
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  // Admin can freely toggle the "locked" audit flag. The collector account
  // always creates records already marked locked:true — purely
  // informational now, since Firestore Rules block the collector from
  // updating any existing doc regardless of this flag.
  data.locked = isAdmin ? $("assetLocked").checked : true;

  // Ghi lịch sử thay đổi (vòng đời tài sản) — xem khối HISTORY_TRACK_FIELDS
  // ở đầu file. arrayUnion() nối thêm phần tử mới vào mảng `history` sẵn có
  // trên document, không cần đọc lại dữ liệu cũ từ server trước khi ghi.
  {
    const fieldChanges = diffAssetFields(oldAsset, data);
    let action, carriedHistory = [];
    if (!oldId) {
      action = "create";
    } else if (oldId !== newId) {
      action = "rename";
      fieldChanges.unshift({ field: "code", label: "Mã tài sản", from: oldAsset ? oldAsset.code : oldId, to: code });
      carriedHistory = (oldAsset && Array.isArray(oldAsset.history)) ? oldAsset.history : [];
    } else {
      action = "update";
    }
    if (action !== "update" || fieldChanges.length) {
      const entry = historyEntry(action, fieldChanges);
      data.history = firebase.firestore.FieldValue.arrayUnion(...carriedHistory, entry);
    }
  }

  // Chặn tạo/lưu tài sản trùng Serial với 1 tài sản khác đã có trong hệ
  // thống. Quan trọng nhất với tài khoản Collector: họ không sửa/xóa lại
  // được sau khi tạo, nên nếu để lọt tài sản trùng Serial thì chỉ Admin
  // mới dọn được — chặn ngay từ đầu để tránh phát sinh bản ghi trùng.
  if (data.serial) {
    const dup = assets.find(a => a._id !== oldId && (a.serial || "").trim().toLowerCase() === data.serial.toLowerCase());
    if (dup) {
      alert(`Serial "${data.serial}" đã tồn tại ở tài sản "${dup.code}". Không thể lưu tài sản trùng Serial.` +
        (isAdmin ? " Nếu đây thực sự là 1 thiết bị mới, kiểm tra lại Serial hoặc sửa tài sản cũ." :
          " Vui lòng kiểm tra lại, hoặc liên hệ Admin nếu tài sản cũ bị sai thông tin."));
      return;
    }
  }

  const submitBtn = $("assetFormEl").querySelector('button[type="submit"]');
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Đang lưu...";

  // IMPORTANT: do NOT await this. With offline persistence enabled, the write
  // is applied to the local cache synchronously and the UI (via onSnapshot)
  // updates right away. The returned Promise only resolves after the server
  // acknowledges the write — if the network/Firestore is unreachable (offline,
  // blocked by firewall, rules not published yet), that Promise can hang
  // indefinitely. Blocking the UI on it is what caused the "load mãi không
  // xong" symptom.
  const writeOp = db.collection(COLLECTION).doc(newId).set(data, { merge: true })
    .then(() => (oldId && oldId !== newId) ? db.collection(COLLECTION).doc(oldId).delete() : null)
    .catch(err => {
      alert("Lỗi đồng bộ lên máy chủ: " + err.message +
        "\n\nDữ liệu vẫn được lưu tạm trên máy này và sẽ tự thử lại. " +
        "Nếu lỗi là 'permission-denied', kiểm tra lại Firestore Rules đã Publish chưa.");
    });

  // Give the local write a brief moment to land in the cache, then proceed —
  // this keeps the UI responsive even fully offline.
  setTimeout(() => {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
    renderQR(code);
    $("assetId").value = newId;
    $("formTitle").textContent = "Sửa tài sản: " + code;
    goPage("assets");
  }, 150);

  // Safety net: if something is truly stuck for a long time, surface it
  // instead of failing silently.
  const stuckTimer = setTimeout(() => {
    console.warn("Firestore write for", newId, "has not resolved after 20s — check network/rules.");
  }, 20000);
  writeOp.finally(() => clearTimeout(stuckTimer));
});

/* ---------- QR generate ---------- */
function renderQR(code) {
  const box = $("qrcode");
  box.innerHTML = "";
  if (!code) { $("qrText").textContent = ""; return; }
  const text = "ITASSET:" + code;
  new QRCode(box, { text, width: 200, height: 200 });
  $("qrText").textContent = text;
}
$("code").addEventListener("blur", () => { if ($("code").value.trim()) renderQR($("code").value.trim()); });

$("downloadQR").addEventListener("click", () => {
  const box = $("qrcode");
  const canvas = box.querySelector("canvas");
  const img = box.querySelector("img");
  let dataUrl = "";
  if (canvas) dataUrl = canvas.toDataURL("image/png");
  else if (img) dataUrl = img.src;
  if (!dataUrl) { alert("Chưa có QR để lưu. Nhập Mã tài sản trước."); return; }
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = (($("code").value.trim() || "qr") + ".png");
  a.click();
});

/* ---------- In tem tài sản (mã + thông tin + QR) ---------- */
const DEFAULT_DOC_TITLE = document.title; // "IT Asset Inventory"
function printWithFilename(suggestedName) {
  // Trình duyệt dùng document.title làm tên file gợi ý khi chọn "Save as PDF".
  document.title = (suggestedName && String(suggestedName).trim()) || DEFAULT_DOC_TITLE;
  const restoreTitle = () => {
    document.title = DEFAULT_DOC_TITLE;
    window.removeEventListener("afterprint", restoreTitle);
  };
  window.addEventListener("afterprint", restoreTitle);
  window.print();
}
function renderPrintLabel(data) {
  $("plCode").textContent = data.code || "";
  $("plTypeModel").textContent = [data.type, data.model].filter(Boolean).join(" · ");
  $("plUser").textContent = data.user ? ("👤 " + data.user + (data.employeeCode ? ` (${data.employeeCode})` : "")) : "";
  $("plSection").textContent = data.section ? ("🏢 " + data.section) : "";
  $("plQr").innerHTML = "";
  new QRCode($("plQr"), { text: "ITASSET:" + (data.code || ""), width: 300, height: 300 });
}
window.printLabel = function (id) {
  const a = assets.find(x => x._id === id);
  if (!a) return;
  renderPrintLabel(a);
  setTimeout(() => printWithFilename(a.employeeCode || a.code), 150); // đợi QR render xong canvas rồi mới in
};
$("printLabelBtn").addEventListener("click", () => {
  const code = $("code").value.trim();
  if (!code) { alert("Nhập Mã tài sản trước khi in tem."); return; }
  const employeeCode = $("employeeCode").value.trim();
  renderPrintLabel({
    code,
    type: $("type").value,
    model: $("model").value.trim(),
    user: $("user").value.trim(),
    employeeCode,
    section: $("section").value.trim()
  });
  setTimeout(() => printWithFilename(employeeCode || code), 150);
});

/* ---------- Camera / photo ---------- */
function resizeImage(file, maxDim = 900, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
          else { width = Math.round(width * maxDim / height); height = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
$("takePhoto").addEventListener("click", () => $("photo").click());
$("photo").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const dataUrl = await resizeImage(file);
    currentPhotoData = dataUrl;
    $("photoPreview").src = dataUrl;
    $("photoPreview").classList.remove("hidden");
  } catch (err) {
    alert("Không đọc được ảnh: " + err.message);
  }
  e.target.value = "";
});

/* ---------- PowerShell helper + autofill ---------- */
const PS_SCRIPT = `# get-info.ps1 - Dán kết quả vào ô "Dán thông tin máy"
$cs = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$cpu = Get-CimInstance Win32_Processor
$ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB)
$disk = Get-CimInstance Win32_DiskDrive | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$verKey = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
$displayVer = (Get-ItemProperty $verKey -Name DisplayVersion -ErrorAction SilentlyContinue).DisplayVersion
$ubr = (Get-ItemProperty $verKey -Name UBR -ErrorAction SilentlyContinue).UBR
$edition = ($os.Caption -replace 'Microsoft ', '').Trim()
$winInfo = "$edition $displayVer (Build $($os.BuildNumber).$ubr)"
$active = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }
$ipParts = @()
$macParts = @()
foreach ($a in $active) {
  $ips = (Get-NetIPAddress -InterfaceIndex $a.IfIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254.*' }).IPAddress
  foreach ($ip in $ips) { $ipParts += $ip }
  $macParts += "$($a.Name)=$($a.MacAddress)"
}
Write-Output "===== KET QUA - COPY TU DAY ====="
Write-Output "TENMAY: $($cs.Name)"
Write-Output "MODEL: $($cs.Model)"
Write-Output "SERIAL: $($bios.SerialNumber)"
Write-Output "CAUHINH: $($cpu.Name) / RAM \${ramGB}GB / $($disk.Model)"
Write-Output "WININFO: $winInfo"
Write-Output "IP: $((($ipParts | Select-Object -Unique)) -join '; ')"
Write-Output "MAC: $(($macParts) -join '; ')"
Write-Output "===== HET - COPY DEN DAY ====="`;

$("btnCopyPS").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(PS_SCRIPT);
    alert("Đã copy lệnh PowerShell. Chạy trên máy Windows cần kiểm kê, sau đó CHỈ copy đoạn nằm giữa 2 dòng " +
      "\"===== KET QUA - COPY TU DAY =====\" và \"===== HET - COPY DEN DAY =====\", rồi dán vào ô bên dưới.");
  } catch (e) {
    prompt("Copy đoạn PowerShell sau:", PS_SCRIPT);
  }
});

// Script PowerShell dùng cho MÁY KHÔNG CÓ MẠNG: tự sinh 1 trang QR (nhúng sẵn
// thư viện tạo QR, không cần Internet) rồi tự mở bằng trình duyệt mặc định.
// Đưa điện thoại (đang mở app này) lên quét QR đó là form được tự điền —
// không cần gõ tay, không cần chép văn bản qua lại giữa 2 máy.
const PS_SCRIPT_QR = `# get-info-qr.ps1 - Dung khi may KHONG co mang. Chay xong se TU MO 1 trang QR
# tren trinh duyet may nay (khong can Internet). Dua dien thoai len quet QR do
# bang tinh nang "Quet QR" trong app se TU DIEN thong tin vao form, khong can go tay.
$cs = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$cpu = Get-CimInstance Win32_Processor
$ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB)
$disk = Get-CimInstance Win32_DiskDrive | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$verKey = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
$displayVer = (Get-ItemProperty $verKey -Name DisplayVersion -ErrorAction SilentlyContinue).DisplayVersion
$ubr = (Get-ItemProperty $verKey -Name UBR -ErrorAction SilentlyContinue).UBR
$edition = ($os.Caption -replace 'Microsoft ', '').Trim()
$winInfo = "$edition $displayVer (Build $($os.BuildNumber).$ubr)"
$active = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }
$ipParts = @()
$macParts = @()
foreach ($a in $active) {
  $ips = (Get-NetIPAddress -InterfaceIndex $a.IfIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254.*' }).IPAddress
  foreach ($ip in $ips) { $ipParts += $ip }
  $macParts += "$($a.Name)=$($a.MacAddress)"
}

$QRLIB_JS = @'
var QRCode;!function(){function a(a){this.mode=c.MODE_8BIT_BYTE,this.data=a,this.parsedData=[];for(var b=[],d=0,e=this.data.length;e>d;d++){var f=this.data.charCodeAt(d);f>65536?(b[0]=240|(1835008&f)>>>18,b[1]=128|(258048&f)>>>12,b[2]=128|(4032&f)>>>6,b[3]=128|63&f):f>2048?(b[0]=224|(61440&f)>>>12,b[1]=128|(4032&f)>>>6,b[2]=128|63&f):f>128?(b[0]=192|(1984&f)>>>6,b[1]=128|63&f):b[0]=f,this.parsedData=this.parsedData.concat(b)}this.parsedData.length!=this.data.length&&(this.parsedData.unshift(191),this.parsedData.unshift(187),this.parsedData.unshift(239))}function b(a,b){this.typeNumber=a,this.errorCorrectLevel=b,this.modules=null,this.moduleCount=0,this.dataCache=null,this.dataList=[]}function i(a,b){if(void 0==a.length)throw new Error(a.length+"/"+b);for(var c=0;c<a.length&&0==a[c];)c++;this.num=new Array(a.length-c+b);for(var d=0;d<a.length-c;d++)this.num[d]=a[d+c]}function j(a,b){this.totalCount=a,this.dataCount=b}function k(){this.buffer=[],this.length=0}function m(){return"undefined"!=typeof CanvasRenderingContext2D}function n(){var a=!1,b=navigator.userAgent;return/android/i.test(b)&&(a=!0,aMat=b.toString().match(/android ([0-9]\\.[0-9])/i),aMat&&aMat[1]&&(a=parseFloat(aMat[1]))),a}function r(a,b){for(var c=1,e=s(a),f=0,g=l.length;g>=f;f++){var h=0;switch(b){case d.L:h=l[f][0];break;case d.M:h=l[f][1];break;case d.Q:h=l[f][2];break;case d.H:h=l[f][3]}if(h>=e)break;c++}if(c>l.length)throw new Error("Too long data");return c}function s(a){var b=encodeURI(a).toString().replace(/\\%[0-9a-fA-F]{2}/g,"a");return b.length+(b.length!=a?3:0)}a.prototype={getLength:function(){return this.parsedData.length},write:function(a){for(var b=0,c=this.parsedData.length;c>b;b++)a.put(this.parsedData[b],8)}},b.prototype={addData:function(b){var c=new a(b);this.dataList.push(c),this.dataCache=null},isDark:function(a,b){if(0>a||this.moduleCount<=a||0>b||this.moduleCount<=b)throw new Error(a+","+b);return this.modules[a][b]},getModuleCount:function(){return this.moduleCount},make:function(){this.makeImpl(!1,this.getBestMaskPattern())},makeImpl:function(a,c){this.moduleCount=4*this.typeNumber+17,this.modules=new Array(this.moduleCount);for(var d=0;d<this.moduleCount;d++){this.modules[d]=new Array(this.moduleCount);for(var e=0;e<this.moduleCount;e++)this.modules[d][e]=null}this.setupPositionProbePattern(0,0),this.setupPositionProbePattern(this.moduleCount-7,0),this.setupPositionProbePattern(0,this.moduleCount-7),this.setupPositionAdjustPattern(),this.setupTimingPattern(),this.setupTypeInfo(a,c),this.typeNumber>=7&&this.setupTypeNumber(a),null==this.dataCache&&(this.dataCache=b.createData(this.typeNumber,this.errorCorrectLevel,this.dataList)),this.mapData(this.dataCache,c)},setupPositionProbePattern:function(a,b){for(var c=-1;7>=c;c++)if(!(-1>=a+c||this.moduleCount<=a+c))for(var d=-1;7>=d;d++)-1>=b+d||this.moduleCount<=b+d||(this.modules[a+c][b+d]=c>=0&&6>=c&&(0==d||6==d)||d>=0&&6>=d&&(0==c||6==c)||c>=2&&4>=c&&d>=2&&4>=d?!0:!1)},getBestMaskPattern:function(){for(var a=0,b=0,c=0;8>c;c++){this.makeImpl(!0,c);var d=f.getLostPoint(this);(0==c||a>d)&&(a=d,b=c)}return b},createMovieClip:function(a,b,c){var d=a.createEmptyMovieClip(b,c),e=1;this.make();for(var f=0;f<this.modules.length;f++)for(var g=f*e,h=0;h<this.modules[f].length;h++){var i=h*e,j=this.modules[f][h];j&&(d.beginFill(0,100),d.moveTo(i,g),d.lineTo(i+e,g),d.lineTo(i+e,g+e),d.lineTo(i,g+e),d.endFill())}return d},setupTimingPattern:function(){for(var a=8;a<this.moduleCount-8;a++)null==this.modules[a][6]&&(this.modules[a][6]=0==a%2);for(var b=8;b<this.moduleCount-8;b++)null==this.modules[6][b]&&(this.modules[6][b]=0==b%2)},setupPositionAdjustPattern:function(){for(var a=f.getPatternPosition(this.typeNumber),b=0;b<a.length;b++)for(var c=0;c<a.length;c++){var d=a[b],e=a[c];if(null==this.modules[d][e])for(var g=-2;2>=g;g++)for(var h=-2;2>=h;h++)this.modules[d+g][e+h]=-2==g||2==g||-2==h||2==h||0==g&&0==h?!0:!1}},setupTypeNumber:function(a){for(var b=f.getBCHTypeNumber(this.typeNumber),c=0;18>c;c++){var d=!a&&1==(1&b>>c);this.modules[Math.floor(c/3)][c%3+this.moduleCount-8-3]=d}for(var c=0;18>c;c++){var d=!a&&1==(1&b>>c);this.modules[c%3+this.moduleCount-8-3][Math.floor(c/3)]=d}},setupTypeInfo:function(a,b){for(var c=this.errorCorrectLevel<<3|b,d=f.getBCHTypeInfo(c),e=0;15>e;e++){var g=!a&&1==(1&d>>e);6>e?this.modules[e][8]=g:8>e?this.modules[e+1][8]=g:this.modules[this.moduleCount-15+e][8]=g}for(var e=0;15>e;e++){var g=!a&&1==(1&d>>e);8>e?this.modules[8][this.moduleCount-e-1]=g:9>e?this.modules[8][15-e-1+1]=g:this.modules[8][15-e-1]=g}this.modules[this.moduleCount-8][8]=!a},mapData:function(a,b){for(var c=-1,d=this.moduleCount-1,e=7,g=0,h=this.moduleCount-1;h>0;h-=2)for(6==h&&h--;;){for(var i=0;2>i;i++)if(null==this.modules[d][h-i]){var j=!1;g<a.length&&(j=1==(1&a[g]>>>e));var k=f.getMask(b,d,h-i);k&&(j=!j),this.modules[d][h-i]=j,e--,-1==e&&(g++,e=7)}if(d+=c,0>d||this.moduleCount<=d){d-=c,c=-c;break}}}},b.PAD0=236,b.PAD1=17,b.createData=function(a,c,d){for(var e=j.getRSBlocks(a,c),g=new k,h=0;h<d.length;h++){var i=d[h];g.put(i.mode,4),g.put(i.getLength(),f.getLengthInBits(i.mode,a)),i.write(g)}for(var l=0,h=0;h<e.length;h++)l+=e[h].dataCount;if(g.getLengthInBits()>8*l)throw new Error("code length overflow. ("+g.getLengthInBits()+">"+8*l+")");for(g.getLengthInBits()+4<=8*l&&g.put(0,4);0!=g.getLengthInBits()%8;)g.putBit(!1);for(;;){if(g.getLengthInBits()>=8*l)break;if(g.put(b.PAD0,8),g.getLengthInBits()>=8*l)break;g.put(b.PAD1,8)}return b.createBytes(g,e)},b.createBytes=function(a,b){for(var c=0,d=0,e=0,g=new Array(b.length),h=new Array(b.length),j=0;j<b.length;j++){var k=b[j].dataCount,l=b[j].totalCount-k;d=Math.max(d,k),e=Math.max(e,l),g[j]=new Array(k);for(var m=0;m<g[j].length;m++)g[j][m]=255&a.buffer[m+c];c+=k;var n=f.getErrorCorrectPolynomial(l),o=new i(g[j],n.getLength()-1),p=o.mod(n);h[j]=new Array(n.getLength()-1);for(var m=0;m<h[j].length;m++){var q=m+p.getLength()-h[j].length;h[j][m]=q>=0?p.get(q):0}}for(var r=0,m=0;m<b.length;m++)r+=b[m].totalCount;for(var s=new Array(r),t=0,m=0;d>m;m++)for(var j=0;j<b.length;j++)m<g[j].length&&(s[t++]=g[j][m]);for(var m=0;e>m;m++)for(var j=0;j<b.length;j++)m<h[j].length&&(s[t++]=h[j][m]);return s};for(var c={MODE_NUMBER:1,MODE_ALPHA_NUM:2,MODE_8BIT_BYTE:4,MODE_KANJI:8},d={L:1,M:0,Q:3,H:2},e={PATTERN000:0,PATTERN001:1,PATTERN010:2,PATTERN011:3,PATTERN100:4,PATTERN101:5,PATTERN110:6,PATTERN111:7},f={PATTERN_POSITION_TABLE:[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],G15:1335,G18:7973,G15_MASK:21522,getBCHTypeInfo:function(a){for(var b=a<<10;f.getBCHDigit(b)-f.getBCHDigit(f.G15)>=0;)b^=f.G15<<f.getBCHDigit(b)-f.getBCHDigit(f.G15);return(a<<10|b)^f.G15_MASK},getBCHTypeNumber:function(a){for(var b=a<<12;f.getBCHDigit(b)-f.getBCHDigit(f.G18)>=0;)b^=f.G18<<f.getBCHDigit(b)-f.getBCHDigit(f.G18);return a<<12|b},getBCHDigit:function(a){for(var b=0;0!=a;)b++,a>>>=1;return b},getPatternPosition:function(a){return f.PATTERN_POSITION_TABLE[a-1]},getMask:function(a,b,c){switch(a){case e.PATTERN000:return 0==(b+c)%2;case e.PATTERN001:return 0==b%2;case e.PATTERN010:return 0==c%3;case e.PATTERN011:return 0==(b+c)%3;case e.PATTERN100:return 0==(Math.floor(b/2)+Math.floor(c/3))%2;case e.PATTERN101:return 0==b*c%2+b*c%3;case e.PATTERN110:return 0==(b*c%2+b*c%3)%2;case e.PATTERN111:return 0==(b*c%3+(b+c)%2)%2;default:throw new Error("bad maskPattern:"+a)}},getErrorCorrectPolynomial:function(a){for(var b=new i([1],0),c=0;a>c;c++)b=b.multiply(new i([1,g.gexp(c)],0));return b},getLengthInBits:function(a,b){if(b>=1&&10>b)switch(a){case c.MODE_NUMBER:return 10;case c.MODE_ALPHA_NUM:return 9;case c.MODE_8BIT_BYTE:return 8;case c.MODE_KANJI:return 8;default:throw new Error("mode:"+a)}else if(27>b)switch(a){case c.MODE_NUMBER:return 12;case c.MODE_ALPHA_NUM:return 11;case c.MODE_8BIT_BYTE:return 16;case c.MODE_KANJI:return 10;default:throw new Error("mode:"+a)}else{if(!(41>b))throw new Error("type:"+b);switch(a){case c.MODE_NUMBER:return 14;case c.MODE_ALPHA_NUM:return 13;case c.MODE_8BIT_BYTE:return 16;case c.MODE_KANJI:return 12;default:throw new Error("mode:"+a)}}},getLostPoint:function(a){for(var b=a.getModuleCount(),c=0,d=0;b>d;d++)for(var e=0;b>e;e++){for(var f=0,g=a.isDark(d,e),h=-1;1>=h;h++)if(!(0>d+h||d+h>=b))for(var i=-1;1>=i;i++)0>e+i||e+i>=b||(0!=h||0!=i)&&g==a.isDark(d+h,e+i)&&f++;f>5&&(c+=3+f-5)}for(var d=0;b-1>d;d++)for(var e=0;b-1>e;e++){var j=0;a.isDark(d,e)&&j++,a.isDark(d+1,e)&&j++,a.isDark(d,e+1)&&j++,a.isDark(d+1,e+1)&&j++,(0==j||4==j)&&(c+=3)}for(var d=0;b>d;d++)for(var e=0;b-6>e;e++)a.isDark(d,e)&&!a.isDark(d,e+1)&&a.isDark(d,e+2)&&a.isDark(d,e+3)&&a.isDark(d,e+4)&&!a.isDark(d,e+5)&&a.isDark(d,e+6)&&(c+=40);for(var e=0;b>e;e++)for(var d=0;b-6>d;d++)a.isDark(d,e)&&!a.isDark(d+1,e)&&a.isDark(d+2,e)&&a.isDark(d+3,e)&&a.isDark(d+4,e)&&!a.isDark(d+5,e)&&a.isDark(d+6,e)&&(c+=40);for(var k=0,e=0;b>e;e++)for(var d=0;b>d;d++)a.isDark(d,e)&&k++;var l=Math.abs(100*k/b/b-50)/5;return c+=10*l}},g={glog:function(a){if(1>a)throw new Error("glog("+a+")");return g.LOG_TABLE[a]},gexp:function(a){for(;0>a;)a+=255;for(;a>=256;)a-=255;return g.EXP_TABLE[a]},EXP_TABLE:new Array(256),LOG_TABLE:new Array(256)},h=0;8>h;h++)g.EXP_TABLE[h]=1<<h;for(var h=8;256>h;h++)g.EXP_TABLE[h]=g.EXP_TABLE[h-4]^g.EXP_TABLE[h-5]^g.EXP_TABLE[h-6]^g.EXP_TABLE[h-8];for(var h=0;255>h;h++)g.LOG_TABLE[g.EXP_TABLE[h]]=h;i.prototype={get:function(a){return this.num[a]},getLength:function(){return this.num.length},multiply:function(a){for(var b=new Array(this.getLength()+a.getLength()-1),c=0;c<this.getLength();c++)for(var d=0;d<a.getLength();d++)b[c+d]^=g.gexp(g.glog(this.get(c))+g.glog(a.get(d)));return new i(b,0)},mod:function(a){if(this.getLength()-a.getLength()<0)return this;for(var b=g.glog(this.get(0))-g.glog(a.get(0)),c=new Array(this.getLength()),d=0;d<this.getLength();d++)c[d]=this.get(d);for(var d=0;d<a.getLength();d++)c[d]^=g.gexp(g.glog(a.get(d))+b);return new i(c,0).mod(a)}},j.RS_BLOCK_TABLE=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],j.getRSBlocks=function(a,b){var c=j.getRsBlockTable(a,b);if(void 0==c)throw new Error("bad rs block @ typeNumber:"+a+"/errorCorrectLevel:"+b);for(var d=c.length/3,e=[],f=0;d>f;f++)for(var g=c[3*f+0],h=c[3*f+1],i=c[3*f+2],k=0;g>k;k++)e.push(new j(h,i));return e},j.getRsBlockTable=function(a,b){switch(b){case d.L:return j.RS_BLOCK_TABLE[4*(a-1)+0];case d.M:return j.RS_BLOCK_TABLE[4*(a-1)+1];case d.Q:return j.RS_BLOCK_TABLE[4*(a-1)+2];case d.H:return j.RS_BLOCK_TABLE[4*(a-1)+3];default:return void 0}},k.prototype={get:function(a){var b=Math.floor(a/8);return 1==(1&this.buffer[b]>>>7-a%8)},put:function(a,b){for(var c=0;b>c;c++)this.putBit(1==(1&a>>>b-c-1))},getLengthInBits:function(){return this.length},putBit:function(a){var b=Math.floor(this.length/8);this.buffer.length<=b&&this.buffer.push(0),a&&(this.buffer[b]|=128>>>this.length%8),this.length++}};var l=[[17,14,11,7],[32,26,20,14],[53,42,32,24],[78,62,46,34],[106,84,60,44],[134,106,74,58],[154,122,86,64],[192,152,108,84],[230,180,130,98],[271,213,151,119],[321,251,177,137],[367,287,203,155],[425,331,241,177],[458,362,258,194],[520,412,292,220],[586,450,322,250],[644,504,364,280],[718,560,394,310],[792,624,442,338],[858,666,482,382],[929,711,509,403],[1003,779,565,439],[1091,857,611,461],[1171,911,661,511],[1273,997,715,535],[1367,1059,751,593],[1465,1125,805,625],[1528,1190,868,658],[1628,1264,908,698],[1732,1370,982,742],[1840,1452,1030,790],[1952,1538,1112,842],[2068,1628,1168,898],[2188,1722,1228,958],[2303,1809,1283,983],[2431,1911,1351,1051],[2563,1989,1423,1093],[2699,2099,1499,1139],[2809,2213,1579,1219],[2953,2331,1663,1273]],o=function(){var a=function(a,b){this._el=a,this._htOption=b};return a.prototype.draw=function(a){function g(a,b){var c=document.createElementNS("http://www.w3.org/2000/svg",a);for(var d in b)b.hasOwnProperty(d)&&c.setAttribute(d,b[d]);return c}var b=this._htOption,c=this._el,d=a.getModuleCount();Math.floor(b.width/d),Math.floor(b.height/d),this.clear();var h=g("svg",{viewBox:"0 0 "+String(d)+" "+String(d),width:"100%",height:"100%",fill:b.colorLight});h.setAttributeNS("http://www.w3.org/2000/xmlns/","xmlns:xlink","http://www.w3.org/1999/xlink"),c.appendChild(h),h.appendChild(g("rect",{fill:b.colorDark,width:"1",height:"1",id:"template"}));for(var i=0;d>i;i++)for(var j=0;d>j;j++)if(a.isDark(i,j)){var k=g("use",{x:String(i),y:String(j)});k.setAttributeNS("http://www.w3.org/1999/xlink","href","#template"),h.appendChild(k)}},a.prototype.clear=function(){for(;this._el.hasChildNodes();)this._el.removeChild(this._el.lastChild)},a}(),p="svg"===document.documentElement.tagName.toLowerCase(),q=p?o:m()?function(){function a(){this._elImage.src=this._elCanvas.toDataURL("image/png"),this._elImage.style.display="block",this._elCanvas.style.display="none"}function d(a,b){var c=this;if(c._fFail=b,c._fSuccess=a,null===c._bSupportDataURI){var d=document.createElement("img"),e=function(){c._bSupportDataURI=!1,c._fFail&&_fFail.call(c)},f=function(){c._bSupportDataURI=!0,c._fSuccess&&c._fSuccess.call(c)};return d.onabort=e,d.onerror=e,d.onload=f,d.src="data:image/gif;base64,iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==",void 0}c._bSupportDataURI===!0&&c._fSuccess?c._fSuccess.call(c):c._bSupportDataURI===!1&&c._fFail&&c._fFail.call(c)}if(this._android&&this._android<=2.1){var b=1/window.devicePixelRatio,c=CanvasRenderingContext2D.prototype.drawImage;CanvasRenderingContext2D.prototype.drawImage=function(a,d,e,f,g,h,i,j){if("nodeName"in a&&/img/i.test(a.nodeName))for(var l=arguments.length-1;l>=1;l--)arguments[l]=arguments[l]*b;else"undefined"==typeof j&&(arguments[1]*=b,arguments[2]*=b,arguments[3]*=b,arguments[4]*=b);c.apply(this,arguments)}}var e=function(a,b){this._bIsPainted=!1,this._android=n(),this._htOption=b,this._elCanvas=document.createElement("canvas"),this._elCanvas.width=b.width,this._elCanvas.height=b.height,a.appendChild(this._elCanvas),this._el=a,this._oContext=this._elCanvas.getContext("2d"),this._bIsPainted=!1,this._elImage=document.createElement("img"),this._elImage.style.display="none",this._el.appendChild(this._elImage),this._bSupportDataURI=null};return e.prototype.draw=function(a){var b=this._elImage,c=this._oContext,d=this._htOption,e=a.getModuleCount(),f=d.width/e,g=d.height/e,h=Math.round(f),i=Math.round(g);b.style.display="none",this.clear();for(var j=0;e>j;j++)for(var k=0;e>k;k++){var l=a.isDark(j,k),m=k*f,n=j*g;c.strokeStyle=l?d.colorDark:d.colorLight,c.lineWidth=1,c.fillStyle=l?d.colorDark:d.colorLight,c.fillRect(m,n,f,g),c.strokeRect(Math.floor(m)+.5,Math.floor(n)+.5,h,i),c.strokeRect(Math.ceil(m)-.5,Math.ceil(n)-.5,h,i)}this._bIsPainted=!0},e.prototype.makeImage=function(){this._bIsPainted&&d.call(this,a)},e.prototype.isPainted=function(){return this._bIsPainted},e.prototype.clear=function(){this._oContext.clearRect(0,0,this._elCanvas.width,this._elCanvas.height),this._bIsPainted=!1},e.prototype.round=function(a){return a?Math.floor(1e3*a)/1e3:a},e}():function(){var a=function(a,b){this._el=a,this._htOption=b};return a.prototype.draw=function(a){for(var b=this._htOption,c=this._el,d=a.getModuleCount(),e=Math.floor(b.width/d),f=Math.floor(b.height/d),g=['<table style="border:0;border-collapse:collapse;">'],h=0;d>h;h++){g.push("<tr>");for(var i=0;d>i;i++)g.push('<td style="border:0;border-collapse:collapse;padding:0;margin:0;width:'+e+"px;height:"+f+"px;background-color:"+(a.isDark(h,i)?b.colorDark:b.colorLight)+';"></td>');g.push("</tr>")}g.push("</table>"),c.innerHTML=g.join("");var j=c.childNodes[0],k=(b.width-j.offsetWidth)/2,l=(b.height-j.offsetHeight)/2;k>0&&l>0&&(j.style.margin=l+"px "+k+"px")},a.prototype.clear=function(){this._el.innerHTML=""},a}();QRCode=function(a,b){if(this._htOption={width:256,height:256,typeNumber:4,colorDark:"#000000",colorLight:"#ffffff",correctLevel:d.H},"string"==typeof b&&(b={text:b}),b)for(var c in b)this._htOption[c]=b[c];"string"==typeof a&&(a=document.getElementById(a)),this._android=n(),this._el=a,this._oQRCode=null,this._oDrawing=new q(this._el,this._htOption),this._htOption.text&&this.makeCode(this._htOption.text)},QRCode.prototype.makeCode=function(a){this._oQRCode=new b(r(a,this._htOption.correctLevel),this._htOption.correctLevel),this._oQRCode.addData(a),this._oQRCode.make(),this._el.title=a,this._oDrawing.draw(this._oQRCode),this.makeImage()},QRCode.prototype.makeImage=function(){"function"==typeof this._oDrawing.makeImage&&(!this._android||this._android>=3)&&this._oDrawing.makeImage()},QRCode.prototype.clear=function(){this._oDrawing.clear()},QRCode.CorrectLevel=d}();
'@

function Esc($s) {
  if ($null -eq $s) { return "" }
  ($s.ToString() -replace '&','&amp;' -replace '<','&lt;' -replace '>','&gt;')
}

$info = [ordered]@{
  TENMAY  = $cs.Name
  MODEL   = $cs.Model
  SERIAL  = $bios.SerialNumber
  CAUHINH = "$($cpu.Name) / RAM \${ramGB}GB / $($disk.Model)"
  WININFO = $winInfo
  IP      = (($ipParts | Select-Object -Unique) -join '; ')
  MAC     = ($macParts -join '; ')
}

Write-Output "===== KET QUA (du phong, van dung duoc voi khung Dan thong tin may) ====="
$info.GetEnumerator() | ForEach-Object { Write-Output "$($_.Key): $($_.Value)" }
Write-Output "===== HET ====="

$json = $info | ConvertTo-Json -Compress
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
$rowsHtml = ($info.GetEnumerator() | ForEach-Object { "<div class=\`"row\`"><b>$($_.Key)</b><span>$(Esc $_.Value)</span></div>" }) -join "\`n"

$HTML_TEMPLATE = @'
<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QR kiem ke - __TENMAY__</title>
<style>
body{margin:0;background:#0f172a;color:#f1f5f9;font-family:system-ui,Segoe UI,Roboto,sans-serif;padding:20px;text-align:center}
h1{font-size:18px;margin:0 0 4px}
.hint{color:#94a3b8;font-size:13px;margin:0 0 18px}
#qr{background:#fff;display:inline-block;padding:14px;border-radius:14px}
.rows{max-width:420px;margin:18px auto 0;text-align:left;background:#1e293b;border-radius:12px;padding:6px 14px}
.row{padding:8px 0;border-bottom:1px solid #334155;font-size:13px;word-break:break-word}
.row:last-child{border-bottom:0}
.row b{display:block;color:#93c5fd;font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px}
</style></head>
<body>
<h1>QR kiem ke thiet bi</h1>
<p class="hint">Mo app IT Asset Inventory tren dien thoai -&gt; Quet QR -&gt; dua camera vao ma nay.<br>Trang nay chay hoan toan offline, khong can Internet.</p>
<div id="qr"></div>
<div class="rows">__ROWS__</div>
<script>__QRLIB__</script>
<script>new QRCode(document.getElementById("qr"), { text: "DEVINFO:__B64__", width: 300, height: 300 });</script>
</body></html>
'@

$html = $HTML_TEMPLATE.Replace('__TENMAY__', (Esc $cs.Name)).Replace('__ROWS__', $rowsHtml).Replace('__B64__', $b64).Replace('__QRLIB__', $QRLIB_JS)

$outPath = Join-Path $env:TEMP ("asset-qr-{0}-{1}.html" -f ($cs.Name -replace '[^A-Za-z0-9_-]','_'), (Get-Date -Format "yyyyMMdd-HHmmss"))
[System.IO.File]::WriteAllText($outPath, $html, [System.Text.Encoding]::UTF8)
Start-Process $outPath
Write-Output "Da mo trang QR: $outPath"
Write-Output "Neu trinh duyet khong tu mo, hay mo file nay bang tay roi dua dien thoai len quet."`;

$("btnCopyPSQR").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(PS_SCRIPT_QR);
    alert("Đã copy lệnh PowerShell (bản tạo QR). Chạy trên máy Windows KHÔNG CÓ MẠNG cần kiểm kê — " +
      "script sẽ tự mở 1 trang có mã QR ngay trên máy đó (không cần Internet). " +
      "Bấm \"▶ Bắt đầu quét\" ở đây rồi đưa điện thoại lên quét mã QR đó, form sẽ tự điền.");
  } catch (e) {
    prompt("Copy đoạn PowerShell sau (bản tạo QR):", PS_SCRIPT_QR);
  }
});

$("btnAutofill").addEventListener("click", () => {
  const text = $("pasteInfoBox").value;
  if (!text.trim()) { alert("Chưa có nội dung để tự động điền."); return; }

  const map = { TENMAY: "deviceName", MODEL: "model", SERIAL: "serial", CAUHINH: "spec", WININFO: "winInfo", IP: "ip", MAC: "mac" };
  let filled = 0;
  text.split("\n").forEach(line => {
    const m = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+)\s*$/);
    if (!m) return;
    const key = m[1].trim().toUpperCase();
    const val = m[2].trim();
    if (map[key] && val) { $(map[key]).value = val; filled++; }
  });

  if (filled === 0) {
    if (/Write-Output|Get-CimInstance|^\s*#\s*get-info\.ps1/im.test(text)) {
      alert("Ô này cần dán KẾT QUẢ sau khi chạy lệnh PowerShell, không phải đoạn lệnh. " +
        "Hãy chạy lệnh trên máy Windows trước, rồi copy phần kết quả in ra (MODEL:, SERIAL:...) và dán lại vào đây.");
    } else {
      alert("Không nhận diện được trường nào. Kiểm tra lại nội dung dán vào có đúng định dạng " +
        "\"MODEL: ...\", \"SERIAL: ...\", \"CAUHINH: ...\", \"IP: ...\", \"MAC: ...\" không.");
    }
    return;
  }
  if (!/^\s*MAC\s*:/im.test(text) || !/^\s*IP\s*:/im.test(text)) {
    if (!confirm(`Đã điền ${filled} trường, nhưng có vẻ thiếu dòng IP hoặc MAC (có thể do copy chưa hết). ` +
      "Bấm OK để giữ những gì đã điền, hoặc Cancel để dán lại đầy đủ hơn rồi thử lại.")) return;
  }
  alert(`Đã tự động điền ${filled} trường.`);
});

/* ---------- QR Scanning ---------- */
$("startScan").addEventListener("click", startScanner);
$("stopScan").addEventListener("click", stopScanner);

function startScanner() {
  if (scanning) return;
  html5QrCode = new Html5Qrcode("reader");
  scanning = true;
  html5QrCode.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: 250 },
    onScanSuccess,
    () => {}
  ).catch(err => {
    scanning = false;
    alert("Không mở được camera: " + err);
  });
}
function stopScanner() {
  if (!scanning || !html5QrCode) { scanning = false; return; }
  html5QrCode.stop().then(() => html5QrCode.clear()).catch(() => {}).finally(() => { scanning = false; });
}
// QR do script PowerShell offline (get-info-qr.ps1) sinh ra, chứa JSON base64
// các trường lấy được từ máy (không có Serial thật của model/hãng nào cần mạng).
// Payload dạng: DEVINFO:<base64(JSON UTF-8)> với JSON = {TENMAY,MODEL,SERIAL,CAUHINH,WININFO,IP,MAC}
function b64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}
function onDevInfoScan(b64) {
  let data;
  try { data = JSON.parse(b64ToUtf8(b64)); } catch (e) {
    alert("QR không đọc được (dữ liệu lỗi). Hãy tạo lại QR trên máy cần kiểm kê.");
    return;
  }
  clearForm();
  $("deviceName").value = data.TENMAY || "";
  $("model").value = data.MODEL || "";
  $("serial").value = data.SERIAL || "";
  $("spec").value = data.CAUHINH || "";
  $("winInfo").value = data.WININFO || "";
  $("ip").value = data.IP || "";
  $("mac").value = data.MAC || "";
  goPage("assetForm");
  toast(`Đã điền thông tin từ QR (${data.TENMAY || "máy không tên"}). Chọn Loại thiết bị/Bộ phận rồi lưu.`);
}
function onScanSuccess(decodedText) {
  if (decodedText.startsWith("DEVINFO:")) {
    stopScanner();
    onDevInfoScan(decodedText.slice(8).trim());
    return;
  }
  if (!decodedText.startsWith("ITASSET:")) return;
  const code = decodedText.slice(8).trim();
  stopScanner();
  const resBox = $("scanResult");
  resBox.classList.remove("hidden");
  const existing = assets.find(a => a.code === code);
  if (existing) {
    const rows = [
      ["💻 Tên tài sản", existing.deviceName],
      ["🔢 Serial", existing.serial],
      ["👤 Người sử dụng", existing.user],
      ["🆔 Mã nhân viên", existing.employeeCode],
    ].filter(([, v]) => v)
     .map(([label, v]) => `<div class="scan-row"><span class="muted">${label}</span> ${escapeHtml(v)}</div>`)
     .join("");
    resBox.innerHTML = `<b>${escapeHtml(code)}</b> — ${escapeHtml(existing.model || existing.type || "")}<br>
      <span class="badge ${badgeClass(existing.checkStatus)}">${escapeHtml(existing.checkStatus || CHECK_UNCHECKED)}</span>
      ${rows ? `<div class="scan-info">${rows}</div>` : ""}
      <button style="margin-top:8px" onclick="editAsset('${existing._id}')">Mở để cập nhật kiểm kê</button>`;
  } else {
    resBox.innerHTML = `<b>${escapeHtml(code)}</b> — chưa có trong hệ thống.<br>
      <button style="margin-top:8px" onclick="quickCreate('${escapeHtml(code)}')">Tạo tài sản mới với mã này</button>`;
  }
}
window.quickCreate = function (code) {
  clearForm();
  codeAutoFilled = false; // mã đến từ QR đã in trước đó — giữ nguyên, không tự gợi ý đè lên
  $("code").value = code;
  renderQR(code);
  goPage("assetForm");
};

/* ---------- Excel export/import ---------- */
// Thứ tự cột export/import PHẢI khớp đúng thứ tự các trường trên form #assetFormEl (index.html).
// Sửa thứ tự ở đây thì cũng sửa lại thứ tự tương ứng trên form, và ngược lại.
const COLUMNS = [
  "employeeCode", // Mã nhân viên
  "user",         // Người sử dụng
  "section",      // Bộ phận (Section)
  "group",        // Tổ/Chuyền (Group)
  "code",         // Mã tài sản
  "type",         // Loại thiết bị
  "deviceName",   // Tên tài sản (device name)
  "model",        // Model
  "serial",       // Serial Number
  "ip",           // IP
  "mac",          // MAC
  "spec",         // Cấu hình
  "winInfo",      // Thông tin Windows
  "status",       // Tình trạng
  "checkStatus",  // Trạng thái kiểm kê
  "note",         // Ghi chú
];
const COLUMN_LABELS_VN = {
  employeeCode: "Mã nhân viên", user: "Người sử dụng", section: "Bộ phận", group: "Tổ/Chuyền",
  code: "Mã tài sản", type: "Loại thiết bị", deviceName: "Tên tài sản", model: "Model", serial: "Serial",
  ip: "IP", mac: "MAC", spec: "Cấu hình", winInfo: "Thông tin Windows",
  status: "Tình trạng", checkStatus: "Trạng thái kiểm kê", note: "Ghi chú"
};
const HEADER_MAP = {};
COLUMNS.forEach(c => {
  HEADER_MAP[c.toLowerCase()] = c;
  HEADER_MAP[COLUMN_LABELS_VN[c].toLowerCase()] = c;
});

$("exportXlsx").addEventListener("click", () => {
  if (!assets.length) { alert("Chưa có dữ liệu để xuất."); return; }
  const rows = assets.map(a => {
    const row = {};
    COLUMNS.forEach(c => { row[COLUMN_LABELS_VN[c]] = a[c] || ""; });
    return row;
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Assets");
  const ts = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `it-asset-inventory-${ts}.xlsx`);
});

/* ---------- PDF report export ----------
   Xuất báo cáo kiểm kê dạng PDF: trang bìa + thống kê tổng quan (thẻ số liệu
   + biểu đồ tròn) + biểu đồ theo Bộ phận/Loại thiết bị/Tình trạng + bảng chi
   tiết toàn bộ tài sản (màu theo trạng thái kiểm kê). Dùng dữ liệu thật từ
   Firestore (biến `assets`). Vẽ report bằng HTML/CSS ẩn ngoài màn hình +
   Chart.js cho biểu đồ, rồi chụp từng "trang" bằng html2canvas và ghép vào
   PDF bằng jsPDF — cách này giữ được dấu tiếng Việt chính xác vì dùng font
   của trình duyệt thay vì nhúng font vào PDF.
*/
const PDF_PALETTE = {
  navy: "#0f172a", blue: "#2563eb", blueLight: "#93c5fd", slate: "#64748b",
  slateLight: "#f1f5f9", green: "#16a34a", greenBg: "#dcfce7",
  amber: "#d97706", amberBg: "#fef3c7", red: "#dc2626", redBg: "#fee2e2"
};
const PDF_CHART_COLORS = ["#2563eb", "#0ea5e9", "#7c3aed", "#16a34a", "#f59e0b", "#dc2626", "#0f766e", "#db2777", "#64748b", "#84cc16"];
const PDF_STATUS_COLORS = { "Tốt": "#16a34a", "Đang sử dụng": "#2563eb", "Dự phòng": "#0ea5e9", "Hỏng": "#dc2626", "Mất": "#7c2d12", "Thanh lý": "#94a3b8" };

function ensurePdfReportStyles() {
  if ($("pdfReportStyles")) return;
  const style = document.createElement("style");
  style.id = "pdfReportStyles";
  style.textContent = `
  #pdfReportRoot{position:fixed; left:-99999px; top:0; width:794px; font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
  .pdf-page{width:794px; min-height:1123px; box-sizing:border-box; background:#fff; position:relative; overflow:hidden;}
  .pdf-cover{background:${PDF_PALETTE.navy}; color:#fff; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center;}
  .pdf-cover .pdf-blob1{position:absolute; top:-60px; right:-60px; width:220px; height:220px; border-radius:50%; background:${PDF_PALETTE.blue}; opacity:.55}
  .pdf-cover .pdf-blob2{position:absolute; bottom:-60px; left:-60px; width:180px; height:180px; border-radius:50%; background:#0ea5e9; opacity:.5}
  .pdf-cover .pdf-icon{width:70px; height:86px; background:${PDF_PALETTE.blue}; border-radius:12px; display:flex; align-items:center; justify-content:center; margin-bottom:28px}
  .pdf-cover .pdf-icon-inner{width:54px; height:68px; background:#fff; border-radius:6px; position:relative}
  .pdf-cover .pdf-icon-inner:before{content:"";position:absolute;top:-8px;left:50%;transform:translateX(-50%);width:22px;height:10px;background:${PDF_PALETTE.blue};border-radius:4px}
  .pdf-cover h1{font-size:30px; margin:0 0 10px; letter-spacing:.5px}
  .pdf-cover .pdf-sub{font-size:16px; color:${PDF_PALETTE.blueLight}; margin-bottom:18px}
  .pdf-cover .pdf-meta{font-size:12px; color:#cbd5e1; line-height:1.6}
  .pdf-content{padding:36px 40px 60px}
  .pdf-header{background:${PDF_PALETTE.navy}; color:#fff; padding:14px 40px; display:flex; justify-content:space-between; align-items:center; font-weight:700; font-size:14px}
  .pdf-header span:last-child{font-weight:400; color:${PDF_PALETTE.blueLight}; font-size:11px}
  .pdf-h1{font-size:20px; font-weight:800; color:${PDF_PALETTE.navy}; margin:0 0 6px}
  .pdf-hr{border:none; border-top:1px solid #e2e8f0; margin:0 0 14px}
  .pdf-body{font-size:12px; color:#334155; line-height:1.5}
  .pdf-cards{display:flex; gap:10px; margin:14px 0}
  .pdf-card{flex:1; background:#fff; border:1px solid #e2e8f0; border-radius:10px; text-align:center; padding:14px 6px 10px; border-top:4px solid var(--accent)}
  .pdf-card b{display:block; font-size:26px; color:var(--accent)}
  .pdf-card span{font-size:11px; color:${PDF_PALETTE.slate}}
  .pdf-progress-wrap{margin:14px 0 22px}
  .pdf-progress-bar{height:9px; border-radius:6px; background:#e2e8f0; overflow:hidden; margin-top:6px}
  .pdf-progress-bar i{display:block; height:100%; background:${PDF_PALETTE.blue}}
  .pdf-h2{font-size:15px; font-weight:800; color:${PDF_PALETTE.navy}; margin:22px 0 10px}
  .pdf-chart-box{text-align:center}
  .pdf-legend{display:flex; gap:18px; align-items:center; font-size:11px; color:${PDF_PALETTE.slate}; margin-top:14px; flex-wrap:wrap}
  .pdf-legend i{display:inline-block; width:11px; height:11px; border-radius:3px; margin-right:5px; vertical-align:middle}
  table.pdf-table{width:100%; border-collapse:collapse; font-size:10.5px; table-layout:fixed}
  table.pdf-table thead th{background:${PDF_PALETTE.navy}; color:#fff; text-align:left; padding:8px 8px; font-size:10px}
  table.pdf-table tbody td{padding:6px 8px; border-bottom:1px solid #e2e8f0; vertical-align:top; word-break:break-word}
  table.pdf-table tbody tr:nth-child(even) td{background:${PDF_PALETTE.slateLight}}
  table.pdf-table th:nth-child(1),table.pdf-table td:nth-child(1){width:14%}
  table.pdf-table th:nth-child(2),table.pdf-table td:nth-child(2){width:11%}
  table.pdf-table th:nth-child(3),table.pdf-table td:nth-child(3){width:16%}
  table.pdf-table th:nth-child(4),table.pdf-table td:nth-child(4){width:16%}
  table.pdf-table th:nth-child(5),table.pdf-table td:nth-child(5){width:20%}
  table.pdf-table th:nth-child(6),table.pdf-table td:nth-child(6){width:11%}
  table.pdf-table th:nth-child(7),table.pdf-table td:nth-child(7){width:12%}
  .pdf-badge{display:inline-block; padding:2px 8px; border-radius:999px; font-weight:700; font-size:9.5px; white-space:nowrap}
  .pdf-footer{position:absolute; bottom:18px; left:40px; right:40px; display:flex; justify-content:space-between; font-size:9px; color:${PDF_PALETTE.slate}; border-top:1px solid #e2e8f0; padding-top:6px}
  `;
  document.head.appendChild(style);
}

function pdfBadgeColors(status) {
  const c = classifyCheck(status);
  if (c === "checked") return { bg: PDF_PALETTE.greenBg, fg: PDF_PALETTE.green };
  if (c === "exception") return { bg: PDF_PALETTE.redBg, fg: PDF_PALETTE.red };
  return { bg: PDF_PALETTE.amberBg, fg: PDF_PALETTE.amber };
}

async function generatePdfReport() {
  if (!window.jspdf || !window.html2canvas || !window.Chart) {
    alert("Không tải được thư viện xuất PDF (cần Internet ở lần đầu). Kiểm tra kết nối mạng rồi thử lại.");
    return;
  }
  if (!assets.length) { alert("Chưa có dữ liệu để xuất báo cáo."); return; }

  const btn = $("exportPdfReport");
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⏳ Đang tạo PDF...";

  ensurePdfReportStyles();
  const root = document.createElement("div");
  root.id = "pdfReportRoot";
  document.body.appendChild(root);
  const chartInstances = [];

  try {
    const list = assets.slice().sort((a, b) => (a.code || "").localeCompare(b.code || ""));
    const total = list.length;
    let checked = 0, unchecked = 0, exception = 0;
    const bySection = {}, byType = {}, byStatus = {};
    list.forEach(a => {
      const c = classifyCheck(a.checkStatus);
      if (c === "checked") checked++; else if (c === "exception") exception++; else unchecked++;
      const sec = (a.section || "").trim() || "Chưa gán";
      bySection[sec] = (bySection[sec] || 0) + 1;
      const typ = a.type || "Khác";
      byType[typ] = (byType[typ] || 0) + 1;
      const st = a.status || "Không rõ";
      byStatus[st] = (byStatus[st] || 0) + 1;
    });
    const pct = total ? Math.round((checked / total) * 100) : 0;
    const now = new Date();
    const dateStr = now.toLocaleDateString("vi-VN");
    const headerBar = `<div class="pdf-header"><span>BÁO CÁO KIỂM KÊ TÀI SẢN IT</span><span>SEC — IT Asset Inventory</span></div>`;
    const footerBar = pageNum => `<div class="pdf-footer"><span>Xuất ngày ${dateStr}</span><span>Trang ${pageNum}</span></div>`;

    /* ---- Trang bìa ---- */
    const cover = document.createElement("div");
    cover.className = "pdf-page pdf-cover";
    cover.innerHTML = `
      <div class="pdf-blob1"></div><div class="pdf-blob2"></div>
      <div class="pdf-icon"><div class="pdf-icon-inner"></div></div>
      <h1>BÁO CÁO KIỂM KÊ TÀI SẢN IT</h1>
      <div class="pdf-sub">SEC — IT Asset Inventory</div>
      <div class="pdf-meta">Ngày xuất báo cáo: ${dateStr}<br>Tổng số tài sản: ${total}</div>`;
    root.appendChild(cover);

    /* ---- Trang tổng quan ---- */
    const overview = document.createElement("div");
    overview.className = "pdf-page";
    overview.innerHTML = `
      ${headerBar}
      <div class="pdf-content">
        <div class="pdf-h1">1. Thống kê tổng quan</div>
        <hr class="pdf-hr">
        <div class="pdf-cards">
          <div class="pdf-card" style="--accent:${PDF_PALETTE.blue}"><b>${total}</b><span>Tổng tài sản</span></div>
          <div class="pdf-card" style="--accent:${PDF_PALETTE.green}"><b>${checked}</b><span>Đã kiểm</span></div>
          <div class="pdf-card" style="--accent:${PDF_PALETTE.amber}"><b>${unchecked}</b><span>Chưa kiểm</span></div>
          <div class="pdf-card" style="--accent:${PDF_PALETTE.red}"><b>${exception}</b><span>Cần xử lý</span></div>
        </div>
        <div class="pdf-progress-wrap">
          <div class="pdf-body">Tiến độ kiểm kê tổng thể: <b>${checked}/${total} (${pct}%)</b></div>
          <div class="pdf-progress-bar"><i style="width:${pct}%"></i></div>
        </div>
        <div class="pdf-h2">Tỉ lệ trạng thái kiểm kê</div>
        <div class="pdf-chart-box"><canvas id="pdfChartDonut" width="440" height="440"></canvas></div>
        <div class="pdf-legend">
          <span><i style="background:${PDF_PALETTE.green}"></i>Đã kiểm (${checked})</span>
          <span><i style="background:${PDF_PALETTE.amber}"></i>Chưa kiểm (${unchecked})</span>
          <span><i style="background:${PDF_PALETTE.red}"></i>Cần xử lý (${exception})</span>
        </div>
      </div>
      ${footerBar(1)}`;
    root.appendChild(overview);

    /* ---- Trang biểu đồ Bộ phận / Loại thiết bị ---- */
    const sectionEntries = Object.entries(bySection).sort((a, b) => b[1] - a[1]);
    const typeEntries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
    const chartsPage = document.createElement("div");
    chartsPage.className = "pdf-page";
    chartsPage.innerHTML = `
      ${headerBar}
      <div class="pdf-content">
        <div class="pdf-h1">2. Thống kê theo Bộ phận</div>
        <hr class="pdf-hr">
        <div class="pdf-body">Số lượng tài sản đang được quản lý theo từng Bộ phận (Section).</div>
        <div class="pdf-chart-box"><canvas id="pdfChartSection" width="700" height="${Math.max(200, sectionEntries.length * 34 + 50)}"></canvas></div>
        <div class="pdf-h2">3. Thống kê theo Loại thiết bị</div>
        <div class="pdf-chart-box"><canvas id="pdfChartType" width="700" height="300"></canvas></div>
      </div>
      ${footerBar(2)}`;
    root.appendChild(chartsPage);

    /* ---- Trang biểu đồ Tình trạng ---- */
    const statusEntries = Object.entries(byStatus).sort((a, b) => b[1] - a[1]);
    const statusPage = document.createElement("div");
    statusPage.className = "pdf-page";
    statusPage.innerHTML = `
      ${headerBar}
      <div class="pdf-content">
        <div class="pdf-h1">4. Thống kê theo Tình trạng thiết bị</div>
        <hr class="pdf-hr">
        <div class="pdf-chart-box"><canvas id="pdfChartStatus" width="700" height="300"></canvas></div>
      </div>
      ${footerBar(3)}`;
    root.appendChild(statusPage);

    /* ---- Các trang bảng chi tiết ---- */
    const ROWS_PER_PAGE = 15;
    const chunks = [];
    for (let i = 0; i < list.length; i += ROWS_PER_PAGE) chunks.push(list.slice(i, i + ROWS_PER_PAGE));
    if (!chunks.length) chunks.push([]);
    chunks.forEach((chunk, idx) => {
      const page = document.createElement("div");
      page.className = "pdf-page";
      const heading = idx === 0
        ? `<div class="pdf-h1">5. Danh sách chi tiết tài sản</div><hr class="pdf-hr"><div class="pdf-body">Toàn bộ tài sản hiện có, màu theo trạng thái kiểm kê.</div>`
        : `<div class="pdf-h1">5. Danh sách chi tiết tài sản (tiếp theo)</div><hr class="pdf-hr">`;
      const rows = chunk.map(a => {
        const bc = pdfBadgeColors(a.checkStatus || CHECK_UNCHECKED);
        return `<tr>
          <td><b>${escapeHtml(a.code)}</b></td>
          <td>${escapeHtml(a.type || "")}</td>
          <td>${escapeHtml(a.model || "")}</td>
          <td>${escapeHtml(a.user || "—")}</td>
          <td>${escapeHtml(a.section || "")}</td>
          <td>${escapeHtml(a.status || "")}</td>
          <td><span class="pdf-badge" style="background:${bc.bg};color:${bc.fg}">${escapeHtml(a.checkStatus || CHECK_UNCHECKED)}</span></td>
        </tr>`;
      }).join("");
      const legend = idx === chunks.length - 1 ? `
        <div class="pdf-legend" style="margin-top:16px">
          <span><i style="background:${PDF_PALETTE.greenBg};border:1px solid ${PDF_PALETTE.green}"></i>Đã kiểm</span>
          <span><i style="background:${PDF_PALETTE.amberBg};border:1px solid ${PDF_PALETTE.amber}"></i>Chưa kiểm</span>
          <span><i style="background:${PDF_PALETTE.redBg};border:1px solid ${PDF_PALETTE.red}"></i>Cần xử lý</span>
        </div>` : "";
      page.innerHTML = `
        ${headerBar}
        <div class="pdf-content">
          ${heading}
          <table class="pdf-table">
            <thead><tr><th>Mã tài sản</th><th>Loại</th><th>Model</th><th>Người dùng</th><th>Bộ phận</th><th>Tình trạng</th><th>Kiểm kê</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          ${legend}
        </div>
        ${footerBar(4 + idx)}`;
      root.appendChild(page);
    });

    // Đợi 1 nhịp để các phần tử canvas gắn vào DOM trước khi Chart.js đo kích thước
    await new Promise(r => requestAnimationFrame(r));

    chartInstances.push(new Chart($("pdfChartDonut"), {
      type: "doughnut",
      data: {
        labels: ["Đã kiểm", "Chưa kiểm", "Cần xử lý"],
        datasets: [{ data: [checked, unchecked, exception], backgroundColor: [PDF_PALETTE.green, PDF_PALETTE.amber, PDF_PALETTE.red], borderColor: "#fff", borderWidth: 3 }]
      },
      options: { animation: false, responsive: false, cutout: "58%", plugins: { legend: { display: false } } }
    }));

    chartInstances.push(new Chart($("pdfChartSection"), {
      type: "bar",
      data: {
        labels: sectionEntries.map(e => e[0]),
        datasets: [{ data: sectionEntries.map(e => e[1]), backgroundColor: sectionEntries.map((_, i) => PDF_CHART_COLORS[i % PDF_CHART_COLORS.length]) }]
      },
      options: {
        indexAxis: "y", animation: false, responsive: false,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true, ticks: { precision: 0 } } }
      }
    }));

    chartInstances.push(new Chart($("pdfChartType"), {
      type: "bar",
      data: {
        labels: typeEntries.map(e => e[0]),
        datasets: [{ data: typeEntries.map(e => e[1]), backgroundColor: PDF_PALETTE.blue }]
      },
      options: { animation: false, responsive: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
    }));

    chartInstances.push(new Chart($("pdfChartStatus"), {
      type: "bar",
      data: {
        labels: statusEntries.map(e => e[0]),
        datasets: [{ data: statusEntries.map(e => e[1]), backgroundColor: statusEntries.map(e => PDF_STATUS_COLORS[e[0]] || "#64748b") }]
      },
      options: { animation: false, responsive: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
    }));

    // Đợi biểu đồ vẽ xong trước khi chụp ảnh
    await new Promise(r => setTimeout(r, 300));

    /* ---- Chụp từng trang & ghép vào PDF ---- */
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: "mm", format: "a4" });
    const pageEls = Array.from(root.querySelectorAll(".pdf-page"));
    for (let i = 0; i < pageEls.length; i++) {
      const canvas = await html2canvas(pageEls[i], { scale: 2, backgroundColor: "#ffffff" });
      const imgData = canvas.toDataURL("image/jpeg", 0.92);
      const pageW = 210, pageH = 297;
      const ratio = canvas.height / canvas.width;
      let imgW = pageW, imgH = pageW * ratio;
      if (imgH > pageH) { imgH = pageH; imgW = pageH / ratio; }
      if (i > 0) pdf.addPage();
      pdf.addImage(imgData, "JPEG", 0, 0, imgW, imgH);
    }
    pdf.save(`bao-cao-kiem-ke-${now.toISOString().slice(0, 10)}.pdf`);
  } catch (err) {
    console.error(err);
    alert("Lỗi tạo báo cáo PDF: " + err.message);
  } finally {
    chartInstances.forEach(c => c.destroy());
    root.remove();
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

$("exportPdfReport").addEventListener("click", generatePdfReport);

$("importXlsx").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    let imported = 0;
    const chunks = [];
    let batch = db.batch();
    let count = 0;
    for (const row of rows) {
      const obj = {};
      Object.keys(row).forEach(k => {
        const mapped = HEADER_MAP[k.trim().toLowerCase()];
        if (mapped) obj[mapped] = String(row[k]).trim();
      });
      if (!obj.code) continue;
      const id = sanitizeId(obj.code);
      if (!id) continue;
      obj.checkStatus = obj.checkStatus || CHECK_UNCHECKED;
      obj.status = obj.status || "Tốt";
      obj.updatedAt = firebase.firestore.FieldValue.serverTimestamp();

      // Ghi lịch sử cho từng dòng import — chỉ so sánh đúng các cột có mặt
      // trong file Excel của dòng này (onlyKeys), tránh báo nhầm "xóa" các
      // trường mà file Excel không hề đề cập tới. Dòng nào không đổi gì so
      // với bản hiện tại thì bỏ qua, tránh rác lịch sử khi import lại file
      // cũ không có gì mới.
      const existing = assets.find(a => a._id === id);
      const importedKeys = Object.keys(obj).filter(k => HISTORY_TRACK_FIELDS.some(([hk]) => hk === k));
      const fieldChanges = diffAssetFields(existing, obj, importedKeys);
      if (!existing || fieldChanges.length) {
        obj.history = firebase.firestore.FieldValue.arrayUnion(historyEntry("import", fieldChanges));
      }

      batch.set(db.collection(COLLECTION).doc(id), obj, { merge: true });
      count++; imported++;
      if (count >= 400) { chunks.push(batch); batch = db.batch(); count = 0; }
    }
    if (count > 0) chunks.push(batch);
    for (const b of chunks) await b.commit();
    alert(`Đã nhập ${imported} tài sản từ Excel.`);
  } catch (err) {
    alert("Lỗi nhập Excel: " + err.message);
  }
  e.target.value = "";
});

/* ==========================================================================
   NHẬP DANH SÁCH NHÂN VIÊN TRỰC TIẾP TỪ FILE HR (ImportEmployeeProfile.xlsx)
   ==========================================================================
   Trước đây (xem README) mỗi khi HR xuất file mới, IT phải tự mở file, lọc
   4 cột, rồi tay sinh lại mảng EMPLOYEES trong employees.js và thay nguyên
   file. Giờ chỉ cần vào Dữ liệu → "Nhân viên (HR)" → chọn thẳng file HR vừa
   xuất, app tự đọc và đồng bộ lên Firestore (collection `employees`) — mọi
   thiết bị/tài khoản dùng app sẽ thấy danh sách mới ngay (qua
   initEmployeesSync ở trên), không cần build lại file .js hay deploy lại.

   File HR có cấu trúc cố định (xem "ImportEmployeeProfile"): 1 dòng chứa các
   "machine tag" dạng @EmployeeID/@FullName/... dùng để dò đúng cột theo tên,
   không phụ thuộc thứ tự cột — 2 dòng tiêu đề cho người đọc ngay sau đó —
   rồi tới dữ liệu. Cột "Terminate date" (Ngày nghỉ việc) không có sẵn
   machine tag trong file mẫu nên được dò riêng theo dòng tiêu đề người đọc.
*/
$("importEmployeesXlsx").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

    const tagRowIdx = grid.findIndex(row => row.some(c => String(c).trim() === "@EmployeeID"));
    if (tagRowIdx === -1) {
      throw new Error("Không tìm thấy dòng @EmployeeID — file không đúng mẫu ImportEmployeeProfile của HR.");
    }
    const tagRow = grid[tagRowIdx];
    const col = {};
    tagRow.forEach((c, i) => {
      const t = String(c).trim();
      if (t.startsWith("@")) col[t.slice(1)] = i;
    });
    // Dò cột "Terminate date" theo dòng tiêu đề người đọc (2 dòng sau dòng
    // tag), vì cột này không có machine tag riêng trong file mẫu.
    const humanHeaderRow = grid[tagRowIdx + 2] || [];
    let terminateCol = humanHeaderRow.findIndex(c => /terminate|nghỉ việc/i.test(String(c)));
    if (terminateCol === -1) terminateCol = 4; // fallback theo đúng vị trí cột E trong file mẫu

    const required = ["EmployeeID", "FullName", "SectionName", "GroupName"];
    const missing = required.filter(k => !(k in col));
    if (missing.length) throw new Error("File thiếu cột bắt buộc: " + missing.join(", "));

    const dataRows = grid.slice(tagRowIdx + 3); // dữ liệu bắt đầu ngay sau 2 dòng tiêu đề người đọc
    const list = [];
    const seen = new Set();
    for (const row of dataRows) {
      const code = String(row[col.EmployeeID] || "").trim();
      const name = String(row[col.FullName] || "").trim();
      if (!code || !name) continue;
      if (seen.has(code)) continue; // phòng file có dòng trùng mã
      seen.add(code);
      const section = String(row[col.SectionName] || "").trim();
      const group = String(row[col.GroupName] || "").trim();
      const terminated = String(row[terminateCol] || "").trim() !== "";
      list.push({ code, name, section, group, active: !terminated });
    }
    if (!list.length) throw new Error("Không đọc được dòng nhân viên nào từ file.");

    // Ghi đè toàn bộ danh sách trên Firestore (giống việc "thay nguyên file"
    // employees.js trước đây): trước tiên lấy các mã đang có, ghi/merge danh
    // sách mới, rồi xóa các mã không còn xuất hiện trong file HR lần này.
    const existingSnap = await db.collection(EMPLOYEES_COLLECTION).get();
    const existingIds = new Set(existingSnap.docs.map(d => d.id));
    const newIds = new Set();

    let batch = db.batch(); let count = 0; const chunks = [];
    for (const emp of list) {
      const id = sanitizeId(emp.code);
      if (!id) continue;
      newIds.add(id);
      batch.set(db.collection(EMPLOYEES_COLLECTION).doc(id), emp, { merge: true });
      count++;
      if (count >= 400) { chunks.push(batch); batch = db.batch(); count = 0; }
    }
    for (const id of existingIds) {
      if (newIds.has(id)) continue;
      batch.delete(db.collection(EMPLOYEES_COLLECTION).doc(id));
      count++;
      if (count >= 400) { chunks.push(batch); batch = db.batch(); count = 0; }
    }
    if (count > 0) chunks.push(batch);
    for (const b of chunks) await b.commit();

    alert(`Đã nhập ${list.length} nhân viên từ file HR. Danh sách gợi ý sẽ tự cập nhật trên mọi thiết bị.`);
  } catch (err) {
    alert("Lỗi nhập danh sách nhân viên: " + err.message);
  }
  e.target.value = "";
});

/* ==========================================================================
   TICKET HỖ TRỢ IT (Helpdesk)
   ==========================================================================
   Quy trình & phân quyền GIỐNG HỆT tài sản (xem khối "Role / permissions" ở
   đầu file): Admin toàn quyền tạo/sửa/xóa/đổi trạng thái; tài khoản
   Collector chỉ tạo ticket mới được, không sửa lại được (kể cả ticket vừa
   tạo) — ticket họ tạo tự động đánh dấu locked:true. Enforce thật sự ở
   Firestore Rules (collection "tickets"), UI chỉ ẩn nút cho tiện.
   Ticket có thể liên kết (tuỳ chọn) tới 1 tài sản đã có trong app.
*/
const TICKET_PRIORITIES = ["Thấp", "Trung bình", "Cao", "Khẩn"];
const TICKET_STATUSES = ["Chờ", "Đang xử lý", "Hoàn thành"];

const TICKET_HISTORY_FIELDS = [
  ["priority", "Mức ưu tiên"],
  ["status", "Trạng thái"],
  ["requester", "Người yêu cầu"],
  ["department", "Phòng ban"],
  ["assetCode", "Tài sản liên kết"],
  ["device", "Thiết bị"],
  ["description", "Mô tả"],
  ["cause", "Nguyên nhân"],
  ["resolution", "Cách xử lý"],
  ["note", "Ghi chú"],
];
function diffTicketFields(oldT, newData, onlyKeys) {
  const fields = onlyKeys ? TICKET_HISTORY_FIELDS.filter(([key]) => onlyKeys.includes(key)) : TICKET_HISTORY_FIELDS;
  const changes = [];
  fields.forEach(([key, label]) => {
    const ov = ((oldT && oldT[key]) || "").toString().trim();
    const nv = ((newData && newData[key]) || "").toString().trim();
    if (ov !== nv) changes.push({ field: key, label, from: ov, to: nv });
  });
  return changes;
}
function renderTicketHistoryBox(t) {
  const box = $("ticketHistoryBox");
  const list = $("ticketHistoryList");
  if (!box || !list) return;
  const entries = Array.isArray(t && t.history) ? t.history.slice().sort((x, y) => (y.at || 0) - (x.at || 0)) : [];
  if (!entries.length) { box.classList.add("hidden"); list.innerHTML = ""; return; }
  box.classList.remove("hidden");
  list.innerHTML = entries.map(e => {
    const changesHtml = (e.changes || []).map(c => {
      const from = c.from ? escapeHtml(c.from) : "<i>(trống)</i>";
      const to = c.to ? escapeHtml(c.to) : "<i>(trống)</i>";
      return `<div class="history-change"><b>${escapeHtml(c.label)}:</b> ${from} → ${to}</div>`;
    }).join("");
    return `<div class="history-entry">
      <div class="history-head">
        <span class="history-action">${escapeHtml(HISTORY_ACTION_LABEL[e.action] || e.action || "")}</span>
        <span class="muted">${formatHistoryTime(e.at)} · ${escapeHtml(e.by || "")}</span>
      </div>
      ${changesHtml || '<div class="history-change muted">Không có thay đổi chi tiết được ghi nhận.</div>'}
    </div>`;
  }).join("");
}

/* ---------- Populate ticket priority/status selects ---------- */
function populateTicketSelects() {
  $("ticketPriority").innerHTML = TICKET_PRIORITIES.map(p => `<option>${p}</option>`).join("");
  $("ticketStatus").innerHTML = TICKET_STATUSES.map(s => `<option>${s}</option>`).join("");
}
populateTicketSelects();

/* ---------- Dashboard/list helpers ---------- */
function prioritySlug(p) {
  return { "Khẩn": "khan", "Cao": "cao", "Trung bình": "trungbinh", "Thấp": "thap" }[p] || "thap";
}
function ticketBadgeClass(status) {
  if (status === "Hoàn thành") return "ok";
  if (status === "Đang xử lý") return "info";
  return "warn"; // Chờ (mặc định)
}

function renderTicketList() {
  if (!$("ticketList")) return; // trang chưa có trong DOM (không nên xảy ra, phòng lỗi)
  const q = ($("ticketSearch").value || "").trim().toLowerCase();
  const statusF = $("filterTicketStatus").value;
  const prioF = $("filterTicketPriority").value;

  let list = ticketRecords.slice().sort((a, b) => (b.ticketId || "").localeCompare(a.ticketId || ""));
  if (q) {
    list = list.filter(t =>
      [t.ticketId, t.requester, t.department, t.description, t.device, t.assetCode].some(v => (v || "").toLowerCase().includes(q))
    );
  }
  if (statusF) list = list.filter(t => (t.status || "Chờ") === statusF);
  if (prioF) list = list.filter(t => (t.priority || "Trung bình") === prioF);

  if (!list.length) {
    $("ticketList").innerHTML = `<div class="empty">Không có ticket phù hợp.</div>`;
    return;
  }
  $("ticketList").innerHTML = list.map(t => {
    const editBtn = isAdmin
      ? `<button onclick="editTicket('${t._id}')">✎ Sửa</button>`
      : `<button onclick="editTicket('${t._id}')">👁 Xem</button>`;
    const deleteBtn = isAdmin
      ? `<button class="secondary" onclick="deleteTicket('${t._id}')">🗑 Xóa</button>`
      : "";
    return `
    <div class="asset">
      <div>
        <h3>${escapeHtml(t.ticketId)}</h3>
        <div class="muted">${t.requester ? "👤 " + escapeHtml(t.requester) : ""}${t.department ? " · 🏢 " + escapeHtml(t.department) : ""}</div>
        ${t.device || t.assetCode ? `<div class="muted">💻 ${escapeHtml(t.device || "")}${t.assetCode ? " (" + escapeHtml(t.assetCode) + ")" : ""}</div>` : ""}
        <div class="muted">${escapeHtml(t.description || "")}</div>
        <span class="badge ${ticketBadgeClass(t.status)}">${escapeHtml(t.status || "Chờ")}</span>
        <span class="prio-badge prio-${prioritySlug(t.priority)}">${escapeHtml(t.priority || "Trung bình")}</span>
        ${!isAdmin ? `<span class="badge view-only-tag">👁 Chỉ xem</span>` : ""}
      </div>
      <div class="asset-actions">
        ${editBtn}
        ${deleteBtn}
      </div>
    </div>
  `;
  }).join("");
}
$("ticketSearch").addEventListener("input", renderTicketList);
$("filterTicketStatus").addEventListener("change", renderTicketList);
$("filterTicketPriority").addEventListener("change", renderTicketList);

/* ---------- Autocomplete: Người yêu cầu / Phòng ban / Liên kết tài sản ---------- */
setupAutocomplete("ticketRequester", "ticketRequesterSuggest",
  q => filterEmployeesBy("name", q, 200),
  e => `${escapeHtml(e.name)}<span class="muted">${escapeHtml(e.code)}${e.section ? " · " + escapeHtml(e.section) : ""}${e.active ? "" : " · đã nghỉ việc"}</span>`,
  e => {
    $("ticketRequester").value = e.name;
    $("ticketDepartment").value = e.section || "";
  },
  { autoFillMinChars: 3 }
);
setupAutocomplete("ticketDepartment", "ticketDepartmentSuggest",
  q => filterList(Array.from(new Set((window.EMPLOYEES || []).map(e => e.section).filter(Boolean))), q, 100).map(v => ({ value: v })),
  it => escapeHtml(it.value),
  it => { $("ticketDepartment").value = it.value; }
);
// Liên kết tài sản — gợi ý từ danh sách tài sản hiện có trong app (mã, người
// dùng, model). Chọn xong: điền hidden ticketAssetId để lưu liên kết, và
// TIỆN ÍCH điền hộ Thiết bị/Phòng ban NẾU đang trống (không đè lên nếu
// người dùng đã gõ sẵn). Gõ tay lại vào ô này (không chọn từ gợi ý) sẽ hủy
// liên kết cũ để tránh lưu nhầm ticket vào tài sản không đúng.
setupAutocomplete("ticketAsset", "ticketAssetSuggest",
  q => filterList(assets.map(a => a.code), q, 20)
    .map(code => assets.find(a => a.code === code))
    .filter(Boolean),
  a => `${escapeHtml(a.code)}<span class="muted">${escapeHtml(a.type || "")}${a.model ? " · " + escapeHtml(a.model) : ""}${a.user ? " · " + escapeHtml(a.user) : ""}</span>`,
  a => {
    $("ticketAsset").value = a.code;
    $("ticketAssetId").value = a._id;
    if (!$("ticketDevice").value.trim()) $("ticketDevice").value = [a.type, a.model].filter(Boolean).join(" - ");
    if (!$("ticketDepartment").value.trim()) $("ticketDepartment").value = a.section || "";
  }
);
$("ticketAsset").addEventListener("input", () => { $("ticketAssetId").value = ""; });

/* ---------- Mã ticket: tự gợi ý dạng IT-YYYYMMDD-NNN ---------- */
let ticketIdAutoFilled = true;
function todayCompact() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
function suggestedTicketSeq(dateStr) {
  const prefix = `IT-${dateStr}-`;
  const n = ticketRecords.filter(t => (t.ticketId || "").startsWith(prefix)).length + 1;
  return String(n).padStart(3, "0");
}
function maybeSuggestTicketId() {
  if (!ticketIdAutoFilled) return;
  if ($("ticketDocId").value) return; // đang sửa ticket có sẵn — không đổi mã
  const dateStr = todayCompact();
  $("ticketId").value = `IT-${dateStr}-${suggestedTicketSeq(dateStr)}`;
}
$("ticketId").addEventListener("input", () => { ticketIdAutoFilled = false; });

/* ---------- Form khóa/mở khóa (giống asset) ---------- */
function setTicketFormLocked(locked) {
  $("ticketFormEl").querySelectorAll("input, select, textarea, button").forEach(el => {
    el.disabled = locked;
  });
  $("ticketLockedNotice").classList.toggle("hidden", !locked);
}

let currentTicketPhotoData = "";
function clearTicketForm() {
  $("ticketFormEl").reset();
  $("ticketDocId").value = "";
  $("ticketAssetId").value = "";
  $("ticketFormTitle").textContent = "Tạo ticket";
  currentTicketPhotoData = "";
  $("ticketPhotoPreview").classList.add("hidden");
  $("ticketPhotoPreview").src = "";
  $("ticketRequesterSuggest").classList.add("hidden");
  $("ticketRequesterSuggest").innerHTML = "";
  $("ticketDepartmentSuggest").classList.add("hidden");
  $("ticketDepartmentSuggest").innerHTML = "";
  $("ticketAssetSuggest").classList.add("hidden");
  $("ticketAssetSuggest").innerHTML = "";
  $("ticketLocked").checked = false;
  $("ticketId").readOnly = false;
  setTicketFormLocked(false);
  ticketIdAutoFilled = true;
  maybeSuggestTicketId();
  if ($("ticketHistoryBox")) { $("ticketHistoryBox").classList.add("hidden"); $("ticketHistoryList").innerHTML = ""; }
}
$("resetTicketForm").addEventListener("click", clearTicketForm);
["quickAddTicketBtn", "ticketsAddBtn"].forEach(id => {
  const btn = $(id);
  if (btn) btn.addEventListener("click", clearTicketForm);
});

function fillFormFromTicket(t) {
  ticketIdAutoFilled = false; // ticket đã có mã thật — không tự sinh đè lên
  $("ticketDocId").value = t._id || "";
  $("ticketAssetId").value = t.assetId || "";
  $("ticketId").value = t.ticketId || "";
  $("ticketPriority").value = t.priority || "Trung bình";
  $("ticketStatus").value = t.status || "Chờ";
  $("ticketRequester").value = t.requester || "";
  $("ticketDepartment").value = t.department || "";
  $("ticketAsset").value = t.assetCode || "";
  $("ticketDevice").value = t.device || "";
  $("ticketDescription").value = t.description || "";
  $("ticketCause").value = t.cause || "";
  $("ticketResolution").value = t.resolution || "";
  $("ticketNote").value = t.note || "";
  currentTicketPhotoData = t.photo || "";
  if (currentTicketPhotoData) {
    $("ticketPhotoPreview").src = currentTicketPhotoData;
    $("ticketPhotoPreview").classList.remove("hidden");
  } else {
    $("ticketPhotoPreview").classList.add("hidden");
  }
  $("ticketLocked").checked = !!t.locked;
  $("ticketFormTitle").textContent = "Sửa ticket: " + (t.ticketId || "");
  renderTicketHistoryBox(t);

  // Chỉ Admin mới đổi được Mã ticket hoặc sửa 1 ticket đã tồn tại — giống
  // hệt quy tắc của tài sản (xem fillFormFromAsset).
  $("ticketId").readOnly = !isAdmin;
  setTicketFormLocked(!isAdmin);
}
window.editTicket = function (id) {
  const t = ticketRecords.find(x => x._id === id);
  if (!t) return;
  fillFormFromTicket(t);
  goPage("ticketForm");
};
window.deleteTicket = function (id) {
  if (!isAdmin) return; // UI đã ẩn nút này cho non-admin; Firestore Rules chặn thật sự phía server
  const t = ticketRecords.find(x => x._id === id);
  if (!t) return;
  if (!confirm(`Xóa ticket "${t.ticketId}"? Không thể hoàn tác.`)) return;
  db.collection(TICKET_COLLECTION).doc(id).delete().catch(err => alert("Lỗi xóa: " + err.message));
};

$("ticketFormEl").addEventListener("submit", e => {
  e.preventDefault();
  const ticketId = $("ticketId").value.trim();
  if (!ticketId) { alert("Vui lòng nhập Mã ticket."); return; }
  if (!$("ticketDescription").value.trim()) { alert("Vui lòng nhập Mô tả sự cố / yêu cầu."); return; }
  const newId = sanitizeId(ticketId);
  if (!newId) { alert("Mã ticket không hợp lệ."); return; }
  const oldId = $("ticketDocId").value;
  const oldTicket = oldId ? ticketRecords.find(t => t._id === oldId) : null;

  if (!isAdmin && oldId) {
    alert("Bạn không có quyền sửa ticket đã tồn tại. Liên hệ quản trị viên (IT) nếu cần chỉnh sửa.");
    return;
  }

  // Nếu có liên kết tài sản, lấy lại mã tài sản mới nhất từ cache (đề phòng
  // tài sản đã đổi mã từ lúc chọn) để lưu snapshot assetCode hiển thị nhanh
  // trong danh sách ticket mà không cần join dữ liệu.
  const linkedAssetId = $("ticketAssetId").value.trim();
  const linkedAsset = linkedAssetId ? assets.find(a => a._id === linkedAssetId) : null;

  const data = {
    ticketId,
    priority: $("ticketPriority").value,
    status: $("ticketStatus").value,
    requester: $("ticketRequester").value.trim(),
    department: $("ticketDepartment").value.trim(),
    // Nếu có liên kết hợp lệ (chọn từ gợi ý), luôn lưu mã tài sản MỚI NHẤT
    // (phòng khi tài sản đã đổi mã). Nếu không có liên kết (chưa chọn, đã
    // gõ tay đè lên, hoặc import từ Excel chỉ có chữ mã), vẫn giữ nguyên
    // text đang có trong ô — tránh mất dữ liệu mã tài sản dạng chữ tự do.
    assetId: linkedAsset ? linkedAsset._id : "",
    assetCode: linkedAsset ? linkedAsset.code : $("ticketAsset").value.trim(),
    device: $("ticketDevice").value.trim(),
    description: $("ticketDescription").value.trim(),
    cause: $("ticketCause").value.trim(),
    resolution: $("ticketResolution").value.trim(),
    note: $("ticketNote").value.trim(),
    photo: currentTicketPhotoData || "",
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  data.locked = isAdmin ? $("ticketLocked").checked : true;

  {
    const fieldChanges = diffTicketFields(oldTicket, data);
    let action, carriedHistory = [];
    if (!oldId) {
      action = "create";
    } else if (oldId !== newId) {
      action = "rename";
      fieldChanges.unshift({ field: "ticketId", label: "Mã ticket", from: oldTicket ? oldTicket.ticketId : oldId, to: ticketId });
      carriedHistory = (oldTicket && Array.isArray(oldTicket.history)) ? oldTicket.history : [];
    } else {
      action = "update";
    }
    if (action !== "update" || fieldChanges.length) {
      const entry = historyEntry(action, fieldChanges);
      data.history = firebase.firestore.FieldValue.arrayUnion(...carriedHistory, entry);
    }
  }

  const submitBtn = $("ticketFormEl").querySelector('button[type="submit"]');
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Đang lưu...";

  // Không await — giống hệt logic lưu tài sản, để UI phản hồi ngay cả khi
  // offline (xem giải thích chi tiết ở khối lưu tài sản phía trên).
  const writeOp = db.collection(TICKET_COLLECTION).doc(newId).set(data, { merge: true })
    .then(() => (oldId && oldId !== newId) ? db.collection(TICKET_COLLECTION).doc(oldId).delete() : null)
    .catch(err => {
      alert("Lỗi đồng bộ lên máy chủ: " + err.message +
        "\n\nDữ liệu vẫn được lưu tạm trên máy này và sẽ tự thử lại. " +
        "Nếu lỗi là 'permission-denied', kiểm tra lại Firestore Rules đã Publish chưa.");
    });

  setTimeout(() => {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
    $("ticketDocId").value = newId;
    $("ticketFormTitle").textContent = "Sửa ticket: " + ticketId;
    goPage("tickets");
  }, 150);

  const stuckTimer = setTimeout(() => {
    console.warn("Firestore write for ticket", newId, "has not resolved after 20s — check network/rules.");
  }, 20000);
  writeOp.finally(() => clearTimeout(stuckTimer));
});

/* ---------- Camera / photo (ticket) ---------- */
$("ticketTakePhoto").addEventListener("click", () => $("ticketPhoto").click());
$("ticketPhoto").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const dataUrl = await resizeImage(file);
    currentTicketPhotoData = dataUrl;
    $("ticketPhotoPreview").src = dataUrl;
    $("ticketPhotoPreview").classList.remove("hidden");
  } catch (err) {
    alert("Không đọc được ảnh: " + err.message);
  }
  e.target.value = "";
});

/* ---------- Excel export/import (Ticket) ----------
   Cột khớp với cấu trúc file Helpdesk_IT.xlsx (sheet "Tickets") để import
   trực tiếp file cũ nếu cần: Ticket ID, Ưu tiên, Trạng thái, Người yêu cầu,
   Phòng ban, Thiết bị, Mô tả, Nguyên nhân, Cách xử lý, Ghi chú. Cột "Mã tài
   sản liên kết" là cột riêng của app này (không có trong file gốc) — nếu
   không có cột này khi import, ticket vẫn được tạo, chỉ là chưa liên kết
   tài sản (có thể vào sửa từng ticket để liên kết thủ công sau).
*/
const TICKET_COLUMNS = ["ticketId", "priority", "status", "requester", "department", "assetCode", "device", "description", "cause", "resolution", "note"];
const TICKET_COLUMN_LABELS_VN = {
  ticketId: "Ticket ID", priority: "Ưu tiên", status: "Trạng thái", requester: "Người yêu cầu",
  department: "Phòng ban", assetCode: "Mã tài sản liên kết", device: "Thiết bị", description: "Mô tả",
  cause: "Nguyên nhân", resolution: "Cách xử lý", note: "Ghi chú"
};
const TICKET_HEADER_MAP = {};
TICKET_COLUMNS.forEach(c => {
  TICKET_HEADER_MAP[c.toLowerCase()] = c;
  TICKET_HEADER_MAP[TICKET_COLUMN_LABELS_VN[c].toLowerCase()] = c;
});
TICKET_HEADER_MAP["mã tài sản"] = "assetCode"; // alias ngắn gọn hơn khi tự soạn Excel

$("exportTicketsXlsx").addEventListener("click", () => {
  if (!ticketRecords.length) { alert("Chưa có dữ liệu ticket để xuất."); return; }
  const rows = ticketRecords.slice().sort((a, b) => (a.ticketId || "").localeCompare(b.ticketId || "")).map(t => {
    const row = {};
    TICKET_COLUMNS.forEach(c => { row[TICKET_COLUMN_LABELS_VN[c]] = t[c] || ""; });
    return row;
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Tickets");
  const ts = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `it-helpdesk-tickets-${ts}.xlsx`);
});

$("importTicketsXlsx").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    let imported = 0;
    const chunks = [];
    let batch = db.batch();
    let count = 0;
    for (const row of rows) {
      const obj = {};
      Object.keys(row).forEach(k => {
        const mapped = TICKET_HEADER_MAP[k.trim().toLowerCase()];
        if (mapped) obj[mapped] = String(row[k]).trim();
      });
      if (!obj.ticketId) continue;
      const id = sanitizeId(obj.ticketId);
      if (!id) continue;
      obj.priority = TICKET_PRIORITIES.includes(obj.priority) ? obj.priority : "Trung bình";
      obj.status = TICKET_STATUSES.includes(obj.status) ? obj.status : "Chờ";
      obj.updatedAt = firebase.firestore.FieldValue.serverTimestamp();

      const existing = ticketRecords.find(t => t._id === id);
      const importedKeys = Object.keys(obj).filter(k => TICKET_HISTORY_FIELDS.some(([hk]) => hk === k));
      const fieldChanges = diffTicketFields(existing, obj, importedKeys);
      if (!existing || fieldChanges.length) {
        obj.history = firebase.firestore.FieldValue.arrayUnion(historyEntry("import", fieldChanges));
      }

      batch.set(db.collection(TICKET_COLLECTION).doc(id), obj, { merge: true });
      count++; imported++;
      if (count >= 400) { chunks.push(batch); batch = db.batch(); count = 0; }
    }
    if (count > 0) chunks.push(batch);
    for (const b of chunks) await b.commit();
    alert(`Đã nhập ${imported} ticket từ Excel.`);
  } catch (err) {
    alert("Lỗi nhập Excel: " + err.message);
  }
  e.target.value = "";
});

/* ---------- Xóa toàn bộ ticket ---------- */
$("clearAllTickets").addEventListener("click", async () => {
  if (!confirm("Xóa TOÀN BỘ ticket? Hành động này không thể hoàn tác.")) return;
  if (!confirm("Xác nhận lần 2: bạn chắc chắn muốn xóa hết ticket?")) return;
  try {
    const snap = await db.collection(TICKET_COLLECTION).get();
    let batch = db.batch();
    let count = 0;
    const chunks = [];
    snap.docs.forEach(d => {
      batch.delete(d.ref);
      count++;
      if (count >= 400) { chunks.push(batch); batch = db.batch(); count = 0; }
    });
    if (count > 0) chunks.push(batch);
    for (const b of chunks) await b.commit();
    localStorage.removeItem("ita_tickets_cache");
    alert("Đã xóa toàn bộ ticket.");
  } catch (err) {
    alert("Lỗi xóa dữ liệu: " + err.message);
  }
});

/* ---------- JSON backup/restore ---------- */
$("backupJson").addEventListener("click", () => {
  if (!assets.length) { alert("Chưa có dữ liệu để sao lưu."); return; }
  const clean = assets.map(a => {
    const c = Object.assign({}, a);
    delete c.updatedAt;
    return c;
  });
  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `it-asset-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$("restoreJson").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error("File JSON không đúng định dạng (cần là mảng).");
    let batch = db.batch();
    let count = 0, total = 0;
    const chunks = [];
    for (const item of data) {
      if (!item.code) continue;
      const id = item._id || sanitizeId(item.code);
      const obj = Object.assign({}, item);
      delete obj._id;
      obj.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      batch.set(db.collection(COLLECTION).doc(id), obj, { merge: true });
      count++; total++;
      if (count >= 400) { chunks.push(batch); batch = db.batch(); count = 0; }
    }
    if (count > 0) chunks.push(batch);
    for (const b of chunks) await b.commit();
    alert(`Đã khôi phục ${total} tài sản từ file JSON.`);
  } catch (err) {
    alert("Lỗi khôi phục: " + err.message);
  }
  e.target.value = "";
});

/* ---------- Clear all ---------- */
$("clearAll").addEventListener("click", async () => {
  if (!confirm("Xóa TOÀN BỘ tài sản? Hành động này không thể hoàn tác.")) return;
  if (!confirm("Xác nhận lần 2: bạn chắc chắn muốn xóa hết dữ liệu?")) return;
  try {
    const snap = await db.collection(COLLECTION).get();
    let batch = db.batch();
    let count = 0;
    const chunks = [];
    snap.docs.forEach(d => {
      batch.delete(d.ref);
      count++;
      if (count >= 400) { chunks.push(batch); batch = db.batch(); count = 0; }
    });
    if (count > 0) chunks.push(batch);
    for (const b of chunks) await b.commit();
    localStorage.removeItem("ita_assets_cache");
    alert("Đã xóa toàn bộ dữ liệu.");
  } catch (err) {
    alert("Lỗi xóa dữ liệu: " + err.message);
  }
});

/* ---------- PWA install ---------- */
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  $("installBtn").classList.remove("hidden");
});
$("installBtn").addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $("installBtn").classList.add("hidden");
});
window.addEventListener("appinstalled", () => $("installBtn").classList.add("hidden"));

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(err => console.warn("SW register failed:", err));
  });
}

/* ---------- Auth ---------- */
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  const errBox = $("loginError");
  const submitBtn = $("loginSubmit");
  errBox.classList.add("hidden");
  submitBtn.disabled = true;
  submitBtn.textContent = "Đang đăng nhập...";
  try {
    await auth.signInWithEmailAndPassword(email, password);
    $("loginPassword").value = "";
  } catch (err) {
    const messages = {
      "auth/invalid-email": "Email không hợp lệ.",
      "auth/user-disabled": "Tài khoản đã bị vô hiệu hóa.",
      "auth/user-not-found": "Không tìm thấy tài khoản này. Liên hệ quản trị để được cấp.",
      "auth/wrong-password": "Sai mật khẩu.",
      "auth/unauthorized-domain": "Domain này chưa được cấp phép đăng nhập. Vào Firebase Console → Authentication → Settings → Authorized domains để thêm domain đang chạy app.",
      "auth/invalid-credential": "Email hoặc mật khẩu không đúng.",
      "auth/too-many-requests": "Thử sai quá nhiều lần. Vui lòng đợi rồi thử lại."
    };
    errBox.textContent = messages[err.code] || ("Lỗi đăng nhập: " + err.message);
    errBox.classList.remove("hidden");
  }
  submitBtn.disabled = false;
  submitBtn.textContent = "Đăng nhập";
});

$("logoutBtn").addEventListener("click", () => {
  if (!confirm("Đăng xuất khỏi ứng dụng?")) return;
  auth.signOut();
});

// Reads users/{uid} in Firestore to find out this account's role.
// No matching doc (or a role other than admin/collector) => unauthorized.
// Returns true if the account may use the app at all.
async function loadRole(user) {
  currentEmail = user.email || "";
  currentUid = user.uid;
  isAdmin = false;
  isCollector = false;
  try {
    const snap = await db.collection("users").doc(user.uid).get();
    const role = snap.exists ? snap.data().role : null;
    if (role === "admin") isAdmin = true;
    else if (role === "collector") isCollector = true;
  } catch (err) {
    console.warn("Không đọc được vai trò tài khoản:", err);
  }
  document.body.classList.toggle("role-staff", !isAdmin);
  const badge = $("roleBadge");
  if (isAdmin) {
    badge.textContent = "Quản trị";
    badge.classList.add("admin");
  } else if (isCollector) {
    badge.textContent = "Thu thập dữ liệu";
    badge.classList.remove("admin");
  } else {
    badge.textContent = "Chưa cấp quyền";
    badge.classList.remove("admin");
  }
  return isAdmin || isCollector;
}

auth.onAuthStateChanged(async user => {
  if (user) {
    $("loginScreen").classList.add("hidden");
    $("appShell").classList.remove("hidden");
    $("userEmail").textContent = user.email || "";
    const authorized = await loadRole(user);
    if (!authorized) {
      alert("Tài khoản này chưa được cấp quyền sử dụng ứng dụng. Liên hệ quản trị viên (IT).");
      auth.signOut();
      return;
    }
    initSync();
    initTicketSync();
    initEmployeesSync();
    goPage("dashboard");
  } else {
    stopSync();
    stopTicketSync();
    stopEmployeesSync();
    assets = [];
    ticketRecords = [];
    isAdmin = false;
    isCollector = false;
    currentEmail = "";
    currentUid = "";
    $("appShell").classList.add("hidden");
    $("loginScreen").classList.remove("hidden");
    $("loginEmail").value = "";
    $("loginPassword").value = "";
  }
});

/* ---------- Init ---------- */
populateTypeSelect();
loadLocalCache();
loadTicketsLocalCache();
