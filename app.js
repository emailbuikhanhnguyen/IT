/* IT Asset Inventory — app.js
   Firestore (realtime + offline persistence) + QR + Camera + Excel + Backup
*/

/* ---------- Phiên bản app ----------
   Cập nhật thủ công mỗi lần deploy để bạn biết bản mới đã lên chưa (hiển thị
   ở màn hình đăng nhập và cuối trang Dữ liệu). Định dạng: YYYY.MM.DD.N —
   N là số thứ tự bản deploy trong ngày (bắt đầu từ 1). */
const APP_VERSION = "2026.09.04.2";
document.querySelectorAll("#appVersionText, #appVersionText2").forEach(el => { el.textContent = APP_VERSION; });

/* ---------- Mật khẩu xác nhận cho thao tác nguy hiểm (Xóa toàn bộ...) ----------
   Đây KHÔNG phải cơ chế bảo mật chống hacker — code chạy 100% ở trình
   duyệt, không có backend riêng để giấu bí mật thật sự, nên ai cố tình đọc
   source vẫn dò ra được nếu quyết tâm. Mục đích chỉ là 1 lớp "chặn bấm
   nhầm/tay nhanh hơn não" cho chính admin, cộng thêm 2 hộp thoại confirm()
   đã có sẵn — nên mình lưu SHA-256 của mật khẩu (không lưu chữ thường) để
   người xem code không thấy ngay mật khẩu là gì.
   Muốn đổi mật khẩu: mở Console (F12) ở BẤT KỲ trang web nào, chạy:
     crypto.subtle.digest("SHA-256", new TextEncoder().encode("MẬT_KHẨU_MỚI"))
       .then(b => console.log(Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2,"0")).join("")))
   rồi thay chuỗi hex bên dưới bằng kết quả in ra. */
const DANGER_ACTION_PASSWORD_HASH = "7c1b3b1251a44814eb1296235347773b8c2ba10b5b6ef0062a3c2faa58da4dea";
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
// Trả về true nếu nhập đúng mật khẩu, false nếu sai hoặc bấm Cancel (im
// lặng thoát, không cần alert riêng vì Cancel đã là 1 cách "đổi ý" hợp lệ).
async function verifyDangerPassword() {
  const pw = prompt(tr("msg.enterDangerPassword"));
  if (pw === null) return false;
  const hash = await sha256Hex(pw);
  if (hash !== DANGER_ACTION_PASSWORD_HASH) {
    alert(tr("msg.wrongDangerPassword"));
    return false;
  }
  return true;
}

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
const PROJECT_COLLECTION = "projects";
const EMPLOYEES_COLLECTION = "employees";
const USERS_COLLECTION = "users";

// App Firebase "phụ" — dùng RIÊNG để tạo tài khoản mới (Dữ liệu → Người
// dùng). createUserWithEmailAndPassword luôn tự đăng nhập vào tài khoản
// vừa tạo trên app đang gọi nó — nếu gọi bằng app chính, Admin đang đăng
// nhập sẽ bị đá văng ra khỏi phiên của chính mình. Dùng app phụ (session
// hoàn toàn tách biệt) để tránh việc đó; đăng xuất app phụ ngay sau khi
// tạo xong.
const secondaryApp = firebase.initializeApp(firebaseConfig, "Secondary");
const secondaryAuth = secondaryApp.auth();

try {
  db.enablePersistence({ synchronizeTabs: true }).catch(err => {
    console.warn("Offline persistence not enabled:", err.code);
  });
} catch (e) { console.warn(e); }

/* ---------- State ---------- */
let assets = [];              // local cache, synced from Firestore
let ticketRecords = [];       // local cache, synced from Firestore (tickets)
let projectRecords = [];      // local cache, synced from Firestore (projects)
let html5QrCode = null;
let scanning = false;
let currentPhotoData = "";    // base64 dataURL of the photo currently in the form
let deferredInstallPrompt = null;

/* ---------- Link tem QR trỏ về app + mở thẳng tài sản sau khi đăng nhập ---------- */
const SEC_APP_URL = "https://emailbuikhanhnguyen.github.io/IT/";
function assetLinkFor(code) {
  return SEC_APP_URL + "?code=" + encodeURIComponent(code || "");
}
// Mã tài sản lấy từ QR link (?code=...) khi trang được mở từ việc quét tem —
// dùng để mở thẳng trang tài sản đó ngay sau khi đăng nhập.
let pendingScanCode = new URLSearchParams(location.search).get("code") || "";

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
let isViewer = false;
// reportonly: tài khoản chỉ dùng để vào thẳng và chỉ thấy đúng 1 trang
// "Chuyển đổi báo cáo" (Word -> JPG) — không thấy dashboard/menu/trang nào
// khác, không đọc/ghi bất kỳ collection Firestore nào (tài sản, ticket,
// nhân viên...) vì tính năng này chạy 100% trên thiết bị.
let isReportOnly = false;
let currentEmail = "";
let currentUid = "";

const ASSET_TYPES = ["Máy tính (PC)", "Laptop", "Camera", "Máy in", "Switch mạng", "Router/WiFi", "Firewall", "Màn hình", "UPS", "Máy chiếu", "Khác"];

const CHECK_UNCHECKED = "Chưa kiểm";
const CHECK_OK = "Đã kiểm - OK";
const CHECK_NEW = "Thiết bị mới";
const CHECK_WRONG = "Sai thông tin";
const CHECK_MISSING = "Không tìm thấy";

/* Các giá trị status/checkStatus/priority... LUÔN được lưu trong Firestore
   bằng tiếng Việt (không đổi theo ngôn ngữ hiển thị, để dữ liệu cũ/mới nhất
   quán). Các hàm dưới đây chỉ dịch NHÃN HIỂN THỊ, giá trị lưu giữ nguyên. */
const CHECK_LABEL_KEY = {
  "Chưa kiểm": "check.unchecked", "Đã kiểm - OK": "check.ok", "Thiết bị mới": "check.newDevice",
  "Sai thông tin": "check.wrongInfo", "Không tìm thấy": "check.notFound"
};
function checkLabel(status) { return CHECK_LABEL_KEY[status] ? tr(CHECK_LABEL_KEY[status]) : (status || tr("check.unchecked")); }
const STATUS_LABEL_KEY = {
  "Tốt": "status.good", "Đang sử dụng": "status.inUse", "Dự phòng": "status.spare",
  "Hỏng": "status.broken", "Lưu kho": "status.inStorage", "Thu hồi": "status.reclaimed",
  "Mất": "status.lost", "Thanh lý": "status.disposed"
};
function statusLabel(status) { return STATUS_LABEL_KEY[status] ? tr(STATUS_LABEL_KEY[status]) : status; }
const TICKET_STATUS_LABEL_KEY = { "Chờ": "ticket.status.pending", "Đang xử lý": "ticket.status.inProgress", "Hoàn thành": "ticket.status.done" };
function ticketStatusLabel(status) { return TICKET_STATUS_LABEL_KEY[status] ? tr(TICKET_STATUS_LABEL_KEY[status]) : (status || tr("ticket.status.pending")); }
const TICKET_PRIORITY_LABEL_KEY = { "Khẩn": "ticket.priority.urgent", "Cao": "ticket.priority.high", "Trung bình": "ticket.priority.medium", "Thấp": "ticket.priority.low" };
function ticketPriorityLabel(p) { return TICKET_PRIORITY_LABEL_KEY[p] ? tr(TICKET_PRIORITY_LABEL_KEY[p]) : p; }

/* ---------- Lịch sử thay đổi (vòng đời tài sản) ----------
   Lưu trực tiếp trong field `history` (mảng) của chính document tài sản đó —
   KHÔNG dùng subcollection/collection riêng, nên không cần sửa gì thêm ở
   firestore.rules: quyền ghi field này đi theo đúng quyền ghi cả document
   (collector tạo mới được, chỉ admin sửa được) như mọi field khác.
   Mỗi phần tử: { at: <epoch ms>, by: <email>, action: 'create'|'update'|'rename',
                  changes: [{ field, label, from, to }] }
   Lưu ý: dùng Date.now() (không dùng serverTimestamp()) cho từng phần tử,
   vì Firestore không cho phép serverTimestamp() bên trong arrayUnion(). */
function HISTORY_TRACK_FIELDS_FN() { return [
  ["employeeCode", tr("field.employeeCode")],
  ["user", tr("field.user")],
  ["section", tr("field.section")],
  ["group", tr("field.group")],
  ["type", tr("field.type")],
  ["deviceName", tr("field.deviceName")],
  ["model", tr("field.model")],
  ["serial", tr("field.serial")],
  ["ip", tr("field.ip")],
  ["mac", tr("field.mac")],
  ["spec", tr("field.spec")],
  ["winInfo", tr("field.winInfo")],
  ["status", tr("field.status")],
  ["checkStatus", tr("field.checkStatus")],
  ["note", tr("field.note")],
]; }
Object.defineProperty(window, "HISTORY_TRACK_FIELDS", { get: HISTORY_TRACK_FIELDS_FN });
function HISTORY_ACTION_LABEL_FN() { return { create: tr("history.action.create"), update: tr("history.action.update"), rename: tr("history.action.rename"), import: tr("history.action.import") }; }
Object.defineProperty(window, "HISTORY_ACTION_LABEL", { get: HISTORY_ACTION_LABEL_FN });

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
  const locale = { vi: "vi-VN", en: "en-US", zh: "zh-CN" }[getLang()] || "vi-VN";
  try { return new Date(ms).toLocaleString(locale); } catch (e) { return ""; }
}

// Trả về thời điểm tạo (epoch ms) của 1 tài sản, hoặc null nếu không xác
// định được. Ưu tiên field `createdAt` (Firestore Timestamp, có từ khi thêm
// tính năng lọc theo ngày tạo). Tài sản tạo TRƯỚC thời điểm đó chưa có field
// này — fallback sang mốc "create" đầu tiên trong `history` (đã có sẵn từ
// lâu hơn); tài sản import Excel hàng loạt không có cả hai thì coi là không
// xác định (không hiện ngày, bị loại khỏi kết quả khi có lọc theo ngày).
function assetCreatedMs(a) {
  if (!a) return null;
  if (a.createdAt && typeof a.createdAt.toMillis === "function") return a.createdAt.toMillis();
  if (a.createdAt instanceof Date) return a.createdAt.getTime();
  if (Array.isArray(a.history) && a.history.length) {
    // Không chắc mốc nào là "create" (asset cũ có thể chỉ có toàn entry
    // "import" nếu chưa từng sửa tay lần nào) — lấy mốc SỚM NHẤT trong
    // lịch sử làm giá trị gần đúng cho thời điểm tạo.
    const earliest = a.history.reduce((min, e) => (e.at && (!min || e.at < min)) ? e.at : min, null);
    if (earliest) return earliest;
  }
  return null;
}
function formatAssetDate(ms) {
  if (!ms) return "";
  const locale = { vi: "vi-VN", en: "en-US", zh: "zh-CN" }[getLang()] || "vi-VN";
  try { return new Date(ms).toLocaleDateString(locale); } catch (e) { return ""; }
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
      const from = c.from ? escapeHtml(c.from) : "<i>(" + tr("common.empty") + ")</i>";
      const to = c.to ? escapeHtml(c.to) : "<i>(" + tr("common.empty") + ")</i>";
      return `<div class="history-change"><b>${escapeHtml(c.label)}:</b> ${from} → ${to}</div>`;
    }).join("");
    return `<div class="history-entry">
      <div class="history-head">
        <span class="history-action">${escapeHtml(HISTORY_ACTION_LABEL[e.action] || e.action || "")}</span>
        <span class="muted">${formatHistoryTime(e.at)} · ${escapeHtml(e.by || "")}</span>
      </div>
      ${changesHtml || '<div class="history-change muted">' + tr("history.noChanges") + '</div>'}
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
  // Tài khoản "reportonly" chỉ được phép ở đúng 1 trang duy nhất — mọi
  // điều hướng khác (kể cả bấm nhầm nút ẩn, nút "←", hay link cũ) đều bị
  // kéo thẳng về lại trang Chuyển đổi báo cáo.
  if (isReportOnly) name = "reportConvert";
  if (name === "settings" && !isAdmin) name = "dashboard"; // settings/backup/import are admin-only
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const target = $(name);
  if (target) target.classList.add("active");
  if (name !== "scan" && scanning) stopScanner();
  if (name === "assets") renderAssetList();
  if (name === "tickets") renderTicketList();
  if (name === "projects") renderProjectList();
  if (name === "dashboard") renderDashboard();
  if (name === "bulkPrintLabels") renderBulkPrintList();
  if (name === "employees") renderEmployeeList();
}
document.querySelectorAll("[data-page]").forEach(btn => {
  btn.addEventListener("click", () => goPage(btn.getAttribute("data-page")));
});

/* ---------- Account panel (thu gọn góc phải dưới) ---------- */
$("accountToggle").addEventListener("click", e => {
  e.stopPropagation();
  $("accountPanel").classList.toggle("hidden");
});
document.addEventListener("click", e => {
  const panel = $("accountPanel");
  if (!panel.classList.contains("hidden") && !panel.contains(e.target) && e.target !== $("accountToggle")) {
    panel.classList.add("hidden");
  }
});
document.querySelectorAll("[data-page]").forEach(btn => {
  btn.addEventListener("click", () => $("accountPanel").classList.add("hidden"));
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

let unsubscribeProjectSync = null;
function initProjectSync() {
  if (unsubscribeProjectSync) return; // already listening
  unsubscribeProjectSync = db.collection(PROJECT_COLLECTION).onSnapshot(snapshot => {
    projectRecords = snapshot.docs.map(d => Object.assign({ _id: d.id }, d.data()));
    saveProjectsLocalCache();
    renderAll();
  }, err => {
    console.error("Project sync error:", err);
  });
}
function stopProjectSync() {
  if (unsubscribeProjectSync) { unsubscribeProjectSync(); unsubscribeProjectSync = null; }
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
function saveProjectsLocalCache() {
  try { localStorage.setItem("ita_projects_cache", JSON.stringify(projectRecords)); } catch (e) {}
}
function loadProjectsLocalCache() {
  try {
    const raw = localStorage.getItem("ita_projects_cache");
    if (raw) { projectRecords = JSON.parse(raw); renderAll(); }
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
    homeLaptopExportBannerCheck(); // dữ liệu nhân viên đổi (tick mang về/gán tài sản...) -> soát lại cảnh báo cần xuất lại
  }, err => {
    console.warn("Employees sync error (giữ danh sách employees.js):", err);
  });
}
function stopEmployeesSync() {
  if (unsubscribeEmployeesSync) { unsubscribeEmployeesSync(); unsubscribeEmployeesSync = null; }
}

/* ---------- Danh bạ nhân viên (hồ sơ nhân viên + tài sản/ticket liên kết) ----------
   Module thuần đọc — không có form tạo/sửa nhân viên ở đây, thông tin
   nhân viên (code/name/section/group/active) vẫn quản lý qua "Nhập Excel
   HR" ở trang Dữ liệu (xem importEmployeesXlsx). Mục đích module này: từ 1
   nhân viên, xem nhanh họ đang giữ (những) tài sản nào và có (những)
   ticket nào liên quan — khớp bằng field `employeeCode` đã có sẵn và nhất
   quán trên cả 2 collection assets/tickets (xem field.employeeCode). */
function populateEmployeeSectionFilter() {
  const sel = $("employeeFilterSection");
  if (!sel) return;
  const prev = sel.value;
  const sections = Array.from(new Set((window.EMPLOYEES || []).map(e => (e.section || "").trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, "vi"));
  sel.innerHTML = `<option value="">${tr("filter.allSections")}</option>` +
    sections.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  if (prev && sections.includes(prev)) sel.value = prev;
}
function employeeAssetCount(code) { return assets.filter(a => (a.employeeCode || "").trim() === code).length; }
function employeeTicketCount(code) { return ticketRecords.filter(t => (t.employeeCode || "").trim() === code).length; }

function renderEmployeeList() {
  populateEmployeeSectionFilter();
  const q = ($("employeeSearch").value || "").trim().toLowerCase();
  const sectionF = $("employeeFilterSection").value;
  const activeOnly = $("employeeFilterActiveOnly").checked;
  const homeLaptopOnly = $("employeeFilterHomeLaptop").checked;
  let list = (window.EMPLOYEES || []).slice().sort((a, b) => (a.name || "").localeCompare(b.name || "", "vi"));
  if (activeOnly) list = list.filter(e => e.active !== false);
  if (sectionF) list = list.filter(e => (e.section || "").trim() === sectionF);
  if (homeLaptopOnly) list = list.filter(e => e.takeLaptopHome === true);
  if (q) list = list.filter(e => [e.code, e.name].some(v => (v || "").toLowerCase().includes(q)));

  if (!list.length) {
    $("employeeList").innerHTML = `<div class="empty">${tr("employees.noneFound")}</div>`;
    return;
  }
  $("employeeList").innerHTML = list.map(e => {
    const aCount = employeeAssetCount(e.code);
    const tCount = employeeTicketCount(e.code);
    return `
    <div class="asset" style="cursor:pointer" onclick="viewEmployee('${e.code}')">
      <div>
        <h3>${escapeHtml(e.name)} <span class="muted">(${escapeHtml(e.code)})</span></h3>
        <div class="muted">${e.section ? "🏢 " + escapeHtml(e.section) : ""}${e.group ? " · " + escapeHtml(e.group) : ""}</div>
        ${e.active === false ? `<span class="badge bad">${tr("employees.terminated")}</span>` : ""}
        <span class="badge info">🖥 ${tr("employees.assetCount", { count: aCount })}</span>
        <span class="badge info">🎫 ${tr("employees.ticketCount", { count: tCount })}</span>
        ${e.takeLaptopHome ? `<span class="badge ok">🏠 ${tr("employees.homeLaptopBadge")}</span>` : ""}
      </div>
      <div class="asset-actions">
        <button class="secondary" onclick="event.stopPropagation();viewEmployee('${e.code}')">👁 ${tr("action.view")}</button>
      </div>
    </div>`;
  }).join("");
}
$("employeeSearch").addEventListener("input", renderEmployeeList);
$("employeeFilterSection").addEventListener("change", renderEmployeeList);
$("employeeFilterActiveOnly").addEventListener("change", renderEmployeeList);
$("employeeFilterHomeLaptop").addEventListener("change", renderEmployeeList);

function renderEmployeeProfile(code) {
  const emp = (window.EMPLOYEES || []).find(e => e.code === code);
  const linkedAssets = assets.filter(a => (a.employeeCode || "").trim() === code)
    .sort((a, b) => (a.code || "").localeCompare(b.code || ""));
  const linkedTickets = ticketRecords.filter(t => (t.employeeCode || "").trim() === code)
    .sort((a, b) => (b.ticketId || "").localeCompare(a.ticketId || ""));

  $("employeeProfileTitle").textContent = emp ? `${emp.name} (${emp.code})` : code;
  // Admin sửa "Mang laptop về nhà" qua card cố định #employeeHomeLaptopCard
  // (renderEmployeeHomeLaptopCard bên dưới, dùng ID cố định để autocomplete
  // chọn tài sản hoạt động được) — ở đây chỉ hiện badge đọc-only cho role
  // khác (Collector/Viewer), khớp việc Firestore Rules chỉ cho Admin ghi
  // collection `employees`.
  const homeLaptopBadge = (emp && emp.takeLaptopHome && !isAdmin)
    ? `<div style="margin-top:8px"><span class="badge ok">🏠 ${tr("employees.homeLaptopBadge")}</span></div>` : "";
  $("employeeProfileInfo").innerHTML = emp ? `
    <div class="muted">${tr("field.employeeCode")}: <b style="color:#0f172a">${escapeHtml(emp.code)}</b></div>
    <div class="muted">${tr("employees.fullName")}: <b style="color:#0f172a">${escapeHtml(emp.name)}</b></div>
    ${emp.section ? `<div class="muted">🏢 ${tr("field.section")}: <b style="color:#0f172a">${escapeHtml(emp.section)}</b></div>` : ""}
    ${emp.group ? `<div class="muted">${tr("field.group")}: <b style="color:#0f172a">${escapeHtml(emp.group)}</b></div>` : ""}
    <span class="badge ${emp.active === false ? "bad" : "ok"}">${emp.active === false ? tr("employees.terminated") : tr("employees.active")}</span>
    ${homeLaptopBadge}
  ` : `<div class="empty">${tr("employees.notInHr", { code })}</div>`;
  renderEmployeeHomeLaptopCard(emp);

  $("employeeProfileAssetsHead").textContent = tr("employees.linkedAssetsHead", { count: linkedAssets.length });
  $("employeeProfileAssets").innerHTML = linkedAssets.length ? linkedAssets.map(a => `
    <div class="asset">
      <div>
        <h3>${escapeHtml(a.code)}</h3>
        <div class="muted">${escapeHtml(a.type || "")}${a.model ? " · " + escapeHtml(a.model) : ""}</div>
        <span class="badge ${badgeClass(a.checkStatus)}">${escapeHtml(checkLabel(a.checkStatus))}</span>
      </div>
      <div class="asset-actions">
        <button onclick="editAsset('${a._id}')">${isAdmin ? "✎ " + tr("action.edit") : "👁 " + tr("action.view")}</button>
      </div>
    </div>`).join("") : `<div class="empty">${tr("employees.noAssets")}</div>`;

  $("employeeProfileTicketsHead").textContent = tr("employees.linkedTicketsHead", { count: linkedTickets.length });
  $("employeeProfileTickets").innerHTML = linkedTickets.length ? linkedTickets.map(t => `
    <div class="asset">
      <div>
        <h3>${escapeHtml(t.ticketId)}</h3>
        <div class="muted">${escapeHtml((t.description || "").slice(0, 80))}</div>
        <span class="badge ${ticketBadgeClass(t.status)}">${escapeHtml(ticketStatusLabel(t.status))}</span>
        <span class="prio-badge prio-${prioritySlug(t.priority)}">${escapeHtml(ticketPriorityLabel(t.priority || "Trung bình"))}</span>
      </div>
      <div class="asset-actions">
        <button onclick="editTicket('${t._id}')">${isAdmin ? "✎ " + tr("action.edit") : "👁 " + tr("action.view")}</button>
      </div>
    </div>`).join("") : `<div class="empty">${tr("employees.noTickets")}</div>`;
}
window.viewEmployee = function (code) {
  renderEmployeeProfile(code);
  goPage("employeeProfile");
};

/* ---------- Card "Mang laptop về nhà" trong hồ sơ nhân viên (Admin) ----------
   Tick "Cho phép mang về" -> hiện thêm ô chọn TÀI SẢN cụ thể (autocomplete
   giống hệt cơ chế "Liên kết tài sản" ở form Ticket). Cho phép NHIỀU nhân
   viên khác nhau cùng chọn đúng 1 tài sản — đúng use-case "1 laptop nhiều
   người thay phiên mang về" (xem exportHomeLaptopReport bên dưới sẽ tự gộp
   nhóm này lại khi xuất báo cáo). Field `homeLaptopAssetId` lưu riêng trên
   employees/{code}, độc lập với field `employeeCode` trên chính tài sản đó
   (tài sản vẫn chỉ có đúng 1 "chủ sở hữu chính thức" cho mục đích kiểm kê). */
function renderEmployeeHomeLaptopCard(emp) {
  const card = $("employeeHomeLaptopCard");
  if (!card) return;
  if (!emp) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  const toggle = $("employeeHomeLaptopToggle");
  toggle.checked = !!emp.takeLaptopHome;
  toggle.dataset.code = emp.code;
  $("employeeHomeLaptopAssetWrap").classList.toggle("hidden", !emp.takeLaptopHome);
  const linkedAsset = emp.homeLaptopAssetId ? assets.find(a => a._id === emp.homeLaptopAssetId) : null;
  $("employeeHomeLaptopAssetInput").value = linkedAsset ? `${linkedAsset.code}${linkedAsset.model ? " · " + linkedAsset.model : ""}` : "";
  $("employeeHomeLaptopAssetId").value = linkedAsset ? linkedAsset._id : "";
  if (linkedAsset) {
    const coUsers = (window.EMPLOYEES || []).filter(e => e.code !== emp.code && e.takeLaptopHome && e.homeLaptopAssetId === linkedAsset._id);
    $("employeeHomeLaptopAssetHint").textContent = coUsers.length
      ? tr("employees.homeLaptopSharedHint", { names: coUsers.map(e => e.name).join(", ") })
      : "";
  } else {
    const owned = assets.filter(a => (a.employeeCode || "").trim() === emp.code);
    $("employeeHomeLaptopAssetHint").textContent = owned.length ? tr("employees.homeLaptopAssetHintOwned") : tr("employees.homeLaptopAssetHintNone");
  }
}
async function saveEmployeeHomeLaptopFlag(code, takeHome, assetId) {
  try {
    await db.collection(EMPLOYEES_COLLECTION).doc(sanitizeId(code)).set({
      takeLaptopHome: takeHome,
      homeLaptopAssetId: takeHome ? (assetId || "") : ""
    }, { merge: true });
  } catch (err) {
    alert(tr("msg.errSaveEmployeeFlag", { err: err.message }));
    renderEmployeeProfile(code); // rollback UI về đúng trạng thái Firestore nếu ghi thất bại
  }
}
$("employeeHomeLaptopToggle").addEventListener("change", async e => {
  const code = e.target.dataset.code;
  if (!code) return;
  const checked = e.target.checked;
  $("employeeHomeLaptopAssetWrap").classList.toggle("hidden", !checked);
  await saveEmployeeHomeLaptopFlag(code, checked, checked ? $("employeeHomeLaptopAssetId").value : "");
});
setupAutocomplete("employeeHomeLaptopAssetInput", "employeeHomeLaptopAssetSuggest",
  q => {
    const query = q.trim().toLowerCase();
    let list = assets;
    if (query) list = assets.filter(a => [a.code, a.user, a.employeeCode, a.type, a.model, a.serial, a.section].some(v => (v || "").toLowerCase().includes(query)));
    return list.slice(0, 20);
  },
  a => `${escapeHtml(a.code)}<span class="muted">${escapeHtml(a.type || "")}${a.model ? " · " + escapeHtml(a.model) : ""}${a.user ? " · 👤 " + escapeHtml(a.user) : ""}</span>`,
  async a => {
    $("employeeHomeLaptopAssetInput").value = `${a.code}${a.model ? " · " + a.model : ""}`;
    $("employeeHomeLaptopAssetId").value = a._id;
    const code = $("employeeHomeLaptopToggle").dataset.code;
    if (code) { await saveEmployeeHomeLaptopFlag(code, true, a._id); renderEmployeeProfile(code); }
  }
);
$("employeeHomeLaptopAssetInput").addEventListener("input", () => { $("employeeHomeLaptopAssetId").value = ""; });
$("employeeHomeLaptopAssetInput").addEventListener("blur", () => setTimeout(async () => {
  // Gõ tay rồi rời ô mà không chọn từ gợi ý -> coi như xóa liên kết tài sản
  // cũ (không tự đoán/giữ lại, tránh gán nhầm tài sản không đúng).
  if ($("employeeHomeLaptopAssetId").value) return;
  const code = $("employeeHomeLaptopToggle").dataset.code;
  if (!code) return;
  const emp = (window.EMPLOYEES || []).find(e => e.code === code);
  if (emp && emp.takeLaptopHome && emp.homeLaptopAssetId && !$("employeeHomeLaptopAssetInput").value.trim()) {
    await saveEmployeeHomeLaptopFlag(code, true, "");
  }
}, 150));

/* ---------- Người dùng & phân quyền (Dữ liệu → Người dùng, chỉ Admin) ----------
   Đọc/ghi trực tiếp collection `users` (users/{uid} -> {role, email,
   createdAt, createdBy}). Chỉ subscribe khi đang đăng nhập Admin, vì
   Firestore Rules chỉ cho Admin đọc TOÀN BỘ collection này (tài khoản
   khác chỉ đọc được đúng 1 doc của chính mình). */
let userAccounts = [];
let unsubscribeUsersSync = null;
function initUsersSync() {
  if (unsubscribeUsersSync) return;
  unsubscribeUsersSync = db.collection(USERS_COLLECTION).onSnapshot(snapshot => {
    userAccounts = snapshot.docs.map(d => Object.assign({ _uid: d.id }, d.data()));
    renderUserList();
  }, err => {
    console.warn("Users sync error:", err);
  });
}
function stopUsersSync() {
  if (unsubscribeUsersSync) { unsubscribeUsersSync(); unsubscribeUsersSync = null; }
  userAccounts = [];
}
const ROLE_LABELS_VI = { admin: "Quản trị (Admin)", collector: "Thu thập dữ liệu", viewer: "Chỉ xem", reportonly: "Chuyển đổi báo cáo (chỉ 1 trang)" };
function roleLabel(role) { return tr("role.label." + role) || ROLE_LABELS_VI[role] || role; }
function renderUserList() {
  const box = $("userList");
  if (!box) return;
  if (!userAccounts.length) { box.innerHTML = `<p class="muted">${tr("userList.empty")}</p>`; return; }
  const sorted = [...userAccounts].sort((a, b) => (a.email || "").localeCompare(b.email || ""));
  box.innerHTML = sorted.map(u => {
    const isSelf = u._uid === currentUid;
    const isDisabled = u.disabled === true;
    const emailLabel = u.email || `<span class="muted">(${tr("userList.unknownEmail")})</span>`;
    const roleOptions = ["admin", "collector", "viewer", "reportonly"].map(r =>
      `<option value="${r}" ${u.role === r ? "selected" : ""}>${roleLabel(r)}</option>`).join("");
    return `<div class="asset">
      <div>
        <h3>${emailLabel}${isSelf ? ` <span class="badge info">${tr("userList.you")}</span>` : ""}${isDisabled ? ` <span class="badge bad">${tr("userList.locked")}</span>` : ""}</h3>
        <span class="muted">UID: ${u._uid}</span>
      </div>
      <div class="asset-actions">
        <select onchange="changeUserRole('${u._uid}', this.value)" ${isSelf ? `disabled title="${tr("userList.cantChangeOwnRoleTitle")}"` : ""}>${roleOptions}</select>
        <button class="secondary" onclick="resetUserPassword('${u._uid}', '${escapeHtml(u.email || "")}')">🔑 ${tr("userList.resetPassword")}</button>
        <button class="secondary" onclick="toggleUserActive('${u._uid}', '${escapeHtml(u.email || u._uid)}', ${isDisabled})" ${isSelf ? `disabled title="${tr("userList.cantLockSelfTitle")}"` : ""}>${isDisabled ? "✅ " + tr("action.enable") : "🚫 " + tr("action.disable")}</button>
      </div>
    </div>`;
  }).join("");
}
async function changeUserRole(uid, newRole) {
  if (uid === currentUid) { alert(tr("msg.cantChangeOwnRole")); renderUserList(); return; }
  if (!confirm(tr("msg.confirmChangeRole", { role: roleLabel(newRole) }))) { renderUserList(); return; }
  try {
    await db.collection(USERS_COLLECTION).doc(uid).update({ role: newRole });
  } catch (err) {
    console.error(err);
    alert(tr("msg.errChangeRole", { err: err.message || err }));
    renderUserList();
  }
}
async function resetUserPassword(uid, email) {
  // Firebase KHÔNG cho phép đặt thẳng 1 mật khẩu mới cho tài khoản người
  // khác từ client SDK (kể cả Admin) — chỉ Admin SDK/Cloud Functions mới
  // làm được, app này không có backend riêng. Cách chuẩn: gửi email đặt
  // lại mật khẩu, người dùng tự bấm link và tự đặt mật khẩu mới.
  if (!email) {
    email = (prompt(tr("prompt.needConsoleEmail")) || "").trim();
    if (!email || !email.includes("@")) return;
  }
  if (!confirm(tr("msg.confirmResetPw", { email }))) return;
  try {
    await auth.sendPasswordResetEmail(email);
    const acct = userAccounts.find(u => u._uid === uid);
    if (acct && !acct.email) {
      // Vừa nhập tay email cho tài khoản tạo qua Console — lưu lại luôn
      // để lần sau danh sách hiện đúng email, khỏi phải nhập lại.
      await db.collection(USERS_COLLECTION).doc(uid).update({ email });
    }
    alert(tr("msg.resetPwSent", { email }));
  } catch (err) {
    console.error(err);
    let msg = err.message || String(err);
    if (err.code === "auth/user-not-found") msg = tr("msg.authUserNotFound");
    alert(tr("msg.errResetPw", { err: msg }));
  }
}
async function toggleUserActive(uid, label, currentlyDisabled) {
  if (uid === currentUid) { alert(tr("msg.cantLockSelf")); return; }
  const action = currentlyDisabled ? tr("action.enable") : tr("action.disable");
  const note = currentlyDisabled
    ? tr("msg.noteWillReenable", { label })
    : tr("msg.noteWillDisable", { label });
  if (!confirm(tr("msg.confirmLockAction", { action, note }))) return;
  try {
    await db.collection(USERS_COLLECTION).doc(uid).update({ disabled: !currentlyDisabled });
  } catch (err) {
    console.error(err);
    alert(tr("msg.errLockAction", { action: action.toLowerCase(), err: err.message || err }));
  }
}
$("showAddUserBtn").addEventListener("click", () => {
  $("addUserForm").classList.remove("hidden");
  $("showAddUserBtn").classList.add("hidden");
});
$("cancelAddUserBtn").addEventListener("click", () => {
  $("addUserForm").classList.add("hidden");
  $("showAddUserBtn").classList.remove("hidden");
  $("newUserEmail").value = "";
  $("newUserPassword").value = "";
});
$("submitAddUserBtn").addEventListener("click", async () => {
  const email = $("newUserEmail").value.trim();
  const password = $("newUserPassword").value;
  const role = $("newUserRole").value;
  if (!email || !email.includes("@")) { alert(tr("msg.invalidEmail")); return; }
  if (!password || password.length < 6) { alert(tr("msg.pwMinLen")); return; }
  const btn = $("submitAddUserBtn");
  btn.disabled = true;
  try {
    const cred = await secondaryAuth.createUserWithEmailAndPassword(email, password);
    const newUid = cred.user.uid;
    await secondaryAuth.signOut(); // dọn phiên app phụ, không ảnh hưởng phiên Admin đang dùng
    await db.collection(USERS_COLLECTION).doc(newUid).set({
      role, email,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUid
    });
    alert(tr("msg.userCreated", { email, role: roleLabel(role) }));
    $("newUserEmail").value = "";
    $("newUserPassword").value = "";
    $("addUserForm").classList.add("hidden");
    $("showAddUserBtn").classList.remove("hidden");
  } catch (err) {
    console.error(err);
    let msg = err.message || String(err);
    if (err.code === "auth/email-already-in-use") msg = tr("msg.emailInUse");
    alert(tr("msg.errCreateUser", { err: msg }));
  } finally {
    btn.disabled = false;
  }
});

function renderAll() {
  renderDashboard();
  renderAssetList();
  renderTicketList();
  renderProjectList();
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
  let html = `<div class="hint">${tr("dashboard.progress", { checked, total, pct })}</div>
    <div class="bar"><i style="width:${pct}%"></i></div>`;
  if (!total) html = `<div class="empty">${tr("dashboard.noAssets")}</div>`;
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
  sel.innerHTML = `<option value="">${tr("filter.allSections")}</option>` +
    sections.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  if (prev && sections.includes(prev)) sel.value = prev;
}

function renderAssetList() {
  populateSectionFilter();
  const q = ($("search").value || "").trim().toLowerCase();
  const checkF = $("filterCheck").value;
  const sectionF = $("filterSection").value;
  const fromV = $("filterCreatedFrom").value; // yyyy-mm-dd hoặc ""
  const toV = $("filterCreatedTo").value;
  // Mốc đầu ngày "Từ" và cuối ngày "Đến" theo giờ máy (local), để lọc trọn
  // cả 2 ngày biên chứ không cắt theo giờ.
  const fromMs = fromV ? new Date(fromV + "T00:00:00").getTime() : null;
  const toMs = toV ? new Date(toV + "T23:59:59.999").getTime() : null;
  $("clearDateFilterBtn").classList.toggle("hidden", !fromV && !toV);

  let list = assets.slice().sort((a, b) => (a.code || "").localeCompare(b.code || ""));
  if (q) {
    list = list.filter(a =>
      [a.code, a.serial, a.model, a.deviceName, a.user, a.employeeCode].some(v => (v || "").toLowerCase().includes(q))
    );
  }
  if (checkF) list = list.filter(a => classifyCheck(a.checkStatus) === checkF);
  if (sectionF) list = list.filter(a => (a.section || "").trim() === sectionF);
  if (fromMs || toMs) {
    list = list.filter(a => {
      const ms = assetCreatedMs(a);
      if (!ms) return false; // không rõ ngày tạo -> loại khỏi kết quả khi đang lọc theo ngày
      if (fromMs && ms < fromMs) return false;
      if (toMs && ms > toMs) return false;
      return true;
    });
  }

  if (!list.length) {
    $("assetList").innerHTML = `<div class="empty">${tr("assets.noneFound")}</div>`;
    return;
  }
  $("assetList").innerHTML = list.map(a => {
    const editBtn = isAdmin
      ? `<button onclick="editAsset('${a._id}')">✎ ${tr("action.edit")}</button>`
      : `<button onclick="editAsset('${a._id}')">👁 ${tr("action.view")}</button>`;
    const deleteBtn = isAdmin
      ? `<button class="secondary" onclick="deleteAsset('${a._id}')">🗑 ${tr("action.delete")}</button>`
      : "";
    return `
    <div class="asset">
      <div>
        <h3>${escapeHtml(a.code)}</h3>
        <div class="muted">${escapeHtml(a.type || "")} ${a.model ? "· " + escapeHtml(a.model) : ""}</div>
        <div class="muted">${a.user ? "👤 " + escapeHtml(a.user) : ""}${a.employeeCode ? " (" + escapeHtml(a.employeeCode) + ")" : ""}</div>
        ${a.section ? `<div class="muted">🏢 ${escapeHtml(a.section)}</div>` : ""}
        ${assetCreatedMs(a) ? `<div class="muted">🗓 ${tr("field.createdAt")}: ${escapeHtml(formatAssetDate(assetCreatedMs(a)))}</div>` : ""}
        <span class="badge ${badgeClass(a.checkStatus)}">${escapeHtml(checkLabel(a.checkStatus))}</span>
        ${!isAdmin ? `<span class="badge view-only-tag">👁 ${tr("action.viewOnly")}</span>` : ""}
      </div>
      <div class="asset-actions">
        ${editBtn}
        <button class="secondary" onclick="printLabel('${a._id}')">🏷 ${tr("qr.print")}</button>
        ${deleteBtn}
      </div>
    </div>
  `;
  }).join("");
}
$("search").addEventListener("input", renderAssetList);
$("filterCheck").addEventListener("change", renderAssetList);
$("filterSection").addEventListener("change", renderAssetList);
$("filterCreatedFrom").addEventListener("change", renderAssetList);
$("filterCreatedTo").addEventListener("change", renderAssetList);
$("clearDateFilterBtn").addEventListener("click", () => {
  $("filterCreatedFrom").value = "";
  $("filterCreatedTo").value = "";
  renderAssetList();
});

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
      box.innerHTML = `<div class="suggest-empty">${tr("suggest.empty")}</div>`;
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
  $("formTitle").textContent = tr("assetForm.createTitle");
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
  $("formTitle").textContent = tr("assetForm.editTitle", { code: a.code || "" });
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
  if (!confirm(tr("msg.confirmDeleteAsset", { code: a.code }))) return;
  db.collection(COLLECTION).doc(id).delete().catch(err => alert(tr("msg.errDelete", { err: err.message })));
};

$("assetFormEl").addEventListener("submit", e => {
  e.preventDefault();
  const code = $("code").value.trim();
  if (!code) { alert(tr("msg.needAssetCode")); return; }
  const newId = sanitizeId(code);
  if (!newId) { alert(tr("msg.invalidAssetCode")); return; }
  const oldId = $("assetId").value;
  const oldAsset = oldId ? assets.find(a => a._id === oldId) : null;

  // Defense in depth: the form is already disabled for non-admins on any
  // EXISTING record, but double-check here too. Firestore Rules are the
  // real enforcement layer regardless — the collector account can only
  // ever create brand-new docs, never update one that already exists.
  if (!isAdmin && oldId) {
    alert(tr("msg.noPermEditAsset"));
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
  // createdAt chỉ set 1 lần lúc tạo mới (không ghi đè khi sửa/đổi mã), để
  // dùng cho việc hiển thị + lọc theo ngày tạo trên trang Danh sách tài sản.
  if (!oldId) data.createdAt = firebase.firestore.FieldValue.serverTimestamp();

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
      fieldChanges.unshift({ field: "code", label: tr("field.code").replace("*", ""), from: oldAsset ? oldAsset.code : oldId, to: code });
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
      alert(tr("msg.dupSerial", { serial: data.serial, code: dup.code }) +
        (isAdmin ? " " + tr("msg.dupSerialAdminHint") : " " + tr("msg.dupSerialStaffHint")));
      return;
    }
  }

  const submitBtn = $("assetFormEl").querySelector('button[type="submit"]');
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = tr("common.saving");

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
      alert(tr("msg.errSyncServer", { err: err.message }) + "\n\n" + tr("msg.errSyncServerHint"));
    });

  // Give the local write a brief moment to land in the cache, then proceed —
  // this keeps the UI responsive even fully offline.
  setTimeout(() => {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
    renderQR(code);
    $("assetId").value = newId;
    $("formTitle").textContent = tr("assetForm.editTitle", { code });
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
  const text = assetLinkFor(code);
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
  if (!dataUrl) { alert(tr("msg.needQrFirst")); return; }
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
// Dựng 1 khối tem (dùng chung cho in đơn lẻ + in hàng loạt) từ <template
// id="printLabelItemTpl"> — mỗi lần gọi clone ra 1 node độc lập nên in bao
// nhiêu tem cũng không đụng nhau (khác instance QRCode/canvas riêng).
function buildLabelItemEl(data) {
  const node = $("printLabelItemTpl").content.firstElementChild.cloneNode(true);
  node.querySelector(".plCode").textContent = data.code || "";
  // Người sử dụng + Mã nhân viên gộp 1 dòng (giống cách hiển thị ở danh sách
  // Tài sản/Ticket/Dự án: "👤 Tên (Mã NV)") để tiết kiệm diện tích tem.
  const userEl = node.querySelector(".plUser");
  const userText = data.user
    ? ("👤 " + data.user + (data.employeeCode ? " (" + data.employeeCode + ")" : ""))
    : (data.employeeCode ? ("👤 " + data.employeeCode) : "");
  userEl.textContent = userText;
  userEl.style.display = userText ? "" : "none";
  const sectionEl = node.querySelector(".plSection");
  sectionEl.textContent = data.section ? ("🏢 " + data.section) : "";
  sectionEl.style.display = data.section ? "" : "none";
  const modelEl = node.querySelector(".plModel");
  modelEl.textContent = data.model || "";
  modelEl.style.display = data.model ? "" : "none";
  const serialEl = node.querySelector(".plSerial");
  serialEl.textContent = data.serial ? ("SN: " + data.serial) : "";
  serialEl.style.display = data.serial ? "" : "none";
  new QRCode(node.querySelector(".plQr"), { text: assetLinkFor(data.code || ""), width: 300, height: 300 });
  return node;
}
// In 1 tem đơn lẻ — giữ nguyên hành vi cũ (nút "🏷 In tem" trên danh sách
// tài sản / trong form tài sản), chỉ đổi cách dựng DOM bên trong.
function renderPrintLabel(data) {
  const area = $("printLabelArea");
  area.innerHTML = "";
  area.appendChild(buildLabelItemEl(data));
}
window.printLabel = function (id) {
  const a = assets.find(x => x._id === id);
  if (!a) return;
  renderPrintLabel(a);
  setTimeout(() => printWithFilename(a.employeeCode || a.code), 150); // đợi QR render xong canvas rồi mới in
};
$("printLabelBtn").addEventListener("click", () => {
  const code = $("code").value.trim();
  if (!code) { alert(tr("msg.needCodeBeforePrint")); return; }
  const employeeCode = $("employeeCode").value.trim();
  renderPrintLabel({
    code,
    type: $("type").value,
    model: $("model").value.trim(),
    serial: $("serial").value.trim(),
    spec: $("spec").value.trim(),
    user: $("user").value.trim(),
    employeeCode,
    section: $("section").value.trim()
  });
  setTimeout(() => printWithFilename(employeeCode || code), 150);
});

/* ---------- In tem hàng loạt (theo Bộ phận hoặc Tất cả) ----------
   Dùng lại đúng khối tem 70x50mm sẵn có (buildLabelItemEl) — chỉ khác là
   nhét N khối vào #printLabelArea thay vì 1, mỗi khối tự ngắt trang khi in
   (xem CSS .print-label-item{page-break-after}) nên máy in tem cuộn liên
   tục (GP-1424D...) tự nhảy sang tem kế tiếp cho từng trang mà không cần
   thao tác gì thêm giữa các tem. */
let bulkPrintSelected = new Set(); // _id các tài sản đang được tick chọn để in

function populateBulkPrintSectionFilter() {
  const sel = $("bulkPrintSection");
  if (!sel) return;
  const prev = sel.value;
  const sections = Array.from(new Set(assets.map(a => (a.section || "").trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, "vi"));
  sel.innerHTML = `<option value="">${tr("bulkPrint.allSections")}</option>` +
    sections.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  if (prev && sections.includes(prev)) sel.value = prev;
}

function bulkPrintFilteredAssets() {
  const sectionF = $("bulkPrintSection").value;
  let list = assets.slice().sort((a, b) => (a.code || "").localeCompare(b.code || ""));
  if (sectionF) list = list.filter(a => (a.section || "").trim() === sectionF);
  return list;
}

function updateBulkPrintCount() {
  const total = $("bulkPrintList").querySelectorAll(".bulkPrintCheck").length;
  const checked = $("bulkPrintList").querySelectorAll(".bulkPrintCheck:checked").length;
  $("bulkPrintCount").textContent = tr("bulkPrint.countLabel", { checked, total });
}

function renderBulkPrintList() {
  populateBulkPrintSectionFilter();
  const list = bulkPrintFilteredAssets();
  // Mỗi khi đổi bộ lọc mà chưa có tài sản nào (trong danh sách đang hiện)
  // từng được chọn trước đó -> auto-tick hết, tiện cho ca dùng phổ biến
  // nhất "in hết cả bộ phận/tất cả". Nếu người dùng đã tự bỏ chọn vài cái,
  // giữ nguyên lựa chọn khi họ quay lại đúng bộ lọc đó.
  const visibleIds = new Set(list.map(a => a._id));
  if (![...bulkPrintSelected].some(id => visibleIds.has(id))) {
    list.forEach(a => bulkPrintSelected.add(a._id));
  }
  $("bulkPrintList").innerHTML = list.map(a => `
    <label class="asset bulk-print-row">
      <input type="checkbox" class="bulkPrintCheck" data-id="${a._id}" ${bulkPrintSelected.has(a._id) ? "checked" : ""}>
      <div>
        <h3>${escapeHtml(a.code)}</h3>
        <div class="muted">${escapeHtml(a.type || "")}${a.model ? " · " + escapeHtml(a.model) : ""}</div>
        <div class="muted">${a.user ? "👤 " + escapeHtml(a.user) : ""}${a.employeeCode ? " (" + escapeHtml(a.employeeCode) + ")" : ""}</div>
        ${a.section ? `<div class="muted">🏢 ${escapeHtml(a.section)}</div>` : ""}
      </div>
    </label>
  `).join("") || `<div class="empty">${tr("assets.noneFound")}</div>`;
  updateBulkPrintCount();
}

$("bulkPrintSection").addEventListener("change", renderBulkPrintList);
$("bulkPrintList").addEventListener("change", e => {
  if (!e.target.classList.contains("bulkPrintCheck")) return;
  const id = e.target.getAttribute("data-id");
  if (e.target.checked) bulkPrintSelected.add(id); else bulkPrintSelected.delete(id);
  updateBulkPrintCount();
});
$("bulkPrintSelectAll").addEventListener("click", () => {
  $("bulkPrintList").querySelectorAll(".bulkPrintCheck").forEach(cb => { cb.checked = true; bulkPrintSelected.add(cb.getAttribute("data-id")); });
  updateBulkPrintCount();
});
$("bulkPrintSelectNone").addEventListener("click", () => {
  $("bulkPrintList").querySelectorAll(".bulkPrintCheck").forEach(cb => { cb.checked = false; bulkPrintSelected.delete(cb.getAttribute("data-id")); });
  updateBulkPrintCount();
});
$("bulkPrintGoBtn").addEventListener("click", () => {
  const list = bulkPrintFilteredAssets().filter(a => bulkPrintSelected.has(a._id));
  if (!list.length) { alert(tr("bulkPrint.needSelect")); return; }
  const area = $("printLabelArea");
  area.innerHTML = "";
  list.forEach(a => area.appendChild(buildLabelItemEl(a)));
  const sectionF = $("bulkPrintSection").value;
  const suggestedName = "tem-" + (sectionF ? sanitizeId(sectionF) : "tat-ca");
  // Nhiều tem => nhiều canvas QR cần vẽ xong trước khi mở hộp thoại in,
  // chờ lâu hơn 1 chút so với in đơn lẻ (150ms) cho chắc, nhất là trên
  // điện thoại đời cũ.
  setTimeout(() => printWithFilename(suggestedName), 250);
});

/* ---------- Báo cáo: Đăng ký nhân viên mang laptop về nhà ----------
   Xuất file .xlsx đúng mẫu công ty đang dùng để gửi Bảo vệ đối chiếu:
   STT | Họ và tên | Mã nhân viên | Bộ phận | Tổ/Chuyền | Mã tài sản |
   Tên/Model Laptop | Số Serial | Ký tên nhân viên — có gộp (merge) dọc 3
   cột cuối cùng của phần tài sản khi NHIỀU nhân viên dùng CHUNG 1 laptop
   (đúng cách công ty đã làm tay trước đây). Nguồn dữ liệu: employees có
   takeLaptopHome=true; tài sản lấy theo homeLaptopAssetId đã chọn ở hồ sơ
   nhân viên (renderEmployeeHomeLaptopCard), fallback tự nhận nếu nhân
   viên đó đang là chủ sở hữu chính thức của ĐÚNG 1 tài sản. */
function resolveHomeLaptopAsset(emp) {
  if (emp.homeLaptopAssetId) {
    const a = assets.find(x => x._id === emp.homeLaptopAssetId);
    if (a) return a;
  }
  const owned = assets.filter(a => (a.employeeCode || "").trim() === emp.code);
  return owned.length === 1 ? owned[0] : null;
}
// Chuỗi đại diện toàn bộ đăng ký hiện tại (ai + mang tài sản nào) để so
// sánh với lần xuất gần nhất trên Firestore -> phát hiện thay đổi.
function homeLaptopSignature(list) {
  return list.map(e => `${e.code}:${e.homeLaptopAssetId || ""}`).sort().join("|");
}
const HOME_LAPTOP_THIN_BORDER = { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } };
const HOME_LAPTOP_FONT = { name: "Times New Roman", sz: 10 };

function buildHomeLaptopSheet(list, scopeLabel) {
  const rows = list.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "", "vi"));
  const aoa = [];
  aoa.push(["", "", "CÔNG TY TNHH CÔNG NGHỆ SÁNG TẠO XANH S.E.C", "", "", "", "", "", ""]);
  aoa.push(["", "", "DANH SÁCH ĐĂNG KÝ NHÂN VIÊN MANG LAPTOP VỀ NHÀ" + (scopeLabel ? ` — ${scopeLabel}` : ""), "", "", "", "", "", ""]);
  aoa.push([]);
  aoa.push(["STT", "Họ và tên", "Mã nhân viên", "Bộ phận", "Tổ/Chuyền", "Mã tài sản", "Tên/Model Laptop", "Số Serial", "Ký tên nhân viên"]);
  const dataStartRow = aoa.length; // chỉ số dòng (0-based) của dòng dữ liệu đầu tiên
  rows.forEach((e, i) => {
    const a = resolveHomeLaptopAsset(e);
    aoa.push([
      i + 1, e.name || "", e.code || "", e.section || "", e.group || "",
      a ? a.code : "", a ? [a.type, a.model].filter(Boolean).join(" ") : "", a ? (a.serial || "") : "", ""
    ]);
  });
  const noteRowIdx = aoa.length;
  aoa.push([`Ghi chú: Danh sách xuất tự động từ hệ thống IT Asset Inventory ngày ${new Date().toLocaleDateString("vi-VN")}. Mỗi nhân viên tự ký xác nhận ở cột "Ký tên nhân viên".`]);
  aoa.push([]); aoa.push([]);
  const signHeadRow = aoa.length;
  aoa.push(["", "NGƯỜI LẬP DANH SÁCH", "", "", "", "", "TRƯỞNG BỘ PHẬN", "", ""]);
  aoa.push(["", "(Ký, ghi rõ họ tên)", "", "", "", "", "(Ký, ghi rõ họ tên)", "", ""]);
  aoa.push([]); aoa.push([]); aoa.push([]); aoa.push([]);
  const signLineRow = aoa.length;
  aoa.push(["", "", "", "", "", "", "", "", ""]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const merges = [
    { s: { r: 0, c: 2 }, e: { r: 0, c: 8 } },
    { s: { r: 1, c: 2 }, e: { r: 1, c: 8 } },
    { s: { r: noteRowIdx, c: 0 }, e: { r: noteRowIdx, c: 8 } },
    { s: { r: signHeadRow, c: 1 }, e: { r: signHeadRow, c: 3 } },
    { s: { r: signHeadRow, c: 6 }, e: { r: signHeadRow, c: 7 } },
    { s: { r: signHeadRow + 1, c: 1 }, e: { r: signHeadRow + 1, c: 3 } },
    { s: { r: signHeadRow + 1, c: 6 }, e: { r: signHeadRow + 1, c: 7 } },
    { s: { r: signLineRow, c: 1 }, e: { r: signLineRow, c: 3 } },
    { s: { r: signLineRow, c: 6 }, e: { r: signLineRow, c: 7 } }
  ];

  // Gộp dọc 3 cột Mã tài sản/Model/Serial cho các nhân viên dùng CHUNG
  // đúng 1 tài sản (nhóm theo asset._id, không cần các dòng nằm liền kề
  // sẵn — sort lại theo tên nên có thể xen kẽ, ta tự gom nhóm bằng Map).
  const groups = new Map();
  rows.forEach((e, i) => {
    const a = resolveHomeLaptopAsset(e);
    if (!a) return;
    if (!groups.has(a._id)) groups.set(a._id, []);
    groups.get(a._id).push(dataStartRow + i);
  });
  groups.forEach((rowIdxs, assetId) => {
    if (rowIdxs.length < 2) return; // chỉ merge khi thật sự có ≥2 người dùng chung
    const first = rowIdxs[0], last = rowIdxs[rowIdxs.length - 1];
    [5, 6, 7].forEach(col => merges.push({ s: { r: first, c: col }, e: { r: last, c: col } }));
    for (let r = first + 1; r <= last; r++) {
      [5, 6, 7].forEach(col => {
        const addr = XLSX.utils.encode_cell({ r, c: col });
        if (ws[addr]) ws[addr].v = "";
      });
    }
    const codeAddr = XLSX.utils.encode_cell({ r: first, c: 5 });
    if (ws[codeAddr]) ws[codeAddr].v = `${ws[codeAddr].v}\n(${rowIdxs.length} người dùng chung)`;
  });
  ws["!merges"] = merges;
  ws["!cols"] = [{ wch: 5 }, { wch: 24 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 20 }, { wch: 16 }, { wch: 16 }];
  ws["!rows"] = []; ws["!rows"][3] = { hpt: 30 };

  function setStyle(r, c, style) {
    const addr = XLSX.utils.encode_cell({ r, c });
    if (!ws[addr]) ws[addr] = { t: "s", v: "" };
    ws[addr].s = style;
  }
  setStyle(0, 2, { font: Object.assign({}, HOME_LAPTOP_FONT, { sz: 12, bold: true }), alignment: { horizontal: "center", vertical: "center" } });
  setStyle(1, 2, { font: Object.assign({}, HOME_LAPTOP_FONT, { sz: 14, bold: true }), alignment: { horizontal: "center", vertical: "center" } });
  for (let c = 0; c <= 8; c++) {
    setStyle(3, c, {
      font: Object.assign({}, HOME_LAPTOP_FONT, { bold: true }),
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
      fill: { fgColor: { rgb: "D9E1F2" } },
      border: HOME_LAPTOP_THIN_BORDER
    });
  }
  rows.forEach((e, i) => {
    const r = dataStartRow + i;
    for (let c = 0; c <= 8; c++) {
      setStyle(r, c, { font: HOME_LAPTOP_FONT, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: HOME_LAPTOP_THIN_BORDER });
    }
  });
  setStyle(noteRowIdx, 0, { font: Object.assign({}, HOME_LAPTOP_FONT, { sz: 9 }), alignment: { horizontal: "left" } });
  [signHeadRow, signHeadRow + 1].forEach(r => {
    setStyle(r, 1, { font: Object.assign({}, HOME_LAPTOP_FONT, { bold: r === signHeadRow }), alignment: { horizontal: "center" } });
    setStyle(r, 6, { font: Object.assign({}, HOME_LAPTOP_FONT, { bold: r === signHeadRow }), alignment: { horizontal: "center" } });
  });
  setStyle(signLineRow, 1, { border: { top: { style: "thin" } } });
  setStyle(signLineRow, 6, { border: { top: { style: "thin" } } });
  return ws;
}
window.exportHomeLaptopReport = function (scopeFromBanner) {
  const scope = (scopeFromBanner !== undefined ? scopeFromBanner : $("employeeFilterSection").value) || "";
  const list = (window.EMPLOYEES || []).filter(e => e.takeLaptopHome === true && (!scope || (e.section || "").trim() === scope));
  if (!list.length) { alert(tr("employees.homeLaptopExportEmpty")); return; }
  const ws = buildHomeLaptopSheet(list, scope || tr("employees.homeLaptopAllScope"));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "DS Mang Laptop");
  const scopeTag = scope ? sanitizeId(scope) : "TAT_CA";
  const ts = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `DANG_KY_MANG_LAPTOP_VE_-_${scopeTag}_${ts}.xlsx`);
  // "Chữ ký" chỉ cập nhật khi xuất TOÀN BỘ (không lọc bộ phận) — vì đó mới
  // là danh sách tổng gửi Bảo vệ, xuất riêng theo từng bộ phận chỉ là tiện
  // ích phụ, không tính là "đã gửi bản cập nhật mới nhất".
  if (!scope) saveHomeLaptopExportSignature();
};
async function saveHomeLaptopExportSignature() {
  const sig = homeLaptopSignature((window.EMPLOYEES || []).filter(e => e.takeLaptopHome === true));
  try {
    await db.collection("meta").doc("homeLaptopExport").set({
      signature: sig, exportedAt: firebase.firestore.FieldValue.serverTimestamp(), exportedBy: currentEmail || ""
    }, { merge: true });
  } catch (err) {
    console.warn("Không lưu được trạng thái xuất báo cáo mang laptop:", err);
  }
}
$("exportHomeLaptopBtn").addEventListener("click", () => exportHomeLaptopReport());

// Theo dõi thay đổi để cảnh báo "cần xuất lại" — so sánh chữ ký hiện tại
// với chữ ký đã lưu ở lần xuất TOÀN BỘ gần nhất trên Firestore (meta/homeLaptopExport).
let homeLaptopExportSignatureSaved = null; // null = chưa load xong từ Firestore
let unsubscribeHomeLaptopExportMeta = null;
function initHomeLaptopExportMetaSync() {
  if (unsubscribeHomeLaptopExportMeta) return;
  unsubscribeHomeLaptopExportMeta = db.collection("meta").doc("homeLaptopExport").onSnapshot(doc => {
    homeLaptopExportSignatureSaved = doc.exists ? (doc.data().signature || "") : "";
    homeLaptopExportBannerCheck();
  }, err => console.warn("meta/homeLaptopExport sync error:", err));
}
function stopHomeLaptopExportMetaSync() {
  if (unsubscribeHomeLaptopExportMeta) { unsubscribeHomeLaptopExportMeta(); unsubscribeHomeLaptopExportMeta = null; }
  homeLaptopExportSignatureSaved = null;
}
function homeLaptopExportBannerCheck() {
  const banner = $("homeLaptopChangeBanner");
  if (!banner) return;
  if (!isAdmin || homeLaptopExportSignatureSaved === null) { banner.classList.add("hidden"); return; }
  const current = homeLaptopSignature((window.EMPLOYEES || []).filter(e => e.takeLaptopHome === true));
  banner.classList.toggle("hidden", current === homeLaptopExportSignatureSaved);
}

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
$("takePhoto").addEventListener("click", () => $("photoCamera").click());
async function handlePhotoFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const dataUrl = await resizeImage(file);
    currentPhotoData = dataUrl;
    $("photoPreview").src = dataUrl;
    $("photoPreview").classList.remove("hidden");
  } catch (err) {
    alert(tr("msg.errReadImage", { err: err.message }));
  }
  e.target.value = "";
}
$("photo").addEventListener("change", handlePhotoFileChange);
$("photoCamera").addEventListener("change", handlePhotoFileChange);

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
    alert(tr("msg.psCopied"));
  } catch (e) {
    prompt(tr("prompt.copyPsScript"), PS_SCRIPT);
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
    alert(tr("msg.psQrCopied"));
  } catch (e) {
    prompt(tr("prompt.copyPsScriptQr"), PS_SCRIPT_QR);
  }
});

$("btnAutofill").addEventListener("click", () => {
  const text = $("pasteInfoBox").value;
  if (!text.trim()) { alert(tr("msg.needPasteContent")); return; }

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
      alert(tr("msg.pasteWrongContent"));
    } else {
      alert(tr("msg.noFieldRecognized"));
    }
    return;
  }
  if (!/^\s*MAC\s*:/im.test(text) || !/^\s*IP\s*:/im.test(text)) {
    if (!confirm(tr("msg.confirmMissingIpMac", { filled }))) return;
  }
  alert(tr("msg.autofilled", { filled }));
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
    alert(tr("msg.cameraError", { err }));
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
    alert(tr("msg.qrDecodeError"));
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
  toast(tr("toast.qrFilled", { name: data.TENMAY || tr("toast.unnamedDevice") }));
}
function extractAssetCodeFromScan(decodedText) {
  const text = (decodedText || "").trim();
  if (text.startsWith("ITASSET:")) return text.slice(8).trim(); // tương thích tem cũ
  try {
    const u = new URL(text);
    const c = u.searchParams.get("code");
    if (c) return c.trim();
  } catch (e) { /* không phải URL hợp lệ */ }
  return null;
}
function handleScannedAssetCode(code) {
  goPage("scan");
  const resBox = $("scanResult");
  resBox.classList.remove("hidden");
  const existing = assets.find(a => a.code === code);
  if (existing) {
    const rows = [
      ["💻 " + tr("field.deviceName"), existing.deviceName],
      ["🔢 " + tr("field.serial"), existing.serial],
      ["👤 " + tr("field.user"), existing.user],
      ["🆔 " + tr("field.employeeCode"), existing.employeeCode],
    ].filter(([, v]) => v)
     .map(([label, v]) => `<div class="scan-row"><span class="muted">${label}</span> ${escapeHtml(v)}</div>`)
     .join("");
    resBox.innerHTML = `<b>${escapeHtml(code)}</b> — ${escapeHtml(existing.model || existing.type || "")}<br>
      <span class="badge ${badgeClass(existing.checkStatus)}">${escapeHtml(checkLabel(existing.checkStatus))}</span>
      ${rows ? `<div class="scan-info">${rows}</div>` : ""}
      <button style="margin-top:8px" onclick="editAsset('${existing._id}')">${tr("scan.openToUpdate")}</button>`;
  } else {
    resBox.innerHTML = `<b>${escapeHtml(code)}</b> — ${tr("scan.notInSystem")}<br>
      <button style="margin-top:8px" onclick="quickCreate('${escapeHtml(code)}')">${tr("scan.createNewWithCode")}</button>`;
  }
}
function onScanSuccess(decodedText) {
  if (decodedText.startsWith("DEVINFO:")) {
    stopScanner();
    onDevInfoScan(decodedText.slice(8).trim());
    return;
  }
  const code = extractAssetCodeFromScan(decodedText);
  if (!code) return;
  stopScanner();
  handleScannedAssetCode(code);
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
  if (!assets.length) { alert(tr("msg.noDataExport")); return; }
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
const PDF_STATUS_COLORS = { "Tốt": "#16a34a", "Đang sử dụng": "#2563eb", "Dự phòng": "#0ea5e9", "Hỏng": "#dc2626", "Lưu kho": "#a16207", "Thu hồi": "#9333ea", "Mất": "#7c2d12", "Thanh lý": "#94a3b8" };

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
  .pdf-cover .pdf-logo-wrap{background:#fff; border-radius:16px; padding:16px 26px; margin-bottom:28px; display:inline-flex}
  .pdf-cover .pdf-logo-wrap img{height:54px; display:block}
  .pdf-header-logo{height:20px; display:block; background:#fff; border-radius:4px; padding:2px 6px; margin-right:10px}
  .pdf-cover h1{font-size:30px; margin:0 0 10px; letter-spacing:.5px}
  .pdf-cover .pdf-sub{font-size:16px; color:${PDF_PALETTE.blueLight}; margin-bottom:18px}
  .pdf-cover .pdf-meta{font-size:12px; color:#cbd5e1; line-height:1.6}
  .pdf-content{padding:36px 40px 60px}
  .pdf-header{background:${PDF_PALETTE.navy}; color:#fff; padding:14px 40px; display:flex; align-items:center; font-weight:700; font-size:14px}
  .pdf-header span:first-of-type{flex:1}
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
    alert(tr("msg.pdfLibError"));
    return;
  }
  if (!assets.length) { alert(tr("msg.noDataReport")); return; }

  const btn = $("exportPdfReport");
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⏳ " + tr("common.generatingPdf");

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
      const sec = (a.section || "").trim() || tr("pdf.unassigned");
      bySection[sec] = (bySection[sec] || 0) + 1;
      const typ = a.type || tr("pdf.other");
      byType[typ] = (byType[typ] || 0) + 1;
      const st = a.status || tr("pdf.unknown");
      byStatus[st] = (byStatus[st] || 0) + 1;
    });
    const pct = total ? Math.round((checked / total) * 100) : 0;
    const now = new Date();
    const dateLocale = { vi: "vi-VN", en: "en-US", zh: "zh-CN" }[getLang()] || "vi-VN";
    const dateStr = now.toLocaleDateString(dateLocale);
    const headerBar = `<div class="pdf-header"><img src="logo.png" class="pdf-header-logo"><span>${tr("pdf.title")}</span><span class="pdf-header-sub">SEC — IT Asset Inventory</span></div>`;
    const footerBar = pageNum => `<div class="pdf-footer"><span>${tr("pdf.exportedOn", { date: dateStr })}</span><span>${tr("pdf.page", { n: pageNum })}</span></div>`;

    /* ---- Trang bìa ---- */
    const cover = document.createElement("div");
    cover.className = "pdf-page pdf-cover";
    cover.innerHTML = `
      <div class="pdf-blob1"></div><div class="pdf-blob2"></div>
      <div class="pdf-logo-wrap"><img src="logo.png" alt="S.E.C."></div>
      <h1>${tr("pdf.title")}</h1>
      <div class="pdf-sub">SEC — IT Asset Inventory</div>
      <div class="pdf-meta">${tr("pdf.coverMeta", { date: dateStr, total })}</div>`;
    root.appendChild(cover);

    /* ---- Trang tổng quan ---- */
    const overview = document.createElement("div");
    overview.className = "pdf-page";
    overview.innerHTML = `
      ${headerBar}
      <div class="pdf-content">
        <div class="pdf-h1">${tr("pdf.section1Title")}</div>
        <hr class="pdf-hr">
        <div class="pdf-cards">
          <div class="pdf-card" style="--accent:${PDF_PALETTE.blue}"><b>${total}</b><span>${tr("stats.total")}</span></div>
          <div class="pdf-card" style="--accent:${PDF_PALETTE.green}"><b>${checked}</b><span>${tr("stats.checked")}</span></div>
          <div class="pdf-card" style="--accent:${PDF_PALETTE.amber}"><b>${unchecked}</b><span>${tr("stats.unchecked")}</span></div>
          <div class="pdf-card" style="--accent:${PDF_PALETTE.red}"><b>${exception}</b><span>${tr("stats.exception")}</span></div>
        </div>
        <div class="pdf-progress-wrap">
          <div class="pdf-body">${tr("pdf.overallProgress", { checked, total, pct })}</div>
          <div class="pdf-progress-bar"><i style="width:${pct}%"></i></div>
        </div>
        <div class="pdf-h2">${tr("pdf.checkRatio")}</div>
        <div class="pdf-chart-box"><canvas id="pdfChartDonut" width="440" height="440"></canvas></div>
        <div class="pdf-legend">
          <span><i style="background:${PDF_PALETTE.green}"></i>${tr("stats.checked")} (${checked})</span>
          <span><i style="background:${PDF_PALETTE.amber}"></i>${tr("stats.unchecked")} (${unchecked})</span>
          <span><i style="background:${PDF_PALETTE.red}"></i>${tr("stats.exception")} (${exception})</span>
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
        <div class="pdf-h1">${tr("pdf.section2Title")}</div>
        <hr class="pdf-hr">
        <div class="pdf-body">${tr("pdf.bySectionDesc")}</div>
        <div class="pdf-chart-box"><canvas id="pdfChartSection" width="700" height="${Math.max(200, sectionEntries.length * 34 + 50)}"></canvas></div>
        <div class="pdf-h2">${tr("pdf.section3Title")}</div>
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
        <div class="pdf-h1">${tr("pdf.section4Title")}</div>
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
        ? `<div class="pdf-h1">${tr("pdf.section5Title")}</div><hr class="pdf-hr"><div class="pdf-body">${tr("pdf.allAssetsDesc")}</div>`
        : `<div class="pdf-h1">${tr("pdf.section5TitleCont")}</div><hr class="pdf-hr">`;
      const rows = chunk.map(a => {
        const bc = pdfBadgeColors(a.checkStatus || CHECK_UNCHECKED);
        return `<tr>
          <td><b>${escapeHtml(a.code)}</b></td>
          <td>${escapeHtml(a.type || "")}</td>
          <td>${escapeHtml(a.model || "")}</td>
          <td>${escapeHtml(a.user || "—")}</td>
          <td>${escapeHtml(a.section || "")}</td>
          <td>${escapeHtml(statusLabel(a.status || ""))}</td>
          <td><span class="pdf-badge" style="background:${bc.bg};color:${bc.fg}">${escapeHtml(checkLabel(a.checkStatus))}</span></td>
        </tr>`;
      }).join("");
      const legend = idx === chunks.length - 1 ? `
        <div class="pdf-legend" style="margin-top:16px">
          <span><i style="background:${PDF_PALETTE.greenBg};border:1px solid ${PDF_PALETTE.green}"></i>${tr("stats.checked")}</span>
          <span><i style="background:${PDF_PALETTE.amberBg};border:1px solid ${PDF_PALETTE.amber}"></i>${tr("stats.unchecked")}</span>
          <span><i style="background:${PDF_PALETTE.redBg};border:1px solid ${PDF_PALETTE.red}"></i>${tr("stats.exception")}</span>
        </div>` : "";
      page.innerHTML = `
        ${headerBar}
        <div class="pdf-content">
          ${heading}
          <table class="pdf-table">
            <thead><tr><th>${tr("pdf.colCode")}</th><th>${tr("pdf.colType")}</th><th>${tr("pdf.colModel")}</th><th>${tr("pdf.colUser")}</th><th>${tr("pdf.colSection")}</th><th>${tr("pdf.colStatus")}</th><th>${tr("pdf.colCheck")}</th></tr></thead>
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
        labels: [tr("stats.checked"), tr("stats.unchecked"), tr("stats.exception")],
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
        labels: statusEntries.map(e => statusLabel(e[0])),
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
    alert(tr("msg.errPdfReport", { err: err.message }));
  } finally {
    chartInstances.forEach(c => c.destroy());
    root.remove();
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

$("exportPdfReport").addEventListener("click", generatePdfReport);

/* ---------- PDF report export (Ticket) ----------
   Xuất báo cáo Ticket dạng PDF: trang bìa + trang tổng quan (thẻ số liệu +
   bảng danh sách toàn bộ ticket) + 1 trang chi tiết cho MỖI ticket (thông
   tin, mô tả/nguyên nhân/cách xử lý, lịch sử xử lý nếu có, và ẢNH ĐÍNH KÈM
   nếu ticket đó có ảnh). Dùng lại đúng cơ chế render HTML ẩn ngoài màn hình
   rồi chụp html2canvas + ghép jsPDF như báo cáo tài sản (generatePdfReport)
   ở trên — không thêm thư viện mới, giữ nguyên palette PDF_PALETTE.
*/
const TPDF_STATUS_COLORS = {
  "Chờ": { bg: PDF_PALETTE.amberBg, fg: PDF_PALETTE.amber },
  "Đang xử lý": { bg: "#dbeafe", fg: "#1e40af" },
  "Hoàn thành": { bg: PDF_PALETTE.greenBg, fg: PDF_PALETTE.green }
};
const TPDF_PRIORITY_COLORS = {
  "Khẩn": { bg: "#fee2e2", fg: "#991b1b" },
  "Cao": { bg: "#fef3c7", fg: "#92400e" },
  "Trung bình": { bg: "#dbeafe", fg: "#1e40af" },
  "Thấp": { bg: "#e2e8f0", fg: "#334155" }
};
function tpdfStatusColors(status) { return TPDF_STATUS_COLORS[status] || TPDF_STATUS_COLORS["Chờ"]; }
function tpdfPriorityColors(p) { return TPDF_PRIORITY_COLORS[p] || TPDF_PRIORITY_COLORS["Trung bình"]; }

// Suy ra thời điểm/tài khoản tạo ticket từ Lịch sử thay đổi (history), vì
// ticket không lưu riêng field createdAt/createdBy — history[0] (hoặc entry
// action "create") là gần đúng nhất.
function ticketCreatedInfo(t) {
  const list = Array.isArray(t.history) ? t.history : [];
  const entry = list.find(e => e.action === "create") || list[0];
  if (!entry) return "";
  const time = formatHistoryTime(entry.at);
  return entry.by ? `${time} · ${entry.by}` : time;
}

// Trả về thời điểm tạo (epoch ms) của 1 ticket, hoặc null nếu không xác
// định được — dùng để tính "đã mở bao nhiêu ngày" trong renderTicketList().
// Ưu tiên field `createdAt` (Firestore Timestamp, có từ khi thêm tính năng
// này), rồi tới mốc sớm nhất trong `history` (mọi ticket tạo trong app đều
// có ít nhất 1 entry "create"), cuối cùng fallback parse ngày nhúng sẵn
// trong Mã ticket dạng IT-YYYYMMDD-NNN (áp dụng cho ticket import Excel cũ
// không có 2 nguồn trên).
function ticketCreatedMs(t) {
  if (!t) return null;
  if (t.createdAt && typeof t.createdAt.toMillis === "function") return t.createdAt.toMillis();
  if (t.createdAt instanceof Date) return t.createdAt.getTime();
  if (Array.isArray(t.history) && t.history.length) {
    const earliest = t.history.reduce((min, e) => (e.at && (!min || e.at < min)) ? e.at : min, null);
    if (earliest) return earliest;
  }
  const m = /^IT-(\d{4})(\d{2})(\d{2})-/.exec(t.ticketId || "");
  if (m) {
    const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (!isNaN(ms)) return ms;
  }
  return null;
}
// Số ngày đã trôi qua từ lúc tạo ticket đến hôm nay (làm tròn xuống theo
// ngày lịch, không phải 24h chẵn, để "tạo sáng nay" hiện đúng 0 ngày).
function ticketAgeDays(t) {
  const ms = ticketCreatedMs(t);
  if (!ms) return null;
  const start = new Date(ms); start.setHours(0, 0, 0, 0);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((now - start) / 86400000));
}
// Badge hiển thị số ngày — đổi màu theo độ trễ để nhận ra ngay ticket nào
// đang bị "ngâm" lâu chưa xử lý. Ticket đã "Hoàn thành" hiện màu trung
// tính (không cần cảnh báo nữa) thay vì đỏ.
function ticketAgeBadge(t) {
  const days = ticketAgeDays(t);
  if (days === null) return "";
  const label = days === 0 ? tr("ticket.ageToday") : tr("ticket.ageDays", { days });
  if ((t.status || "Chờ") === "Hoàn thành") return `<span class="badge">🕓 ${escapeHtml(label)}</span>`;
  let cls = "info";
  if (days >= 14) cls = "bad";
  else if (days >= 7) cls = "warn";
  else if (days >= 3) cls = "info";
  else cls = "ok";
  return `<span class="badge ${cls}">🕓 ${escapeHtml(label)}</span>`;
}

function ensureTicketPdfReportStyles() {
  if ($("tpdfReportStyles")) return;
  const style = document.createElement("style");
  style.id = "tpdfReportStyles";
  style.textContent = `
  .tk-topbar{display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px}
  .tk-id{font-size:22px; font-weight:800; color:${PDF_PALETTE.navy}}
  .tk-sub{font-size:11px; color:${PDF_PALETTE.slate}; margin-top:2px}
  .tk-badges{display:flex; gap:6px; flex-shrink:0}
  .tk-grid{display:grid; grid-template-columns:1fr 1fr; gap:8px 24px; margin:16px 0; font-size:11.5px}
  .tk-field b{display:block; color:${PDF_PALETTE.slate}; font-size:9.5px; text-transform:uppercase; letter-spacing:.4px; margin-bottom:2px; font-weight:700}
  .tk-field span{color:#1e293b}
  .tk-section-title{font-size:12.5px; font-weight:800; color:${PDF_PALETTE.navy}; margin:16px 0 6px; padding-bottom:4px; border-bottom:2px solid ${PDF_PALETTE.slateLight}}
  .tk-text{font-size:11.5px; color:#334155; line-height:1.6; background:${PDF_PALETTE.slateLight}; border-radius:8px; padding:10px 12px; margin-bottom:2px; white-space:pre-wrap}
  .tk-photo-wrap{margin-top:6px; text-align:center}
  .tk-photo-wrap img{max-width:100%; max-height:280px; border-radius:10px; border:1px solid #e2e8f0}
  .tk-photo-caption{font-size:9.5px; color:${PDF_PALETTE.slate}; margin-top:6px}
  .tk-progress-item{display:flex; gap:10px; font-size:10.5px; padding:6px 0; border-bottom:1px dashed #e2e8f0}
  .tk-progress-time{color:${PDF_PALETTE.slate}; white-space:nowrap; min-width:120px; flex-shrink:0}
  .tk-progress-item span:last-child{flex:1; min-width:0; word-break:break-word}
  table.tpdf-list-table{width:100%; border-collapse:collapse; font-size:10.5px; table-layout:fixed}
  table.tpdf-list-table thead th{background:${PDF_PALETTE.navy}; color:#fff; text-align:left; padding:8px 8px; font-size:10px}
  table.tpdf-list-table tbody td{padding:6px 8px; border-bottom:1px solid #e2e8f0; vertical-align:top; word-break:break-word}
  table.tpdf-list-table tbody tr:nth-child(even) td{background:${PDF_PALETTE.slateLight}}
  `;
  document.head.appendChild(style);
}

async function generateTicketPdfReport() {
  if (!window.jspdf || !window.html2canvas) {
    alert(tr("msg.pdfLibError"));
    return;
  }
  if (!ticketRecords.length) { alert(tr("msg.noTicketDataReport")); return; }

  const btn = $("exportTicketPdfReport");
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⏳ " + tr("common.generatingPdf");

  ensurePdfReportStyles();
  ensureTicketPdfReportStyles();
  const root = document.createElement("div");
  root.id = "pdfReportRoot";
  document.body.appendChild(root);

  try {
    const statusFilter = $("ticketPdfStatusFilter") ? $("ticketPdfStatusFilter").value : "";
    const list = ticketRecords.slice()
      .filter(t => !statusFilter || (t.status || "Chờ") === statusFilter)
      .sort((a, b) => (b.ticketId || "").localeCompare(a.ticketId || ""));
    if (!list.length) {
      alert(tr("msg.noTicketDataReport"));
      root.remove();
      btn.disabled = false;
      btn.textContent = oldText;
      return;
    }
    const total = list.length;
    let pending = 0, inProgress = 0, done = 0;
    list.forEach(t => {
      const st = t.status || "Chờ";
      if (st === "Hoàn thành") done++;
      else if (st === "Đang xử lý") inProgress++;
      else pending++;
    });
    const now = new Date();
    const dateLocale = { vi: "vi-VN", en: "en-US", zh: "zh-CN" }[getLang()] || "vi-VN";
    const dateStr = now.toLocaleDateString(dateLocale);
    const headerBar = `<div class="pdf-header"><img src="logo.png" class="pdf-header-logo"><span>${tr("tpdf.title")}</span><span class="pdf-header-sub">SEC — IT Helpdesk Report</span></div>`;
    const footerBar = pageNum => `<div class="pdf-footer"><span>${tr("pdf.exportedOn", { date: dateStr })}</span><span>${tr("pdf.page", { n: pageNum })}</span></div>`;

    /* ---- Trang bìa ---- */
    const cover = document.createElement("div");
    cover.className = "pdf-page pdf-cover";
    cover.innerHTML = `
      <div class="pdf-blob1"></div><div class="pdf-blob2"></div>
      <div class="pdf-logo-wrap"><img src="logo.png" alt="S.E.C."></div>
      <h1>${tr("tpdf.title")}</h1>
      <div class="pdf-sub">SEC — IT Helpdesk Report</div>
      <div class="pdf-meta">${tr("tpdf.coverMeta", { date: dateStr, total })}${statusFilter ? `<br>${tr("tpdf.filterStatusLabel")}: ${escapeHtml(tr(statusFilter === "Chờ" ? "ticket.status.pending" : statusFilter === "Đang xử lý" ? "ticket.status.inProgress" : "ticket.status.done"))}` : ""}</div>`;
    root.appendChild(cover);

    /* ---- Trang tổng quan: thẻ số liệu + bảng danh sách ---- */
    const listRows = list.map(t => {
      const sc = tpdfStatusColors(t.status || "Chờ");
      const pc = tpdfPriorityColors(t.priority || "Trung bình");
      return `<tr>
        <td><b>${escapeHtml(t.ticketId)}</b></td>
        <td><span class="pdf-badge" style="background:${pc.bg};color:${pc.fg}">${escapeHtml(ticketPriorityLabel(t.priority || "Trung bình"))}</span></td>
        <td><span class="pdf-badge" style="background:${sc.bg};color:${sc.fg}">${escapeHtml(ticketStatusLabel(t.status))}</span></td>
        <td>${escapeHtml(t.requester || tr("tpdf.noValue"))}</td>
        <td>${escapeHtml(t.department || "")}</td>
        <td>${escapeHtml(t.device || "")}</td>
        <td>${t.photo ? tr("tpdf.photoYes") : tr("tpdf.photoNo")}</td>
      </tr>`;
    }).join("");
    const overview = document.createElement("div");
    overview.className = "pdf-page";
    overview.innerHTML = `
      ${headerBar}
      <div class="pdf-content">
        <div class="pdf-h1">${tr("tpdf.section1Title")}</div>
        <hr class="pdf-hr">
        <div class="pdf-cards">
          <div class="pdf-card" style="--accent:${PDF_PALETTE.blue}"><b>${total}</b><span>${tr("tpdf.statTotal")}</span></div>
          <div class="pdf-card" style="--accent:${PDF_PALETTE.amber}"><b>${pending}</b><span>${tr("tpdf.statPending")}</span></div>
          <div class="pdf-card" style="--accent:${PDF_PALETTE.blue}"><b>${inProgress}</b><span>${tr("tpdf.statInProgress")}</span></div>
          <div class="pdf-card" style="--accent:${PDF_PALETTE.green}"><b>${done}</b><span>${tr("tpdf.statDone")}</span></div>
        </div>
        <div class="pdf-h2">${tr("tpdf.listTitle")}</div>
        <table class="tpdf-list-table">
          <thead><tr>
            <th style="width:16%">${tr("tpdf.colTicketId")}</th>
            <th style="width:11%">${tr("tpdf.colPriority")}</th>
            <th style="width:13%">${tr("tpdf.colStatus")}</th>
            <th style="width:16%">${tr("tpdf.colRequester")}</th>
            <th style="width:14%">${tr("tpdf.colDepartment")}</th>
            <th style="width:20%">${tr("tpdf.colDevice")}</th>
            <th style="width:10%">${tr("tpdf.colPhoto")}</th>
          </tr></thead>
          <tbody>${listRows}</tbody>
        </table>
      </div>
      ${footerBar(1)}`;
    root.appendChild(overview);

    /* ---- 1 trang chi tiết cho mỗi ticket ---- */
    list.forEach((t, idx) => {
      const sc = tpdfStatusColors(t.status || "Chờ");
      const pc = tpdfPriorityColors(t.priority || "Trung bình");
      const created = ticketCreatedInfo(t);
      const progressRows = (t.progressLog && t.progressLog.length)
        ? t.progressLog.map(p => `<div class="tk-progress-item"><span class="tk-progress-time">${escapeHtml(formatHistoryTime(p.at))}${p.by ? " · " + escapeHtml(p.by) : ""}</span><span>${escapeHtml(p.note || "")}</span></div>`).join("")
        : "";
      const photoBlock = t.photo ? `
        <div class="tk-section-title">${tr("tpdf.sectionPhoto")}</div>
        <div class="tk-photo-wrap">
          <img src="${t.photo}">
          <div class="tk-photo-caption">${tr("tpdf.photoCaption", { id: t.ticketId })}</div>
        </div>` : "";
      const page = document.createElement("div");
      page.className = "pdf-page";
      page.innerHTML = `
        ${headerBar}
        <div class="pdf-content">
          ${idx === 0 ? `<div class="pdf-h1">${tr("tpdf.section2Title")}</div><hr class="pdf-hr">` : ""}
          <div class="tk-topbar">
            <div>
              <div class="tk-id">${escapeHtml(t.ticketId)}</div>
              ${created ? `<div class="tk-sub">${escapeHtml(created)}</div>` : ""}
            </div>
            <div class="tk-badges">
              <span class="pdf-badge" style="background:${pc.bg};color:${pc.fg}">${escapeHtml(ticketPriorityLabel(t.priority || "Trung bình"))}</span>
              <span class="pdf-badge" style="background:${sc.bg};color:${sc.fg}">${escapeHtml(ticketStatusLabel(t.status))}</span>
            </div>
          </div>
          <div class="tk-grid">
            <div class="tk-field"><b>${tr("tpdf.fieldRequester")}</b><span>${escapeHtml(t.requester || tr("tpdf.noValue"))}${t.employeeCode ? " (" + escapeHtml(t.employeeCode) + ")" : ""}</span></div>
            <div class="tk-field"><b>${tr("tpdf.fieldDepartment")}</b><span>${escapeHtml(t.department || tr("tpdf.noValue"))}</span></div>
            <div class="tk-field"><b>${tr("tpdf.fieldDevice")}</b><span>${escapeHtml(t.device || tr("tpdf.noValue"))}</span></div>
            <div class="tk-field"><b>${tr("tpdf.fieldLinkedAsset")}</b><span>${escapeHtml(t.assetCode || tr("tpdf.noValue"))}</span></div>
          </div>
          ${t.description ? `<div class="tk-section-title">${tr("tpdf.sectionDescription")}</div><div class="tk-text">${escapeHtml(t.description)}</div>` : ""}
          ${t.cause ? `<div class="tk-section-title">${tr("tpdf.sectionCause")}</div><div class="tk-text">${escapeHtml(t.cause)}</div>` : ""}
          ${t.resolution ? `<div class="tk-section-title">${tr("tpdf.sectionResolution")}</div><div class="tk-text">${escapeHtml(t.resolution)}</div>` : ""}
          ${t.note ? `<div class="tk-section-title">${tr("tpdf.sectionNote")}</div><div class="tk-text">${escapeHtml(t.note)}</div>` : ""}
          ${progressRows ? `<div class="tk-section-title">${tr("tpdf.sectionProgress")}</div>${progressRows}` : ""}
          ${photoBlock}
        </div>
        ${footerBar(2 + idx)}`;
      root.appendChild(page);
    });

    /* ---- Chụp từng trang & ghép vào PDF (giống báo cáo tài sản) ---- */
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
    const statusSlug = { "Chờ": "cho-xu-ly", "Đang xử lý": "dang-xu-ly", "Hoàn thành": "hoan-thanh" }[statusFilter] || "";
    pdf.save(`bao-cao-ticket${statusSlug ? "-" + statusSlug : ""}-${now.toISOString().slice(0, 10)}.pdf`);
  } catch (err) {
    console.error(err);
    alert(tr("msg.errTicketPdfReport", { err: err.message }));
  } finally {
    root.remove();
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

$("exportTicketPdfReport").addEventListener("click", generateTicketPdfReport);

/* ---------- PDF report export (Dự án CNTT) ----------
   Xuất báo cáo Dự án dạng PDF: trang bìa + trang tổng quan (thẻ số liệu:
   tổng số, trễ hạn, tiến độ trung bình + bảng theo Trạng thái/Ưu tiên +
   bảng danh sách toàn bộ dự án) + 1 trang chi tiết cho MỖI dự án (thông
   tin, mô tả/ghi chú, mốc tiến độ nếu có, tài liệu đính kèm nếu có). Dùng
   lại đúng cơ chế render HTML ẩn ngoài màn hình rồi chụp html2canvas + ghép
   jsPDF như báo cáo Ticket (generateTicketPdfReport) ở trên — không thêm
   thư viện mới, giữ nguyên palette PDF_PALETTE.
*/
const PPDF_STATUS_COLORS = {
  "Lên kế hoạch": { bg: PDF_PALETTE.amberBg, fg: PDF_PALETTE.amber },
  "Đang thực hiện": { bg: "#dbeafe", fg: "#1e40af" },
  "Tạm dừng": { bg: "#e2e8f0", fg: "#334155" },
  "Hoàn thành": { bg: PDF_PALETTE.greenBg, fg: PDF_PALETTE.green },
  "Hủy": { bg: PDF_PALETTE.redBg, fg: PDF_PALETTE.red }
};
const PPDF_PRIORITY_COLORS = TPDF_PRIORITY_COLORS;
function ppdfStatusColors(status) { return PPDF_STATUS_COLORS[status] || PPDF_STATUS_COLORS["Lên kế hoạch"]; }
function ppdfPriorityColors(p) { return TPDF_PRIORITY_COLORS[p] || TPDF_PRIORITY_COLORS["Trung bình"]; }

// Suy ra thời điểm/tài khoản tạo dự án từ Lịch sử thay đổi (history), giống
// hệt cơ chế ticketCreatedInfo (dự án không lưu riêng createdAt/createdBy).
function projectCreatedInfo(p) {
  const list = Array.isArray(p.history) ? p.history : [];
  const entry = list.find(e => e.action === "create") || list[0];
  if (!entry) return "";
  const time = formatHistoryTime(entry.at);
  return entry.by ? `${time} · ${entry.by}` : time;
}

function ensureProjectPdfReportStyles() {
  if ($("ppdfReportStyles")) return;
  const style = document.createElement("style");
  style.id = "ppdfReportStyles";
  style.textContent = `
  .pk-topbar{display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px}
  .pk-id{font-size:22px; font-weight:800; color:${PDF_PALETTE.navy}}
  .pk-sub{font-size:11px; color:${PDF_PALETTE.slate}; margin-top:2px}
  .pk-badges{display:flex; gap:6px; flex-shrink:0}
  .pk-grid{display:grid; grid-template-columns:1fr 1fr; gap:8px 24px; margin:16px 0; font-size:11.5px}
  .pk-field b{display:block; color:${PDF_PALETTE.slate}; font-size:9.5px; text-transform:uppercase; letter-spacing:.4px; margin-bottom:2px; font-weight:700}
  .pk-field span{color:#1e293b}
  .pk-section-title{font-size:12.5px; font-weight:800; color:${PDF_PALETTE.navy}; margin:16px 0 6px; padding-bottom:4px; border-bottom:2px solid ${PDF_PALETTE.slateLight}}
  .pk-text{font-size:11.5px; color:#334155; line-height:1.6; background:${PDF_PALETTE.slateLight}; border-radius:8px; padding:10px 12px; margin-bottom:2px; white-space:pre-wrap}
  .pk-progress-item{display:flex; gap:10px; font-size:10.5px; padding:6px 0; border-bottom:1px dashed #e2e8f0}
  .pk-progress-time{color:${PDF_PALETTE.slate}; white-space:nowrap; min-width:120px; flex-shrink:0}
  .pk-progress-item span:last-child{flex:1; min-width:0; word-break:break-word}
  .pk-attach-item{font-size:10.5px; padding:5px 0; border-bottom:1px dashed #e2e8f0}
  .pk-attach-item span{color:${PDF_PALETTE.slate}; margin-left:6px}
  .pk-breakdown{display:flex; gap:8px; flex-wrap:wrap; margin:6px 0 18px}
  .pk-breakdown-item{display:flex; align-items:center; gap:6px; background:#fff; border:1px solid #e2e8f0; border-radius:999px; padding:5px 12px; font-size:11px}
  .pk-breakdown-item b{color:${PDF_PALETTE.navy}}
  table.ppdf-list-table{width:100%; border-collapse:collapse; font-size:10.5px; table-layout:fixed}
  table.ppdf-list-table thead th{background:${PDF_PALETTE.navy}; color:#fff; text-align:left; padding:8px 8px; font-size:10px}
  table.ppdf-list-table tbody td{padding:6px 8px; border-bottom:1px solid #e2e8f0; vertical-align:top; word-break:break-word}
  table.ppdf-list-table tbody tr:nth-child(even) td{background:${PDF_PALETTE.slateLight}}
  `;
  document.head.appendChild(style);
}

async function generateProjectPdfReport() {
  if (!window.jspdf || !window.html2canvas) {
    alert(tr("msg.pdfLibError"));
    return;
  }
  if (!projectRecords.length) { alert(tr("msg.noProjectDataReport")); return; }

  const btn = $("exportProjectPdfReport");
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⏳ " + tr("common.generatingPdf");

  ensurePdfReportStyles();
  ensureProjectPdfReportStyles();
  const root = document.createElement("div");
  root.id = "pdfReportRoot";
  document.body.appendChild(root);

  try {
    const statusFilter = $("projectPdfStatusFilter") ? $("projectPdfStatusFilter").value : "";
    const list = projectRecords.slice()
      .filter(p => !statusFilter || (p.status || "Lên kế hoạch") === statusFilter)
      .sort((a, b) => (b.projectCode || "").localeCompare(a.projectCode || ""));
    if (!list.length) {
      alert(tr("msg.noProjectDataReport"));
      root.remove();
      btn.disabled = false;
      btn.textContent = oldText;
      return;
    }
    const total = list.length;
    const statusCounts = {}; PROJECT_STATUSES.forEach(s => statusCounts[s] = 0);
    const priorityCounts = {}; TICKET_PRIORITIES.forEach(p => priorityCounts[p] = 0);
    let overdue = 0, progressSum = 0;
    list.forEach(p => {
      const st = p.status || "Lên kế hoạch";
      if (statusCounts[st] === undefined) statusCounts[st] = 0;
      statusCounts[st]++;
      const pr = p.priority || "Trung bình";
      if (priorityCounts[pr] === undefined) priorityCounts[pr] = 0;
      priorityCounts[pr]++;
      if (isProjectOverdue(p)) overdue++;
      progressSum += Math.max(0, Math.min(100, Number(p.progress) || 0));
    });
    const avgProgress = total ? Math.round(progressSum / total) : 0;
    const now = new Date();
    const dateLocale = { vi: "vi-VN", en: "en-US", zh: "zh-CN" }[getLang()] || "vi-VN";
    const dateStr = now.toLocaleDateString(dateLocale);
    const headerBar = `<div class="pdf-header"><img src="logo.png" class="pdf-header-logo"><span>${tr("ppdf.title")}</span><span class="pdf-header-sub">SEC — IT Project Report</span></div>`;
    const footerBar = pageNum => `<div class="pdf-footer"><span>${tr("pdf.exportedOn", { date: dateStr })}</span><span>${tr("pdf.page", { n: pageNum })}</span></div>`;

    /* ---- Trang bìa ---- */
    const cover = document.createElement("div");
    cover.className = "pdf-page pdf-cover";
    cover.innerHTML = `
      <div class="pdf-blob1"></div><div class="pdf-blob2"></div>
      <div class="pdf-logo-wrap"><img src="logo.png" alt="S.E.C."></div>
      <h1>${tr("ppdf.title")}</h1>
      <div class="pdf-sub">SEC — IT Project Report</div>
      <div class="pdf-meta">${tr("ppdf.coverMeta", { date: dateStr, total })}${statusFilter ? `<br>${tr("ppdf.filterStatusLabel")}: ${escapeHtml(projectStatusLabel(statusFilter))}` : ""}</div>`;
    root.appendChild(cover);

    /* ---- Trang tổng quan: thẻ số liệu + breakdown + bảng danh sách ---- */
    const statusBreakdown = PROJECT_STATUSES.map(s => {
      const c = ppdfStatusColors(s);
      return `<div class="pk-breakdown-item"><span class="pdf-badge" style="background:${c.bg};color:${c.fg}">${escapeHtml(projectStatusLabel(s))}</span><b>${statusCounts[s] || 0}</b></div>`;
    }).join("");
    const priorityBreakdown = TICKET_PRIORITIES.map(p => {
      const c = ppdfPriorityColors(p);
      return `<div class="pk-breakdown-item"><span class="pdf-badge" style="background:${c.bg};color:${c.fg}">${escapeHtml(ticketPriorityLabel(p))}</span><b>${priorityCounts[p] || 0}</b></div>`;
    }).join("");
    const listRows = list.map(p => {
      const sc = ppdfStatusColors(p.status || "Lên kế hoạch");
      const pc = ppdfPriorityColors(p.priority || "Trung bình");
      const pct = Math.max(0, Math.min(100, Number(p.progress) || 0));
      return `<tr>
        <td><b>${escapeHtml(p.projectCode)}</b></td>
        <td>${escapeHtml(p.name || "")}</td>
        <td><span class="pdf-badge" style="background:${pc.bg};color:${pc.fg}">${escapeHtml(ticketPriorityLabel(p.priority || "Trung bình"))}</span></td>
        <td><span class="pdf-badge" style="background:${sc.bg};color:${sc.fg}">${escapeHtml(projectStatusLabel(p.status))}</span></td>
        <td>${escapeHtml(p.owner || tr("tpdf.noValue"))}</td>
        <td>${pct}%</td>
        <td>${escapeHtml(p.endDate || tr("tpdf.noValue"))}${isProjectOverdue(p) ? ` ⚠` : ""}</td>
      </tr>`;
    }).join("");
    const overview = document.createElement("div");
    overview.className = "pdf-page";
    overview.innerHTML = `
      ${headerBar}
      <div class="pdf-content">
        <div class="pdf-h1">${tr("ppdf.section1Title")}</div>
        <hr class="pdf-hr">
        <div class="pdf-cards">
          <div class="pdf-card" style="--accent:${PDF_PALETTE.blue}"><b>${total}</b><span>${tr("ppdf.statTotal")}</span></div>
          <div class="pdf-card" style="--accent:${PDF_PALETTE.green}"><b>${avgProgress}%</b><span>${tr("ppdf.statAvgProgress")}</span></div>
          <div class="pdf-card" style="--accent:${PDF_PALETTE.red}"><b>${overdue}</b><span>${tr("ppdf.statOverdue")}</span></div>
        </div>
        <div class="pdf-h2">${tr("ppdf.byStatusTitle")}</div>
        <div class="pk-breakdown">${statusBreakdown}</div>
        <div class="pdf-h2">${tr("ppdf.byPriorityTitle")}</div>
        <div class="pk-breakdown">${priorityBreakdown}</div>
        <div class="pdf-h2">${tr("ppdf.listTitle")}</div>
        <table class="ppdf-list-table">
          <thead><tr>
            <th style="width:14%">${tr("ppdf.colProjectCode")}</th>
            <th style="width:22%">${tr("ppdf.colName")}</th>
            <th style="width:11%">${tr("ppdf.colPriority")}</th>
            <th style="width:14%">${tr("ppdf.colStatus")}</th>
            <th style="width:16%">${tr("ppdf.colOwner")}</th>
            <th style="width:9%">${tr("ppdf.colProgress")}</th>
            <th style="width:14%">${tr("ppdf.colEndDate")}</th>
          </tr></thead>
          <tbody>${listRows}</tbody>
        </table>
      </div>
      ${footerBar(1)}`;
    root.appendChild(overview);

    /* ---- 1 trang chi tiết cho mỗi dự án ---- */
    list.forEach((p, idx) => {
      const sc = ppdfStatusColors(p.status || "Lên kế hoạch");
      const pc = ppdfPriorityColors(p.priority || "Trung bình");
      const created = projectCreatedInfo(p);
      const pct = Math.max(0, Math.min(100, Number(p.progress) || 0));
      const progressRows = (p.progressLog && p.progressLog.length)
        ? p.progressLog.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).map(e => `<div class="pk-progress-item"><span class="pk-progress-time">${escapeHtml(formatHistoryTime(e.at))}${e.by ? " · " + escapeHtml(e.by) : ""}</span><span>${escapeHtml(e.note || "")}</span></div>`).join("")
        : "";
      const attachRows = (p.attachments && p.attachments.length)
        ? p.attachments.map(a => `<div class="pk-attach-item">🔗 ${escapeHtml(a.name || a.url)}<span>${escapeHtml(a.url || "")}</span></div>`).join("")
        : "";
      const page = document.createElement("div");
      page.className = "pdf-page";
      page.innerHTML = `
        ${headerBar}
        <div class="pdf-content">
          ${idx === 0 ? `<div class="pdf-h1">${tr("ppdf.section2Title")}</div><hr class="pdf-hr">` : ""}
          <div class="pk-topbar">
            <div>
              <div class="pk-id">${escapeHtml(p.projectCode)} — ${escapeHtml(p.name || "")}</div>
              ${created ? `<div class="pk-sub">${escapeHtml(created)}</div>` : ""}
            </div>
            <div class="pk-badges">
              <span class="pdf-badge" style="background:${pc.bg};color:${pc.fg}">${escapeHtml(ticketPriorityLabel(p.priority || "Trung bình"))}</span>
              <span class="pdf-badge" style="background:${sc.bg};color:${sc.fg}">${escapeHtml(projectStatusLabel(p.status))}</span>
            </div>
          </div>
          <div class="pdf-progress-wrap">
            <div class="tk-field"><b>${tr("ppdf.fieldProgress")}</b></div>
            <div class="pdf-progress-bar"><i style="width:${pct}%"></i></div>
          </div>
          <div class="pk-grid">
            <div class="pk-field"><b>${tr("ppdf.fieldOwner")}</b><span>${escapeHtml(p.owner || tr("tpdf.noValue"))}</span></div>
            <div class="pk-field"><b>${tr("ppdf.fieldDepartment")}</b><span>${escapeHtml(p.department || tr("tpdf.noValue"))}</span></div>
            <div class="pk-field"><b>${tr("ppdf.fieldStart")}</b><span>${escapeHtml(p.startDate || tr("tpdf.noValue"))}</span></div>
            <div class="pk-field"><b>${tr("ppdf.fieldEnd")}</b><span>${escapeHtml(p.endDate || tr("tpdf.noValue"))}${isProjectOverdue(p) ? " ⚠" : ""}</span></div>
          </div>
          ${p.description ? `<div class="pk-section-title">${tr("ppdf.sectionDescription")}</div><div class="pk-text">${escapeHtml(p.description)}</div>` : ""}
          ${p.note ? `<div class="pk-section-title">${tr("ppdf.sectionNote")}</div><div class="pk-text">${escapeHtml(p.note)}</div>` : ""}
          ${progressRows ? `<div class="pk-section-title">${tr("ppdf.sectionProgress")}</div>${progressRows}` : ""}
          ${attachRows ? `<div class="pk-section-title">${tr("ppdf.sectionAttachments")}</div>${attachRows}` : ""}
        </div>
        ${footerBar(2 + idx)}`;
      root.appendChild(page);
    });

    /* ---- Chụp từng trang & ghép vào PDF (giống báo cáo ticket) ---- */
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
    const statusSlug = { "Lên kế hoạch": "len-ke-hoach", "Đang thực hiện": "dang-thuc-hien", "Tạm dừng": "tam-dung", "Hoàn thành": "hoan-thanh", "Hủy": "huy" }[statusFilter] || "";
    pdf.save(`bao-cao-du-an${statusSlug ? "-" + statusSlug : ""}-${now.toISOString().slice(0, 10)}.pdf`);
  } catch (err) {
    console.error(err);
    alert(tr("msg.errProjectPdfReport", { err: err.message }));
  } finally {
    root.remove();
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

$("exportProjectPdfReport").addEventListener("click", generateProjectPdfReport);

/* ---------- Báo cáo Excel — Dự án CNTT (giống cơ chế export Ticket Excel) ----------
   Sheet 1 "Du an": 1 dòng / dự án, đủ cột tổng quan để lọc/sắp xếp trong Excel.
   Sheet 2 "Moc tien do": 1 dòng / mốc tiến độ (progressLog), có cột Mã dự án +
   Tên dự án để đối chiếu ngược lại sheet 1 — tránh nhồi nhiều mốc vào 1 ô như
   PDF (excel nên phẳng, dễ lọc/pivot hơn là văn bản dài trong 1 cell). */
const PROJECT_EXPORT_COLUMN_LABELS_VN = {
  projectCode: "Mã dự án", name: "Tên dự án", priority: "Ưu tiên", status: "Trạng thái",
  owner: "Phụ trách", department: "Phòng ban", startDate: "Ngày bắt đầu", endDate: "Hạn hoàn thành",
  progress: "Tiến độ (%)", overdue: "Trễ hạn", description: "Mô tả", note: "Ghi chú", createdInfo: "Ngày tạo"
};
const PROJECT_EXPORT_COLUMNS = ["projectCode", "name", "priority", "status", "owner", "department", "startDate", "endDate", "progress", "overdue", "description", "note", "createdInfo"];
const PROJECT_MILESTONE_COLUMN_LABELS_VN = { projectCode: "Mã dự án", name: "Tên dự án", time: "Thời gian", by: "Người cập nhật", note: "Nội dung mốc tiến độ" };
const PROJECT_MILESTONE_COLUMNS = ["projectCode", "name", "time", "by", "note"];

$("exportProjectXlsxReport").addEventListener("click", () => {
  if (!projectRecords.length) { alert(tr("msg.noProjectDataReport")); return; }
  const statusFilter = $("projectPdfStatusFilter") ? $("projectPdfStatusFilter").value : "";
  const list = projectRecords.slice()
    .filter(p => !statusFilter || (p.status || "Lên kế hoạch") === statusFilter)
    .sort((a, b) => (a.projectCode || "").localeCompare(b.projectCode || ""));
  if (!list.length) { alert(tr("msg.noProjectDataReport")); return; }

  /* ---- Sheet 1: Du an ---- */
  const rows = list.map(p => {
    const pct = Math.max(0, Math.min(100, Number(p.progress) || 0));
    const row = {};
    PROJECT_EXPORT_COLUMNS.forEach(c => {
      if (c === "priority") { row[PROJECT_EXPORT_COLUMN_LABELS_VN.priority] = ticketPriorityLabel(p.priority || "Trung bình"); return; }
      if (c === "status") { row[PROJECT_EXPORT_COLUMN_LABELS_VN.status] = projectStatusLabel(p.status); return; }
      if (c === "progress") { row[PROJECT_EXPORT_COLUMN_LABELS_VN.progress] = pct; return; }
      if (c === "overdue") { row[PROJECT_EXPORT_COLUMN_LABELS_VN.overdue] = isProjectOverdue(p) ? "Có" : ""; return; }
      if (c === "createdInfo") { row[PROJECT_EXPORT_COLUMN_LABELS_VN.createdInfo] = projectCreatedInfo(p); return; }
      row[PROJECT_EXPORT_COLUMN_LABELS_VN[c]] = p[c] || "";
    });
    return row;
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = PROJECT_EXPORT_COLUMNS.map(c =>
    c === "projectCode" ? { wch: 20 } :
    c === "name" || c === "description" || c === "note" ? { wch: 32 } :
    c === "createdInfo" ? { wch: 24 } : { wch: 16 });
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: PROJECT_EXPORT_COLUMNS.length - 1 } }) };

  /* ---- Sheet 2: Moc tien do (progressLog phẳng ra, mới nhất trước) ---- */
  const milestoneRows = [];
  list.forEach(p => {
    const log = Array.isArray(p.progressLog) ? p.progressLog.slice().sort((a, b) => (b.at || 0) - (a.at || 0)) : [];
    log.forEach(e => {
      const row = {};
      row[PROJECT_MILESTONE_COLUMN_LABELS_VN.projectCode] = p.projectCode || "";
      row[PROJECT_MILESTONE_COLUMN_LABELS_VN.name] = p.name || "";
      row[PROJECT_MILESTONE_COLUMN_LABELS_VN.time] = formatHistoryTime(e.at) || "";
      row[PROJECT_MILESTONE_COLUMN_LABELS_VN.by] = e.by || "";
      row[PROJECT_MILESTONE_COLUMN_LABELS_VN.note] = e.note || "";
      milestoneRows.push(row);
    });
  });
  const wsMilestones = XLSX.utils.json_to_sheet(milestoneRows.length ? milestoneRows : [{}]);
  wsMilestones["!cols"] = PROJECT_MILESTONE_COLUMNS.map(c =>
    c === "note" ? { wch: 60 } : c === "name" ? { wch: 32 } : c === "time" ? { wch: 20 } : { wch: 18 });
  if (milestoneRows.length) {
    wsMilestones["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: milestoneRows.length, c: PROJECT_MILESTONE_COLUMNS.length - 1 } }) };
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Du an");
  XLSX.utils.book_append_sheet(wb, wsMilestones, "Moc tien do");
  const ts = new Date().toISOString().slice(0, 10);
  const userTag = currentUserFileTag();
  const statusSlug = { "Lên kế hoạch": "len-ke-hoach", "Đang thực hiện": "dang-thuc-hien", "Tạm dừng": "tam-dung", "Hoàn thành": "hoan-thanh", "Hủy": "huy" }[statusFilter] || "";
  XLSX.writeFile(wb, `bao-cao-du-an${statusSlug ? "-" + statusSlug : ""}-${ts}${userTag ? ` (${userTag})` : ""}.xlsx`);
});

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
      // createdAt chỉ set khi đây thực sự là dòng MỚI (chưa từng có id này) —
      // import lại (merge) 1 file cũ không được phép ghi đè ngày tạo gốc.
      if (!existing) obj.createdAt = firebase.firestore.FieldValue.serverTimestamp();
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
    alert(tr("msg.importedAssets", { count: imported }));
  } catch (err) {
    alert(tr("msg.errImportExcel", { err: err.message }));
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

    alert(tr("msg.importedEmployees", { count: list.length }));
  } catch (err) {
    alert(tr("msg.errImportEmployees", { err: err.message }));
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

function TICKET_HISTORY_FIELDS_FN() { return [
  ["priority", tr("field.priority")],
  ["status", tr("field.ticketStatus")],
  ["employeeCode", tr("field.employeeCode")],
  ["requester", tr("field.requester")],
  ["department", tr("field.department")],
  ["assetCode", tr("field.linkedAsset").replace(" (không bắt buộc)", "").replace(" (optional)", "").replace("（可选）", "")],
  ["device", tr("field.device")],
  ["description", tr("field.description").replace("*", "")],
  ["cause", tr("field.cause")],
  ["resolution", tr("field.resolution")],
  ["note", tr("field.ticketNote")],
]; }
Object.defineProperty(window, "TICKET_HISTORY_FIELDS", { get: TICKET_HISTORY_FIELDS_FN });
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
      const from = c.from ? escapeHtml(c.from) : "<i>(" + tr("common.empty") + ")</i>";
      const to = c.to ? escapeHtml(c.to) : "<i>(" + tr("common.empty") + ")</i>";
      return `<div class="history-change"><b>${escapeHtml(c.label)}:</b> ${from} → ${to}</div>`;
    }).join("");
    return `<div class="history-entry">
      <div class="history-head">
        <span class="history-action">${escapeHtml(HISTORY_ACTION_LABEL[e.action] || e.action || "")}</span>
        <span class="muted">${formatHistoryTime(e.at)} · ${escapeHtml(e.by || "")}</span>
      </div>
      ${changesHtml || '<div class="history-change muted">' + tr("history.noChanges") + '</div>'}
    </div>`;
  }).join("");
}

/* ---------- Lịch sử xử lý (progress log) — mốc theo thời gian, ghi tay ----------
   Khác với TICKET_HISTORY_FIELDS ở trên (tự động ghi lại MỌI thay đổi field),
   đây là nhật ký người dùng tự thêm từng dòng theo thời gian (vd: "đang chờ
   linh kiện", "đã liên hệ NCC"...). Lưu nguyên mảng vào field `progressLog`
   của ticket (không dùng arrayUnion vì đã giữ mảng đầy đủ ở client, xoá
   được từng dòng trước khi lưu). */
let currentProgressLog = [];
function renderTicketProgressList() {
  const box = $("ticketProgressList");
  if (!box) return;
  if (!currentProgressLog.length) {
    box.innerHTML = `<div class="muted" style="padding:4px 0 10px">${tr("progress.none")}</div>`;
    return;
  }
  const order = currentProgressLog.map((e, i) => ({ e, i })).sort((a, b) => (b.e.at || 0) - (a.e.at || 0));
  box.innerHTML = order.map(({ e, i }) => `<div class="history-entry">
      <div class="history-head">
        <span class="muted">${formatHistoryTime(e.at)} · ${escapeHtml(e.by || "")}</span>
        <button type="button" class="secondary" style="padding:3px 8px;font-size:11px" onclick="removeTicketProgress(${i})">🗑</button>
      </div>
      <div class="history-change">${escapeHtml(e.note || "")}</div>
    </div>`).join("");
}
window.removeTicketProgress = function (idx) {
  currentProgressLog.splice(idx, 1);
  renderTicketProgressList();
};

/* ---------- Ticket liên quan (lỗi lặp lại) ----------
   Liên kết nhiều-nhiều giữa các ticket cùng 1 lỗi tái diễn. Lưu 2 mảng song
   song trên ticket: linkedTicketIds (docId, dùng để đếm/tra cứu) và
   linkedTicketCodes (snapshot ticketId để hiển thị nhanh không cần join).
   Khi lưu, best-effort ghi NGƯỢC lại sang từng ticket được liên kết (chỉ khi
   isAdmin — Firestore Rules không cho Collector update ticket có sẵn) để
   liên kết hiện ra ở cả 2 chiều. */
let currentLinkedTickets = []; // [{id, ticketId}]
function renderTicketLinkedChips() {
  const box = $("ticketLinkedChips");
  if (!box) return;
  box.innerHTML = currentLinkedTickets.map((t, i) =>
    `<span class="chip">🔁 ${escapeHtml(t.ticketId)}<button type="button" onclick="removeLinkedTicket(${i})">×</button></span>`
  ).join("");
}
window.removeLinkedTicket = function (idx) {
  currentLinkedTickets.splice(idx, 1);
  renderTicketLinkedChips();
};

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

let expandedTicketIds = new Set();
window.toggleTicketDetail = function (id) {
  if (expandedTicketIds.has(id)) expandedTicketIds.delete(id); else expandedTicketIds.add(id);
  renderTicketList();
};
function renderTicketList() {
  if (!$("ticketList")) return; // trang chưa có trong DOM (không nên xảy ra, phòng lỗi)
  const q = ($("ticketSearch").value || "").trim().toLowerCase();
  const statusF = $("filterTicketStatus").value;
  const prioF = $("filterTicketPriority").value;
  const sortF = $("filterTicketSort") ? $("filterTicketSort").value : "";

  let list = ticketRecords.slice().sort((a, b) => (b.ticketId || "").localeCompare(a.ticketId || ""));
  if (q) {
    list = list.filter(t =>
      [t.ticketId, t.requester, t.employeeCode, t.department, t.description, t.device, t.assetCode].some(v => (v || "").toLowerCase().includes(q))
    );
  }
  if (statusF) list = list.filter(t => (t.status || "Chờ") === statusF);
  if (prioF) list = list.filter(t => (t.priority || "Trung bình") === prioF);
  // Sắp xếp theo số ngày đã mở — ticket không xác định được ngày tạo (rất
  // hiếm, chỉ ticket import cũ thiếu cả history lẫn đúng định dạng Mã) bị
  // đẩy xuống cuối thay vì làm lệch thứ tự các ticket còn lại.
  if (sortF === "oldestFirst") {
    list.sort((a, b) => (ticketCreatedMs(b) ? 0 : 1) - (ticketCreatedMs(a) ? 0 : 1) || (ticketCreatedMs(a) || Infinity) - (ticketCreatedMs(b) || Infinity));
  } else if (sortF === "newestFirst") {
    list.sort((a, b) => (ticketCreatedMs(b) || 0) - (ticketCreatedMs(a) || 0));
  }

  if (!list.length) {
    $("ticketList").innerHTML = `<div class="empty">${tr("tickets.noneFound")}</div>`;
    return;
  }
  $("ticketList").innerHTML = list.map(t => {
    const editBtn = isAdmin
      ? `<button onclick="editTicket('${t._id}')">✎ ${tr("action.edit")}</button>`
      : `<button onclick="editTicket('${t._id}')">👁 ${tr("action.view")}</button>`;
    const deleteBtn = isAdmin
      ? `<button class="secondary" onclick="deleteTicket('${t._id}')">🗑 ${tr("action.delete")}</button>`
      : "";
    const hasExtra = t.cause || t.resolution || t.note;
    const expanded = expandedTicketIds.has(t._id);
    const detailBtn = hasExtra
      ? `<button class="ghost" onclick="toggleTicketDetail('${t._id}')">${expanded ? "▲ " + tr("action.collapse") : "👁 " + tr("action.details")}</button>`
      : "";
    const detailRow = (expanded && hasExtra) ? `
        <div class="scan-info">
          ${t.cause ? `<div class="scan-row"><span class="muted">${tr("field.cause")}:</span> ${escapeHtml(t.cause)}</div>` : ""}
          ${t.resolution ? `<div class="scan-row"><span class="muted">${tr("field.resolution")}:</span> ${escapeHtml(t.resolution)}</div>` : ""}
          ${t.note ? `<div class="scan-row"><span class="muted">${tr("field.ticketNote")}:</span> ${escapeHtml(t.note)}</div>` : ""}
        </div>` : "";
    return `
    <div class="asset">
      <div>
        <h3>${escapeHtml(t.ticketId)}</h3>
        <div class="muted">${t.requester ? "👤 " + escapeHtml(t.requester) : ""}${t.employeeCode ? " (" + escapeHtml(t.employeeCode) + ")" : ""}${t.department ? " · 🏢 " + escapeHtml(t.department) : ""}</div>
        ${t.device || t.assetCode ? `<div class="muted">💻 ${escapeHtml(t.device || "")}${t.assetCode ? " (" + escapeHtml(t.assetCode) + ")" : ""}</div>` : ""}
        <div class="muted">${escapeHtml(t.description || "")}</div>
        <span class="badge ${ticketBadgeClass(t.status)}">${escapeHtml(ticketStatusLabel(t.status))}</span>
        <span class="prio-badge prio-${prioritySlug(t.priority)}">${escapeHtml(ticketPriorityLabel(t.priority || "Trung bình"))}</span>
        ${ticketAgeBadge(t)}
        ${(t.linkedTicketIds && t.linkedTicketIds.length) ? t.linkedTicketIds.map((lid, i) => {
          const code = (t.linkedTicketCodes && t.linkedTicketCodes[i]) || lid;
          return `<span class="badge recur-badge" style="cursor:pointer" title="${tr("linked.view")}" onclick="event.stopPropagation();editTicket('${lid}')">🔁 ${escapeHtml(code)}</span>`;
        }).join("") : ""}
        ${(t.progressLog && t.progressLog.length) ? `<span class="badge info">🕒 ${tr("progress.count", { count: t.progressLog.length })}</span>` : ""}
        ${!isAdmin ? `<span class="badge view-only-tag">👁 ${tr("action.viewOnly")}</span>` : ""}
        ${detailRow}
      </div>
      <div class="asset-actions">
        ${detailBtn}
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
if ($("filterTicketSort")) $("filterTicketSort").addEventListener("change", renderTicketList);

/* ---------- Autocomplete: Mã nhân viên / Người yêu cầu / Phòng ban / Liên kết tài sản ---------- */
// Sau khi biết Mã nhân viên (chọn tay hoặc auto-fill do gõ trùng duy nhất 1
// người), dò trong danh sách tài sản (kiểm kê) xem nhân viên đó đang được
// gán tài sản nào (asset.employeeCode) để tự điền/gợi ý Liên kết tài sản:
// - Đang có sẵn 1 liên kết rồi (ticketAssetId đã điền) thì không đụng vào,
//   tránh ghi đè lựa chọn người dùng đã tự chọn trước đó.
// - Khớp đúng 1 tài sản: tự điền luôn ô Liên kết tài sản (và Thiết bị nếu
//   đang trống), giống hệt như khi tự bấm chọn tài sản đó.
// - Khớp nhiều tài sản (1 người có thể được gán nhiều máy): không tự đoán —
//   hiện sẵn danh sách các tài sản đó ngay trong ô Liên kết tài sản để bấm
//   chọn đúng cái đang cần, không phải gõ lại từ đầu.
function autoLinkAssetByEmployeeCode(code) {
  const c = (code || "").trim().toLowerCase();
  if (!c || $("ticketAssetId").value) return;
  const matched = assets.filter(a => (a.employeeCode || "").trim().toLowerCase() === c);
  if (!matched.length) return;
  const applyAsset = a => {
    $("ticketAsset").value = a.code;
    $("ticketAssetId").value = a._id;
    if (!$("ticketDevice").value.trim()) $("ticketDevice").value = [a.type, a.model].filter(Boolean).join(" - ");
  };
  if (matched.length === 1) { applyAsset(matched[0]); return; }
  const box = $("ticketAssetSuggest");
  box.innerHTML = matched.slice(0, 20).map((a, i) =>
    `<div class="suggest-item" data-idx="${i}">${escapeHtml(a.code)}<span class="muted">${escapeHtml(a.type || "")}${a.model ? " · " + escapeHtml(a.model) : ""}${a.user ? " · " + escapeHtml(a.user) : ""}</span></div>`
  ).join("");
  box.querySelectorAll(".suggest-item[data-idx]").forEach(el => {
    el.addEventListener("mousedown", ev => {
      ev.preventDefault();
      applyAsset(matched[Number(el.getAttribute("data-idx"))]);
      box.classList.add("hidden");
      box.innerHTML = "";
    });
  });
  box.classList.remove("hidden");
}
setupAutocomplete("ticketEmployeeCode", "ticketEmployeeCodeSuggest",
  q => filterEmployeesBy("code", q, 200),
  e => `${escapeHtml(e.code)}<span class="muted">${escapeHtml(e.name)}${e.section ? " · " + escapeHtml(e.section) : ""}${e.active ? "" : " · đã nghỉ việc"}</span>`,
  e => {
    $("ticketEmployeeCode").value = e.code;
    $("ticketRequester").value = e.name;
    $("ticketDepartment").value = e.section || "";
    autoLinkAssetByEmployeeCode(e.code);
  },
  { autoFillMinChars: 3 }
);
setupAutocomplete("ticketRequester", "ticketRequesterSuggest",
  q => filterEmployeesBy("name", q, 200),
  e => `${escapeHtml(e.name)}<span class="muted">${escapeHtml(e.code)}${e.section ? " · " + escapeHtml(e.section) : ""}${e.active ? "" : " · đã nghỉ việc"}</span>`,
  e => {
    $("ticketRequester").value = e.name;
    $("ticketEmployeeCode").value = e.code;
    $("ticketDepartment").value = e.section || "";
    autoLinkAssetByEmployeeCode(e.code);
  },
  { autoFillMinChars: 3 }
);
// Trường hợp gõ tay hẳn Mã nhân viên rồi rời khỏi ô (không qua gợi ý autocomplete
// ở trên, ví dụ dán nguyên mã từ nơi khác) — vẫn dò tài sản đang gán khi rời ô.
$("ticketEmployeeCode").addEventListener("blur", () => setTimeout(() => autoLinkAssetByEmployeeCode($("ticketEmployeeCode").value), 130));
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
  q => {
    const query = q.trim().toLowerCase();
    let list = assets;
    if (query) {
      list = assets.filter(a => [a.code, a.user, a.employeeCode, a.type, a.model, a.serial, a.section]
        .some(v => (v || "").toLowerCase().includes(query)));
    }
    return list.slice(0, 20);
  },
  a => `${escapeHtml(a.code)}<span class="muted">${escapeHtml(a.type || "")}${a.model ? " · " + escapeHtml(a.model) : ""}${a.user ? " · " + escapeHtml(a.user) : ""}</span>`,
  a => {
    $("ticketAsset").value = a.code;
    $("ticketAssetId").value = a._id;
    if (!$("ticketDevice").value.trim()) $("ticketDevice").value = [a.type, a.model].filter(Boolean).join(" - ");
    if (!$("ticketDepartment").value.trim()) $("ticketDepartment").value = a.section || "";
    if (!$("ticketEmployeeCode").value.trim()) $("ticketEmployeeCode").value = a.employeeCode || "";
  }
);
$("ticketAsset").addEventListener("input", () => { $("ticketAssetId").value = ""; });

// Liên kết ticket khác (lỗi lặp lại) — tìm theo Mã ticket/Mô tả/Thiết bị,
// loại trừ chính ticket đang sửa và các ticket đã chọn liên kết rồi.
setupAutocomplete("ticketLinked", "ticketLinkedSuggest",
  q => {
    const query = q.trim().toLowerCase();
    const excludeId = $("ticketDocId").value;
    let list = ticketRecords.filter(t => t._id !== excludeId && !currentLinkedTickets.some(l => l.id === t._id));
    if (query) list = list.filter(t => [t.ticketId, t.description, t.device].some(v => (v || "").toLowerCase().includes(query)));
    return list.slice(0, 20);
  },
  t => `${escapeHtml(t.ticketId)}<span class="muted">${escapeHtml((t.description || "").slice(0, 60))}${t.status ? " · " + escapeHtml(ticketStatusLabel(t.status)) : ""}</span>`,
  t => {
    currentLinkedTickets.push({ id: t._id, ticketId: t.ticketId });
    $("ticketLinked").value = "";
    renderTicketLinkedChips();
  }
);

$("addTicketProgressBtn").addEventListener("click", () => {
  const note = $("ticketProgressNote").value.trim();
  if (!note) { alert(tr("msg.needProgressNote")); return; }
  currentProgressLog.push({ at: Date.now(), by: currentEmail || "?", note });
  $("ticketProgressNote").value = "";
  renderTicketProgressList();
});

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
  $("ticketEmployeeCodeSuggest").classList.add("hidden");
  $("ticketEmployeeCodeSuggest").innerHTML = "";
  $("ticketDepartmentSuggest").classList.add("hidden");
  $("ticketDepartmentSuggest").innerHTML = "";
  $("ticketAssetSuggest").classList.add("hidden");
  $("ticketAssetSuggest").innerHTML = "";
  $("ticketLinkedSuggest").classList.add("hidden");
  $("ticketLinkedSuggest").innerHTML = "";
  currentProgressLog = [];
  $("ticketProgressNote").value = "";
  renderTicketProgressList();
  currentLinkedTickets = [];
  renderTicketLinkedChips();
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
  $("ticketEmployeeCode").value = t.employeeCode || "";
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
  currentProgressLog = Array.isArray(t.progressLog) ? t.progressLog.slice() : [];
  renderTicketProgressList();
  currentLinkedTickets = Array.isArray(t.linkedTicketIds)
    ? t.linkedTicketIds.map((id, i) => ({ id, ticketId: (t.linkedTicketCodes && t.linkedTicketCodes[i]) || id }))
    : [];
  renderTicketLinkedChips();
  $("ticketFormTitle").textContent = tr("ticketForm.editTitle", { id: t.ticketId || "" });
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
  if (!confirm(tr("msg.confirmDeleteTicket", { id: t.ticketId }))) return;
  db.collection(TICKET_COLLECTION).doc(id).delete().catch(err => alert(tr("msg.errDelete", { err: err.message })));
};

$("ticketFormEl").addEventListener("submit", e => {
  e.preventDefault();
  const ticketId = $("ticketId").value.trim();
  if (!ticketId) { alert(tr("msg.needTicketId")); return; }
  if (!$("ticketDescription").value.trim()) { alert(tr("msg.needTicketDesc")); return; }
  const newId = sanitizeId(ticketId);
  if (!newId) { alert(tr("msg.invalidTicketId")); return; }
  const oldId = $("ticketDocId").value;
  const oldTicket = oldId ? ticketRecords.find(t => t._id === oldId) : null;

  if (!isAdmin && oldId) {
    alert(tr("msg.noPermEditTicket"));
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
    employeeCode: $("ticketEmployeeCode").value.trim(),
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
    progressLog: currentProgressLog,
    linkedTicketIds: currentLinkedTickets.map(x => x.id),
    linkedTicketCodes: currentLinkedTickets.map(x => x.ticketId),
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
      fieldChanges.unshift({ field: "ticketId", label: tr("field.ticketId").replace("*", ""), from: oldTicket ? oldTicket.ticketId : oldId, to: ticketId });
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
  submitBtn.textContent = tr("common.saving");

  // Không await — giống hệt logic lưu tài sản, để UI phản hồi ngay cả khi
  // offline (xem giải thích chi tiết ở khối lưu tài sản phía trên).
  const writeOp = db.collection(TICKET_COLLECTION).doc(newId).set(data, { merge: true })
    .then(() => (oldId && oldId !== newId) ? db.collection(TICKET_COLLECTION).doc(oldId).delete() : null)
    .then(() => {
      // Ghi liên kết ngược sang từng ticket được chọn, để liên kết hiện ra ở
      // cả 2 chiều. Chỉ thử khi isAdmin vì Firestore Rules không cho tài
      // khoản Collector update ticket đã có sẵn — bỏ qua lặng lẽ nếu lỗi
      // (không chặn việc lưu ticket chính).
      if (!isAdmin || !currentLinkedTickets.length) return null;
      return Promise.all(currentLinkedTickets.map(lt =>
        db.collection(TICKET_COLLECTION).doc(lt.id).set({
          linkedTicketIds: firebase.firestore.FieldValue.arrayUnion(newId),
          linkedTicketCodes: firebase.firestore.FieldValue.arrayUnion(ticketId)
        }, { merge: true }).catch(() => {})
      ));
    })
    .catch(err => {
      alert(tr("msg.errSyncServer", { err: err.message }) + "\n\n" + tr("msg.errSyncServerHint"));
    });

  setTimeout(() => {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
    $("ticketDocId").value = newId;
    $("ticketFormTitle").textContent = tr("ticketForm.editTitle", { id: ticketId });
    goPage("tickets");
  }, 150);

  const stuckTimer = setTimeout(() => {
    console.warn("Firestore write for ticket", newId, "has not resolved after 20s — check network/rules.");
  }, 20000);
  writeOp.finally(() => clearTimeout(stuckTimer));
});

/* ---------- Camera / photo (ticket) ---------- */
$("ticketTakePhoto").addEventListener("click", () => $("ticketPhotoCamera").click());
async function handleTicketPhotoFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const dataUrl = await resizeImage(file);
    currentTicketPhotoData = dataUrl;
    $("ticketPhotoPreview").src = dataUrl;
    $("ticketPhotoPreview").classList.remove("hidden");
  } catch (err) {
    alert(tr("msg.errReadImage", { err: err.message }));
  }
  e.target.value = "";
}
$("ticketPhoto").addEventListener("change", handleTicketPhotoFileChange);
$("ticketPhotoCamera").addEventListener("change", handleTicketPhotoFileChange);

/* ---------- Excel export/import (Ticket) ----------
   Cột khớp với cấu trúc file Helpdesk_IT.xlsx (sheet "Tickets") để import
   trực tiếp file cũ nếu cần: Ticket ID, Ưu tiên, Trạng thái, Người yêu cầu,
   Phòng ban, Thiết bị, Mô tả, Nguyên nhân, Cách xử lý, Ghi chú. Cột "Mã
   nhân viên" và "Mã tài sản liên kết" là 2 cột riêng của app này (không có
   trong file Helpdesk gốc) — nếu file import không có 2 cột này, ticket
   vẫn được tạo bình thường, chỉ là thiếu Mã nhân viên/chưa liên kết tài
   sản (có thể vào sửa từng ticket để bổ sung/liên kết thủ công sau).
*/
const TICKET_COLUMNS = ["ticketId", "priority", "status", "employeeCode", "requester", "department", "assetCode", "device", "description", "cause", "resolution", "note"];
const TICKET_COLUMN_LABELS_VN = {
  ticketId: "Ticket ID", priority: "Ưu tiên", status: "Trạng thái", employeeCode: "Mã nhân viên", requester: "Người yêu cầu",
  department: "Phòng ban", assetCode: "Mã tài sản liên kết", device: "Thiết bị", description: "Mô tả",
  cause: "Nguyên nhân", resolution: "Cách xử lý", note: "Ghi chú"
};
const TICKET_HEADER_MAP = {};
TICKET_COLUMNS.forEach(c => {
  TICKET_HEADER_MAP[c.toLowerCase()] = c;
  TICKET_HEADER_MAP[TICKET_COLUMN_LABELS_VN[c].toLowerCase()] = c;
});
TICKET_HEADER_MAP["mã tài sản"] = "assetCode"; // alias ngắn gọn hơn khi tự soạn Excel

// File Excel Helpdesk cũ thường không gõ Ưu tiên/Trạng thái đồng nhất 100%
// (khác hoa/thường, "xử lí" thay vì "xử lý"...). So khớp không phân biệt
// hoa/thường + vài biến thể hay gặp thay vì so khớp tuyệt đối như cột khác,
// để tránh âm thầm rơi về giá trị mặc định và mất thông tin thật của dòng đó.
const TICKET_PRIORITY_ALIASES = { "thấp": "Thấp", "trung bình": "Trung bình", "cao": "Cao", "khẩn": "Khẩn" };
const TICKET_STATUS_ALIASES = { "chờ": "Chờ", "đang xử lý": "Đang xử lý", "đang xử lí": "Đang xử lý", "hoàn thành": "Hoàn thành" };
function normalizeTicketEnum(value, aliasMap, fallback) {
  const key = (value || "").trim().toLowerCase();
  return aliasMap[key] || fallback;
}

// Xuất Excel: KHÔNG tô vàng dòng "Đang xử lý" nữa (bỏ theo yêu cầu). Bật
// sẵn AutoFilter cho toàn bộ bảng + chỉnh độ rộng cột hợp lý hơn để dễ đọc.
// Thêm cột "Ngày tạo ticket" (suy ra qua ticketCreatedMs — xem định nghĩa
// phía trên, áp dụng cả cho ticket import Excel cũ) để lọc/sắp xếp theo
// ngày ngay trong Excel — ghi dưới dạng ô Date thật (không phải chuỗi chữ),
// định dạng dd.mm.yyyy. Set trực tiếp {t:"d", v, z} cho từng ô sau khi
// json_to_sheet dựng bảng, vì json_to_sheet tự quy đổi Date sang định dạng
// mặc định theo locale (kiểu m/d/yyyy) chứ không giữ định dạng mình muốn.
// Vẫn dùng xlsx-js-style (thay cho xlsx bản community) vì bản community
// không ghi được style/định dạng số ra .xlsx.
const TICKET_EXPORT_COLUMNS = ["ticketId", "createdDate", "priority", "status", "employeeCode", "requester", "department", "assetCode", "device", "description", "cause", "resolution", "note"];
const TICKET_EXPORT_COLUMN_LABELS_VN = Object.assign({ createdDate: "Ngày tạo ticket" }, TICKET_COLUMN_LABELS_VN);
const TICKET_CREATED_DATE_NUMFMT = "dd.mm.yyyy";

// Lấy tên đăng nhập ngắn gọn (phần trước @ trong email) để gắn vào tên file
// báo cáo xuất ra — giúp biết ai là người xuất file khi có nhiều người dùng
// chung app. Bỏ ký tự không hợp lệ trong tên file (/ \ : * ? " < > |).
function currentUserFileTag() {
  const local = (currentEmail || "").split("@")[0];
  const safe = local.replace(/[\\/:*?"<>|]/g, "").trim();
  return safe || "";
}

$("exportTicketsXlsx").addEventListener("click", () => {
  if (!ticketRecords.length) { alert(tr("msg.noTicketDataExport")); return; }
  const sorted = ticketRecords.slice().sort((a, b) => (a.ticketId || "").localeCompare(b.ticketId || ""));
  const createdDates = sorted.map(t => {
    const ms = ticketCreatedMs(t);
    return ms ? new Date(ms) : null;
  });
  const rows = sorted.map((t, i) => {
    const row = {};
    TICKET_EXPORT_COLUMNS.forEach(c => {
      if (c === "createdDate") { row[TICKET_EXPORT_COLUMN_LABELS_VN.createdDate] = createdDates[i] || ""; return; }
      row[TICKET_EXPORT_COLUMN_LABELS_VN[c]] = t[c] || "";
    });
    return row;
  });
  const ws = XLSX.utils.json_to_sheet(rows);

  // Ép lại từng ô ngày về đúng {t:"d", v: Date, z: "dd.mm.yyyy"}.
  const dateColIdx = TICKET_EXPORT_COLUMNS.indexOf("createdDate");
  const dateCellStyle = { alignment: { vertical: "center", horizontal: "center" } };
  createdDates.forEach((d, i) => {
    if (!d) return;
    const dateAddr = XLSX.utils.encode_cell({ r: i + 1, c: dateColIdx }); // hàng 0 là header
    ws[dateAddr] = { t: "d", v: d, z: TICKET_CREATED_DATE_NUMFMT, s: dateCellStyle };
  });

  // Merge các ô liền kề cùng ngày ở cột "Ngày tạo ticket" (danh sách đã
  // sort theo Ticket ID nên các ticket cùng ngày luôn nằm sát nhau) — chỉ
  // ô đầu tiên của mỗi nhóm giữ giá trị, các ô còn lại xóa trắng và merge
  // vào ô đầu để nhìn gọn hơn khi nhiều ticket cùng ngày.
  const merges = [];
  let runStart = 0;
  for (let i = 1; i <= createdDates.length; i++) {
    const sameDay = i < createdDates.length && createdDates[i] && createdDates[runStart] &&
      createdDates[i].toDateString() === createdDates[runStart].toDateString();
    if (!sameDay) {
      if (i - runStart > 1) {
        merges.push({ s: { r: runStart + 1, c: dateColIdx }, e: { r: i - 1 + 1, c: dateColIdx } });
        for (let k = runStart + 1; k < i; k++) {
          const addr = XLSX.utils.encode_cell({ r: k + 1, c: dateColIdx });
          if (ws[addr]) ws[addr].v = "";
        }
      }
      runStart = i;
    }
  }
  ws["!merges"] = merges;

  ws["!cols"] = TICKET_EXPORT_COLUMNS.map(c => (c === "ticketId" ? { wch: 22 } : c === "createdDate" ? { wch: 14 } : { wch: 18 }));
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: TICKET_EXPORT_COLUMNS.length - 1 } }) };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Tickets");
  const ts = new Date().toISOString().slice(0, 10);
  const userTag = currentUserFileTag();
  XLSX.writeFile(wb, `it-helpdesk-tickets-${ts}${userTag ? ` (${userTag})` : ""}.xlsx`);
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
    let dupCount = 0;
    const chunks = [];
    let batch = db.batch();
    let count = 0;
    // Theo dõi các ID đã dùng TRONG LẦN IMPORT NÀY — nếu 2 dòng trong cùng
    // file trùng Mã ticket (thường do đánh số nhầm ở file cũ) mà nội dung
    // là 2 việc khác nhau, tự thêm hậu tố "-2", "-3"... để không đè mất dữ
    // liệu của dòng import sau lên dòng import trước trong cùng lần này.
    // Ticket ID trùng với 1 ticket ĐÃ CÓ SẴN từ trước (không phải trong file
    // đang import) vẫn coi là cập nhật/merge như cũ — đúng ý định re-import.
    const usedIdsThisImport = new Set();
    for (const row of rows) {
      const obj = {};
      Object.keys(row).forEach(k => {
        const mapped = TICKET_HEADER_MAP[k.trim().toLowerCase()];
        if (mapped) obj[mapped] = String(row[k]).trim();
      });
      if (!obj.ticketId) continue;
      let id = sanitizeId(obj.ticketId);
      if (!id) continue;
      if (usedIdsThisImport.has(id)) {
        let n = 2;
        while (usedIdsThisImport.has(`${id}-${n}`)) n++;
        id = `${id}-${n}`;
        obj.ticketId = id; // giữ field ticketId khớp với doc ID mới
        dupCount++;
      }
      usedIdsThisImport.add(id);
      obj.priority = normalizeTicketEnum(obj.priority, TICKET_PRIORITY_ALIASES, "Trung bình");
      obj.status = normalizeTicketEnum(obj.status, TICKET_STATUS_ALIASES, "Chờ");
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
    alert(tr("msg.importedTickets", { count: imported }) +
      (dupCount ? "\n\n" + tr("msg.dupTicketNote", { count: dupCount }) : ""));
  } catch (err) {
    alert(tr("msg.errImportExcel", { err: err.message }));
  }
  e.target.value = "";
});

/* ==========================================================================
   DỰ ÁN CNTT (projects) — theo dõi tiến độ dự án IT, tương tự Ticket nhưng
   có thêm file đính kèm (Excel/PDF/Word/ảnh...) lưu trên Firebase Storage.
   Mô hình quyền giống hệt Ticket: Collector (và Admin) tạo mới được, chỉ
   Admin sửa/xóa được dự án đã có. Viewer chỉ xem.
   ========================================================================== */
const PROJECT_STATUSES = ["Lên kế hoạch", "Đang thực hiện", "Tạm dừng", "Hoàn thành", "Hủy"];
const PROJECT_STATUS_LABEL_KEY = {
  "Lên kế hoạch": "project.status.planning", "Đang thực hiện": "project.status.inProgress",
  "Tạm dừng": "project.status.onHold", "Hoàn thành": "project.status.done", "Hủy": "project.status.cancelled"
};
function projectStatusLabel(status) { return PROJECT_STATUS_LABEL_KEY[status] ? tr(PROJECT_STATUS_LABEL_KEY[status]) : (status || tr("project.status.planning")); }
function populateProjectSelects() {
  $("projectPriority").innerHTML = TICKET_PRIORITIES.map(p => `<option>${p}</option>`).join("");
  $("projectStatus").innerHTML = PROJECT_STATUSES.map(s => `<option>${s}</option>`).join("");
}
populateProjectSelects();

function PROJECT_HISTORY_FIELDS_FN() { return [
  ["name", tr("field.projectName").replace("*", "")],
  ["status", tr("field.projectStatus")],
  ["priority", tr("field.priority")],
  ["owner", tr("field.projectOwner")],
  ["department", tr("field.department")],
  ["startDate", tr("field.projectStart")],
  ["endDate", tr("field.projectEnd")],
  ["progress", tr("field.projectProgress")],
  ["description", tr("field.description")],
  ["note", tr("field.ticketNote")],
]; }
Object.defineProperty(window, "PROJECT_HISTORY_FIELDS", { get: PROJECT_HISTORY_FIELDS_FN });
function diffProjectFields(oldP, newData) {
  const changes = [];
  PROJECT_HISTORY_FIELDS.forEach(([key, label]) => {
    const ov = ((oldP && oldP[key]) || "").toString().trim();
    const nv = ((newData && newData[key]) || "").toString().trim();
    if (ov !== nv) changes.push({ field: key, label, from: ov, to: nv });
  });
  return changes;
}
function renderProjectHistoryBox(p) {
  const box = $("projectHistoryBox");
  const list = $("projectHistoryList");
  if (!box || !list) return;
  const entries = Array.isArray(p && p.history) ? p.history.slice().sort((x, y) => (y.at || 0) - (x.at || 0)) : [];
  if (!entries.length) { box.classList.add("hidden"); list.innerHTML = ""; return; }
  box.classList.remove("hidden");
  list.innerHTML = entries.map(e => {
    const changesHtml = (e.changes || []).map(c => {
      const from = c.from ? escapeHtml(c.from) : "<i>(" + tr("common.empty") + ")</i>";
      const to = c.to ? escapeHtml(c.to) : "<i>(" + tr("common.empty") + ")</i>";
      return `<div class="history-change"><b>${escapeHtml(c.label)}:</b> ${from} → ${to}</div>`;
    }).join("");
    return `<div class="history-entry">
      <div class="history-head">
        <span class="history-action">${escapeHtml(HISTORY_ACTION_LABEL[e.action] || e.action || "")}</span>
        <span class="muted">${formatHistoryTime(e.at)} · ${escapeHtml(e.by || "")}</span>
      </div>
      ${changesHtml || '<div class="history-change muted">' + tr("history.noChanges") + '</div>'}
    </div>`;
  }).join("");
}

/* ---------- Mốc tiến độ dự án (progress log) — giống hệt cơ chế của Ticket ---------- */
let currentProjectProgressLog = [];
function renderProjectProgressList() {
  const box = $("projectProgressList");
  if (!box) return;
  if (!currentProjectProgressLog.length) {
    box.innerHTML = `<div class="muted" style="padding:4px 0 10px">${tr("progress.none")}</div>`;
    return;
  }
  const order = currentProjectProgressLog.map((e, i) => ({ e, i })).sort((a, b) => (b.e.at || 0) - (a.e.at || 0));
  box.innerHTML = order.map(({ e, i }) => `<div class="history-entry">
      <div class="history-head">
        <span class="muted">${formatHistoryTime(e.at)} · ${escapeHtml(e.by || "")}</span>
        <button type="button" class="secondary" style="padding:3px 8px;font-size:11px" onclick="removeProjectProgress(${i})">🗑</button>
      </div>
      <div class="history-change">${escapeHtml(e.note || "")}</div>
    </div>`).join("");
}
window.removeProjectProgress = function (idx) {
  currentProjectProgressLog.splice(idx, 1);
  renderProjectProgressList();
};
$("addProjectProgressBtn").addEventListener("click", () => {
  const note = $("projectProgressNote").value.trim();
  if (!note) { alert(tr("msg.needProgressNote")); return; }
  currentProjectProgressLog.push({ at: Date.now(), by: currentEmail || "?", note });
  $("projectProgressNote").value = "";
  renderProjectProgressList();
});

/* ---------- Liên kết tài liệu (thay cho file upload — KHÔNG dùng Firebase
   Storage vì cần gói Blaze trả phí). Chỉ lưu {name, url} do người dùng tự
   dán link (Google Drive/OneDrive/Zalo/SharePoint nội bộ...), không upload
   file thật lên đâu cả. ---------- */
let currentProjectAttachments = []; // [{name, url, addedAt, addedBy}]
function renderProjectAttachList() {
  const box = $("projectAttachList");
  if (!box) return;
  if (!currentProjectAttachments.length) { box.innerHTML = ""; return; }
  box.innerHTML = currentProjectAttachments.map((a, i) => `
    <div class="attach-item">
      <div><a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">🔗 ${escapeHtml(a.name)}</a>
        <div class="attach-meta">${a.addedAt ? formatHistoryTime(a.addedAt) : ""}</div>
      </div>
      <button type="button" class="secondary creator-only" onclick="removeProjectAttachment(${i})">🗑</button>
    </div>`).join("");
}
window.removeProjectAttachment = function (idx) {
  currentProjectAttachments.splice(idx, 1);
  renderProjectAttachList();
};
$("addProjectAttachBtn").addEventListener("click", () => {
  const name = $("projectAttachName").value.trim();
  const url = $("projectAttachUrl").value.trim();
  if (!name || !url) { alert(tr("attachments.needNameUrl")); return; }
  if (!/^https?:\/\//i.test(url)) { alert(tr("attachments.invalidUrl")); return; }
  currentProjectAttachments.push({ name, url, addedAt: Date.now(), addedBy: currentEmail || "?" });
  $("projectAttachName").value = "";
  $("projectAttachUrl").value = "";
  renderProjectAttachList();
});

/* ---------- Dashboard/list helpers (Dự án) ---------- */
function projectBadgeClass(status) {
  if (status === "Hoàn thành") return "ok";
  if (status === "Hủy") return "bad";
  if (status === "Đang thực hiện") return "info";
  if (status === "Tạm dừng") return "warn";
  return "warn"; // Lên kế hoạch
}
function isProjectOverdue(p) {
  if (!p.endDate || p.status === "Hoàn thành" || p.status === "Hủy") return false;
  return p.endDate < new Date().toISOString().slice(0, 10);
}
function renderProjectStats() {
  const total = projectRecords.length;
  let active = 0, done = 0, overdue = 0;
  projectRecords.forEach(p => {
    if (p.status === "Đang thực hiện") active++;
    if (p.status === "Hoàn thành") done++;
    if (isProjectOverdue(p)) overdue++;
  });
  [["projectTotalCount", total], ["projectActiveCount", active], ["projectDoneCount", done], ["projectOverdueCount", overdue],
   ["opsProjectTotalCount", total], ["opsProjectActiveCount", active], ["opsProjectDoneCount", done], ["opsProjectOverdueCount", overdue]]
    .forEach(([id, val]) => { if ($(id)) $(id).textContent = val; });
}
function renderProjectList() {
  if (!$("projectList")) return;
  renderProjectStats();
  const q = ($("projectSearch").value || "").trim().toLowerCase();
  const statusF = $("filterProjectStatus").value;
  const prioF = $("filterProjectPriority").value;

  let list = projectRecords.slice().sort((a, b) => (b.projectCode || "").localeCompare(a.projectCode || ""));
  if (q) {
    list = list.filter(p =>
      [p.projectCode, p.name, p.owner, p.department, p.description].some(v => (v || "").toLowerCase().includes(q))
    );
  }
  if (statusF) list = list.filter(p => (p.status || "Lên kế hoạch") === statusF);
  if (prioF) list = list.filter(p => (p.priority || "Trung bình") === prioF);

  if (!list.length) {
    $("projectList").innerHTML = `<div class="empty">${tr("projects.noneFound")}</div>`;
    return;
  }
  $("projectList").innerHTML = list.map(p => {
    const editBtn = isAdmin
      ? `<button onclick="editProject('${p._id}')">✎ ${tr("action.edit")}</button>`
      : `<button onclick="editProject('${p._id}')">👁 ${tr("action.view")}</button>`;
    const deleteBtn = isAdmin
      ? `<button class="secondary" onclick="deleteProject('${p._id}')">🗑 ${tr("action.delete")}</button>`
      : "";
    const overdue = isProjectOverdue(p);
    const pct = Math.max(0, Math.min(100, Number(p.progress) || 0));
    return `
    <div class="asset">
      <div>
        <h3>${escapeHtml(p.projectCode)} — ${escapeHtml(p.name || "")}</h3>
        <div class="muted">${p.owner ? "👤 " + escapeHtml(p.owner) : ""}${p.department ? " · 🏢 " + escapeHtml(p.department) : ""}</div>
        ${(p.startDate || p.endDate) ? `<div class="muted">🗓 ${escapeHtml(p.startDate || "?")} → ${escapeHtml(p.endDate || "?")}</div>` : ""}
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="muted">${escapeHtml(p.description || "")}</div>
        <span class="badge ${projectBadgeClass(p.status)}">${escapeHtml(projectStatusLabel(p.status))}</span>
        <span class="prio-badge prio-${prioritySlug(p.priority)}">${escapeHtml(ticketPriorityLabel(p.priority || "Trung bình"))}</span>
        ${overdue ? `<span class="badge bad">⚠ ${tr("projects.overdue")}</span>` : ""}
        ${(p.attachments && p.attachments.length) ? `<span class="badge info">📎 ${tr("attachments.count", { count: p.attachments.length })}</span>` : ""}
        ${(p.progressLog && p.progressLog.length) ? `<span class="badge info">🕒 ${tr("progress.count", { count: p.progressLog.length })}</span>` : ""}
        ${!isAdmin ? `<span class="badge view-only-tag">👁 ${tr("action.viewOnly")}</span>` : ""}
      </div>
      <div class="asset-actions">
        ${editBtn}
        ${deleteBtn}
      </div>
    </div>
  `;
  }).join("");
}
$("projectSearch").addEventListener("input", renderProjectList);
$("filterProjectStatus").addEventListener("change", renderProjectList);
$("filterProjectPriority").addEventListener("change", renderProjectList);

/* ---------- Autocomplete: Phụ trách / Phòng ban (Dự án) ---------- */
setupAutocomplete("projectOwner", "projectOwnerSuggest",
  q => filterEmployeesBy("name", q, 200),
  e => `${escapeHtml(e.name)}<span class="muted">${escapeHtml(e.code)}${e.section ? " · " + escapeHtml(e.section) : ""}</span>`,
  e => {
    $("projectOwner").value = e.name;
    if (!$("projectDepartment").value.trim()) $("projectDepartment").value = e.section || "";
  },
  { autoFillMinChars: 3 }
);
setupAutocomplete("projectDepartment", "projectDepartmentSuggest",
  q => filterList(Array.from(new Set((window.EMPLOYEES || []).map(e => e.section).filter(Boolean))), q, 100).map(v => ({ value: v })),
  it => escapeHtml(it.value),
  it => { $("projectDepartment").value = it.value; }
);

/* ---------- Mã dự án: tự gợi ý dạng DA-YYYYMMDD-NNN ---------- */
let projectIdAutoFilled = true;
function suggestedProjectSeq(dateStr) {
  const prefix = `DA-${dateStr}-`;
  const n = projectRecords.filter(p => (p.projectCode || "").startsWith(prefix)).length + 1;
  return String(n).padStart(3, "0");
}
function maybeSuggestProjectId() {
  if (!projectIdAutoFilled) return;
  if ($("projectDocId").value) return;
  const dateStr = todayCompact();
  $("projectCode").value = `DA-${dateStr}-${suggestedProjectSeq(dateStr)}`;
}
$("projectCode").addEventListener("input", () => { projectIdAutoFilled = false; });

/* ---------- Form khóa/mở khóa (giống ticket/asset) ---------- */
function setProjectFormLocked(locked) {
  $("projectFormEl").querySelectorAll("input, select, textarea, button").forEach(el => {
    el.disabled = locked;
  });
  $("projectLockedNotice").classList.toggle("hidden", !locked);
}

function clearProjectForm() {
  $("projectFormEl").reset();
  $("projectDocId").value = "";
  $("projectFormTitle").textContent = tr("projectForm.createTitle");
  $("projectOwnerSuggest").classList.add("hidden");
  $("projectOwnerSuggest").innerHTML = "";
  $("projectDepartmentSuggest").classList.add("hidden");
  $("projectDepartmentSuggest").innerHTML = "";
  currentProjectProgressLog = [];
  $("projectProgressNote").value = "";
  renderProjectProgressList();
  currentProjectAttachments = [];
  renderProjectAttachList();
  $("projectLocked").checked = false;
  $("projectCode").readOnly = false;
  $("projectProgress").value = 0;
  setProjectFormLocked(false);
  projectIdAutoFilled = true;
  maybeSuggestProjectId();
  if ($("projectHistoryBox")) { $("projectHistoryBox").classList.add("hidden"); $("projectHistoryList").innerHTML = ""; }
}
$("resetProjectForm").addEventListener("click", clearProjectForm);
["projectsAddBtn", "quickAddProjectBtn"].forEach(id => {
  const btn = $(id);
  if (btn) btn.addEventListener("click", clearProjectForm);
});

function fillFormFromProject(p) {
  projectIdAutoFilled = false;
  $("projectDocId").value = p._id || "";
  $("projectCode").value = p.projectCode || "";
  $("projectName").value = p.name || "";
  $("projectStatus").value = p.status || "Lên kế hoạch";
  $("projectPriority").value = p.priority || "Trung bình";
  $("projectOwner").value = p.owner || "";
  $("projectDepartment").value = p.department || "";
  $("projectStart").value = p.startDate || "";
  $("projectEnd").value = p.endDate || "";
  $("projectProgress").value = (p.progress != null) ? p.progress : 0;
  $("projectDescription").value = p.description || "";
  $("projectNote").value = p.note || "";
  currentProjectAttachments = Array.isArray(p.attachments) ? p.attachments.slice() : [];
  renderProjectAttachList();
  $("projectLocked").checked = !!p.locked;
  currentProjectProgressLog = Array.isArray(p.progressLog) ? p.progressLog.slice() : [];
  renderProjectProgressList();
  $("projectFormTitle").textContent = tr("projectForm.editTitle", { id: p.projectCode || "" });
  renderProjectHistoryBox(p);

  $("projectCode").readOnly = !isAdmin;
  setProjectFormLocked(!isAdmin);
}
window.editProject = function (id) {
  const p = projectRecords.find(x => x._id === id);
  if (!p) return;
  fillFormFromProject(p);
  goPage("projectForm");
};
window.deleteProject = function (id) {
  if (!isAdmin) return;
  const p = projectRecords.find(x => x._id === id);
  if (!p) return;
  if (!confirm(tr("msg.confirmDeleteProject", { id: p.projectCode }))) return;
  db.collection(PROJECT_COLLECTION).doc(id).delete()
    .catch(err => alert(tr("msg.errDelete", { err: err.message })));
};

$("projectFormEl").addEventListener("submit", e => {
  e.preventDefault();
  const projectCode = $("projectCode").value.trim();
  if (!projectCode) { alert(tr("msg.needProjectCode")); return; }
  if (!$("projectName").value.trim()) { alert(tr("msg.needProjectName")); return; }
  const newId = sanitizeId(projectCode);
  if (!newId) { alert(tr("msg.invalidProjectCode")); return; }
  const oldId = $("projectDocId").value;
  const oldProject = oldId ? projectRecords.find(p => p._id === oldId) : null;

  if (!isAdmin && oldId) {
    alert(tr("msg.noPermEditProject"));
    return;
  }

  const data = {
    projectCode,
    name: $("projectName").value.trim(),
    status: $("projectStatus").value,
    priority: $("projectPriority").value,
    owner: $("projectOwner").value.trim(),
    department: $("projectDepartment").value.trim(),
    startDate: $("projectStart").value,
    endDate: $("projectEnd").value,
    progress: Math.max(0, Math.min(100, parseInt($("projectProgress").value, 10) || 0)),
    description: $("projectDescription").value.trim(),
    note: $("projectNote").value.trim(),
    attachments: currentProjectAttachments,
    progressLog: currentProjectProgressLog,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  data.locked = isAdmin ? $("projectLocked").checked : true;

  {
    const fieldChanges = diffProjectFields(oldProject, data);
    let action, carriedHistory = [];
    if (!oldId) {
      action = "create";
    } else if (oldId !== newId) {
      action = "rename";
      fieldChanges.unshift({ field: "projectCode", label: tr("field.projectCode").replace("*", ""), from: oldProject ? oldProject.projectCode : oldId, to: projectCode });
      carriedHistory = (oldProject && Array.isArray(oldProject.history)) ? oldProject.history : [];
    } else {
      action = "update";
    }
    if (action !== "update" || fieldChanges.length) {
      const entry = historyEntry(action, fieldChanges);
      data.history = firebase.firestore.FieldValue.arrayUnion(...carriedHistory, entry);
    }
  }

  const submitBtn = $("projectFormEl").querySelector('button[type="submit"]');
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = tr("common.saving");

  const writeOp = db.collection(PROJECT_COLLECTION).doc(newId).set(data, { merge: true })
    .then(() => (oldId && oldId !== newId) ? db.collection(PROJECT_COLLECTION).doc(oldId).delete() : null)
    .catch(err => {
      alert(tr("msg.errSyncServer", { err: err.message }) + "\n\n" + tr("msg.errSyncServerHint"));
    });

  setTimeout(() => {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
    $("projectDocId").value = newId;
    $("projectFormTitle").textContent = tr("projectForm.editTitle", { id: projectCode });
    goPage("projects");
  }, 150);

  const stuckTimer = setTimeout(() => {
    console.warn("Firestore write for project", newId, "has not resolved after 20s — check network/rules.");
  }, 20000);
  writeOp.finally(() => clearTimeout(stuckTimer));
});

/* ---------- Xóa toàn bộ ticket ---------- */
$("clearAllTickets").addEventListener("click", async () => {
  if (!confirm(tr("msg.confirmClearAllTickets"))) return;
  if (!confirm(tr("msg.confirmClearAllTickets2"))) return;
  if (!(await verifyDangerPassword())) return;
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
    alert(tr("msg.clearedAllTickets"));
  } catch (err) {
    alert(tr("msg.errClearData", { err: err.message }));
  }
});

/* ---------- JSON backup/restore ---------- */
$("backupJson").addEventListener("click", () => {
  if (!assets.length) { alert(tr("msg.noDataBackup")); return; }
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
    alert(tr("msg.restoredAssets", { count: total }));
  } catch (err) {
    alert(tr("msg.errRestore", { err: err.message }));
  }
  e.target.value = "";
});

/* ---------- Clear all ---------- */
$("clearAll").addEventListener("click", async () => {
  if (!confirm(tr("msg.confirmClearAllAssets"))) return;
  if (!confirm(tr("msg.confirmClearAllAssets2"))) return;
  if (!(await verifyDangerPassword())) return;
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
    alert(tr("msg.clearedAllAssets"));
  } catch (err) {
    alert(tr("msg.errClearData", { err: err.message }));
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
  submitBtn.textContent = tr("common.signingIn");
  try {
    await auth.signInWithEmailAndPassword(email, password);
    $("loginPassword").value = "";
  } catch (err) {
    const messages = {
      "auth/invalid-email": tr("auth.invalidEmail"),
      "auth/user-disabled": tr("auth.userDisabled"),
      "auth/user-not-found": tr("auth.userNotFound"),
      "auth/wrong-password": tr("auth.wrongPassword"),
      "auth/unauthorized-domain": tr("auth.unauthorizedDomain"),
      "auth/invalid-credential": tr("auth.invalidCredential"),
      "auth/too-many-requests": tr("auth.tooManyRequests")
    };
    errBox.textContent = messages[err.code] || tr("auth.loginError", { err: err.message });
    errBox.classList.remove("hidden");
  }
  submitBtn.disabled = false;
  submitBtn.textContent = tr("login.submit");
});

$("logoutBtn").addEventListener("click", () => {
  if (!confirm(tr("msg.confirmLogout"))) return;
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
  isViewer = false;
  isReportOnly = false;
  try {
    const snap = await db.collection("users").doc(user.uid).get();
    const data = snap.exists ? snap.data() : null;
    const disabled = data ? data.disabled === true : false;
    // Tài khoản bị Admin "Vô hiệu hóa" vẫn còn document users/{uid} (giữ
    // lịch sử) nhưng app phải coi như không có vai trò gì — y hệt tài
    // khoản chưa từng được cấp quyền.
    const role = (!disabled && data) ? data.role : null;
    if (role === "admin") isAdmin = true;
    else if (role === "collector") isCollector = true;
    else if (role === "viewer") isViewer = true;
    else if (role === "reportonly") isReportOnly = true;
  } catch (err) {
    console.warn("Không đọc được vai trò tài khoản:", err);
  }
  // role-staff: ẩn mọi thứ .admin-only (Collector lẫn Viewer đều không
  // phải Admin nên đều bị ẩn — giữ nguyên hành vi cũ).
  document.body.classList.toggle("role-staff", !isAdmin);
  // role-viewer: ẩn thêm mọi thứ .creator-only — Viewer xem được toàn bộ
  // nhưng không tạo mới được tài sản/ticket (khớp Firestore Rules).
  document.body.classList.toggle("role-viewer", isViewer);
  // role-reportonly: ẩn toàn bộ dashboard/menu/bottomnav — tài khoản này
  // chỉ được thấy đúng 1 trang Chuyển đổi báo cáo (xem CSS + goPage()).
  document.body.classList.toggle("role-reportonly", isReportOnly);
  updateRoleBadge();
  return isAdmin || isCollector || isViewer || isReportOnly;
}
function updateRoleBadge() {
  const badge = $("roleBadge");
  if (!badge) return;
  if (isAdmin) { badge.textContent = tr("roleBadge.admin"); badge.classList.add("admin"); }
  else if (isCollector) { badge.textContent = tr("roleBadge.collector"); badge.classList.remove("admin"); }
  else if (isViewer) { badge.textContent = tr("roleBadge.viewer"); badge.classList.remove("admin"); }
  else if (isReportOnly) { badge.textContent = tr("roleBadge.reportonly"); badge.classList.remove("admin"); }
  else { badge.textContent = tr("roleBadge.none"); badge.classList.remove("admin"); }
}

/* ---------- Mở thẳng trang tài sản khi vào app từ link QR trên tem (?code=...) ---------- */
function openPendingScanCodeAsset() {
  const code = pendingScanCode;
  pendingScanCode = "";
  try {
    const url = new URL(location.href);
    url.searchParams.delete("code");
    history.replaceState(null, "", url.toString());
  } catch (e) { /* bỏ qua nếu trình duyệt không hỗ trợ */ }
  let attempts = 0;
  const tryOpen = () => {
    attempts++;
    const existing = assets.find(a => a.code === code);
    if (existing) { editAsset(existing._id); return; }
    if (attempts < 20) { setTimeout(tryOpen, 250); return; } // đợi dữ liệu đồng bộ từ Firestore (tối đa ~5s)
    handleScannedAssetCode(code); // hết thời gian chờ vẫn không thấy — hiện màn hình quét (có nút tạo mới nếu mã chưa tồn tại)
  };
  tryOpen();
}

/* ---------- Chuyển đổi báo cáo Word (.docx) -> ảnh JPG ----------
   Hoàn toàn chạy trên thiết bị (không upload file lên server nào):
   mammoth.js đọc nội dung .docx thành HTML, dựng lại trong 1 khung ẩn
   có bề rộng cố định theo khổ giấy, html2canvas chụp thành 1 canvas dài,
   rồi cắt thành từng "trang" theo ranh giới các khối nội dung (không cắt
   ngang 1 ảnh/bảng) để xuất JPG.
   Lưu ý: đây là ngắt trang ước lượng (không phải công cụ dàn trang chuẩn
   của Word — số trang JPG có thể không khớp 100% số trang gốc, nhất là
   với văn bản nhiều chữ chảy liên tục) — chỉ hỗ trợ .docx (không đọc
   được .doc cũ vì đó là định dạng nhị phân khác, cần Save As sang .docx
   trước). */
const REPORT_PAGE_SIZES = {
  a4: { w: 794, h: 1123 },
  letter: { w: 816, h: 1056 }
};
let reportPages = [];       // [{ dataUrl, index }]
let reportSourceName = "report";

async function convertReportFile(file) {
  if (!file) return;
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".doc") && !lower.endsWith(".docx")) {
    alert(tr("report.oldDocError"));
    return;
  }
  if (typeof mammoth === "undefined") {
    alert(tr("report.libMissing"));
    return;
  }
  const btnLabel = $("reportFile").closest("label");
  const statusEl = $("reportStatus");
  if (btnLabel) btnLabel.classList.add("hidden");
  statusEl.classList.remove("hidden");
  statusEl.textContent = tr("report.converting");

  let container = null;
  try {
    reportSourceName = file.name.replace(/\.[^.]+$/, "");
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.convertToHtml(
      { arrayBuffer },
      { convertImage: mammoth.images.imgElement(img =>
          img.read("base64").then(b64 => ({ src: "data:" + img.contentType + ";base64," + b64 }))
        )
      }
    );

    const sizeKey = $("reportPageSize").value || "a4";
    const size = REPORT_PAGE_SIZES[sizeKey] || REPORT_PAGE_SIZES.a4;
    const quality = (parseInt($("reportQuality").value, 10) || 85) / 100;
    const scale = 2; // độ nét ảnh xuất ra (@2x)

    container = document.createElement("div");
    container.className = "report-render-box";
    container.style.position = "fixed";
    container.style.left = "-99999px";
    container.style.top = "0";
    container.style.width = size.w + "px";
    container.style.padding = "40px";
    container.style.fontFamily = "'Times New Roman', serif";
    container.style.fontSize = "14px";
    container.style.lineHeight = "1.5";
    container.innerHTML = result.value;
    document.body.appendChild(container);

    // Chờ ảnh nhúng trong file (nếu có) load xong trước khi chụp
    const imgs = Array.from(container.querySelectorAll("img"));
    await Promise.all(imgs.map(img => img.complete
      ? Promise.resolve()
      : new Promise(res => { img.onload = img.onerror = res; })));

    // Tính điểm ngắt trang theo ranh giới các khối nội dung cấp 1 (thẻ
    // <p>/<table>/... con trực tiếp của container) — KHÔNG cắt cứng theo
    // pixel, để tránh cắt ngang 1 ảnh hoặc 1 bảng làm đôi. Nếu 1 khối tự
    // nó đã cao hơn 1 trang (vd 1 ảnh rất lớn) thì đành để nguyên khối đó
    // thành 1 "trang" dài hơn khổ giấy chuẩn — không còn cách nào khác nếu
    // không được phép cắt ngang khối.
    const pageHeightCss = size.h;
    const children = Array.from(container.children);
    const breakPointsCss = [0];
    let pageStartCss = 0;
    children.forEach(el => {
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      if (bottom - pageStartCss > pageHeightCss && top > pageStartCss) {
        breakPointsCss.push(top);
        pageStartCss = top;
      }
    });
    breakPointsCss.push(container.scrollHeight);

    const fullCanvas = await html2canvas(container, {
      scale, useCORS: true, backgroundColor: "#ffffff"
    });

    reportPages = [];
    for (let i = 0; i < breakPointsCss.length - 1; i++) {
      const yStart = Math.round(breakPointsCss[i] * scale);
      const yEnd = Math.round(Math.min(breakPointsCss[i + 1] * scale, fullCanvas.height));
      const h = yEnd - yStart;
      if (h <= 0) continue;
      const pageCanvas = document.createElement("canvas");
      pageCanvas.width = fullCanvas.width;
      pageCanvas.height = h;
      const ctx = pageCanvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, pageCanvas.width, h);
      ctx.drawImage(fullCanvas, 0, yStart, fullCanvas.width, h, 0, 0, fullCanvas.width, h);
      reportPages.push({ dataUrl: pageCanvas.toDataURL("image/jpeg", quality), canvas: pageCanvas, index: reportPages.length + 1 });
    }
    if (reportPages.length === 0) {
      reportPages.push({ dataUrl: fullCanvas.toDataURL("image/jpeg", quality), canvas: fullCanvas, index: 1 });
    }
    renderReportPages();
    toast(tr("report.done", { n: reportPages.length }));
  } catch (e) {
    console.error(e);
    alert(tr("report.convertError") + (e && e.message ? (": " + e.message) : ""));
  } finally {
    if (container && container.parentNode) container.parentNode.removeChild(container);
    statusEl.classList.add("hidden");
    if (btnLabel) btnLabel.classList.remove("hidden");
    $("reportFile").value = "";
  }
}

function renderReportPages() {
  const grid = $("reportPagesGrid");
  grid.innerHTML = "";
  reportPages.forEach(p => {
    const card = document.createElement("div");
    card.className = "report-page-card";
    const img = document.createElement("img");
    img.className = "report-page-thumb";
    img.src = p.dataUrl;
    img.alt = tr("reportConvert.pageLabel", { n: p.index });
    const link = document.createElement("a");
    link.className = "button secondary";
    link.href = p.dataUrl;
    link.download = `${reportSourceName}-trang${String(p.index).padStart(2, "0")}.jpg`;
    link.textContent = tr("reportConvert.downloadPage", { n: p.index });
    card.appendChild(img);
    card.appendChild(link);
    grid.appendChild(card);
  });
  $("reportPagesSection").classList.toggle("hidden", reportPages.length === 0);
  $("reportDownloadAllBtn").classList.toggle("hidden", reportPages.length === 0);
}

if ($("reportFile")) {
  $("reportFile").addEventListener("change", e => convertReportFile(e.target.files[0]));
}
if ($("reportDownloadAllBtn")) {
  $("reportDownloadAllBtn").addEventListener("click", () => {
    if (!reportPages.length) return;
    // Ghép toàn bộ các trang thành 1 ảnh JPG duy nhất (xếp dọc, có vạch
    // xám mảnh phân cách giữa các trang cho dễ nhìn ranh giới) thay vì
    // tải nhiều file riêng — tránh bị trình duyệt chặn bớt khi tải
    // nhiều file cùng lúc, và tiện gửi/lưu như 1 ảnh duy nhất.
    const gap = 24;
    const maxWidth = Math.max(...reportPages.map(p => p.canvas.width));
    const totalHeight = reportPages.reduce((sum, p) => sum + p.canvas.height, 0)
      + gap * (reportPages.length - 1);
    const combined = document.createElement("canvas");
    combined.width = maxWidth;
    combined.height = totalHeight;
    const ctx = combined.getContext("2d");
    ctx.fillStyle = "#cbd5e1";
    ctx.fillRect(0, 0, maxWidth, totalHeight);
    let y = 0;
    reportPages.forEach(p => {
      ctx.drawImage(p.canvas, 0, y);
      y += p.canvas.height + gap;
    });
    const quality = (parseInt($("reportQuality").value, 10) || 85) / 100;
    const dataUrl = combined.toDataURL("image/jpeg", quality);
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${reportSourceName}-full.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });
}

auth.onAuthStateChanged(async user => {
  if (user) {
    $("loginScreen").classList.add("hidden");
    $("appShell").classList.remove("hidden");
    $("userEmail").textContent = user.email || "";
    const authorized = await loadRole(user);
    if (!authorized) {
      alert(tr("msg.noAppAccess"));
      auth.signOut();
      return;
    }
    if (isReportOnly) {
      // Tài khoản chỉ dùng để chuyển đổi Word -> JPG: tính năng này chạy
      // hoàn toàn trên thiết bị, không cần đọc bất kỳ collection nào
      // (assets/tickets/employees/users) — bỏ qua các sync đó để tránh
      // gọi Firestore thừa (và tránh lỗi permission-denied vì Rules
      // không cấp quyền đọc các collection này cho vai trò này).
      goPage("reportConvert");
    } else {
      initSync();
      initTicketSync();
      initProjectSync();
      initEmployeesSync();
      if (isAdmin) { initUsersSync(); initHomeLaptopExportMetaSync(); } // chỉ Admin đọc toàn bộ users + cần thấy cảnh báo xuất lại báo cáo mang laptop
      goPage("dashboard");
      if (pendingScanCode) openPendingScanCodeAsset();
    }
  } else {
    stopSync();
    stopTicketSync();
    stopProjectSync();
    stopEmployeesSync();
    stopUsersSync();
    stopHomeLaptopExportMetaSync();
    assets = [];
    ticketRecords = [];
    projectRecords = [];
    isAdmin = false;
    isCollector = false;
    isViewer = false;
    isReportOnly = false;
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
loadProjectsLocalCache();
