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

try {
  db.enablePersistence({ synchronizeTabs: true }).catch(err => {
    console.warn("Offline persistence not enabled:", err.code);
  });
} catch (e) { console.warn(e); }

/* ---------- State ---------- */
let assets = [];              // local cache, synced from Firestore
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
function renderAll() {
  renderDashboard();
  renderAssetList();
  updateAreaFilter();
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
  const areas = {};
  assets.forEach(a => {
    const ar = a.area || "(Chưa có khu vực)";
    if (!areas[ar]) areas[ar] = { total: 0, checked: 0 };
    areas[ar].total++;
    if (classifyCheck(a.checkStatus) === "checked") areas[ar].checked++;
  });
  let html = `<div class="hint">Tổng tiến độ: ${checked}/${total} (${pct}%)</div>
    <div class="bar"><i style="width:${pct}%"></i></div>`;
  Object.keys(areas).sort().forEach(ar => {
    const info = areas[ar];
    const p = info.total ? Math.round((info.checked / info.total) * 100) : 0;
    html += `<div class="hint">${escapeHtml(ar)}: ${info.checked}/${info.total} (${p}%)</div>
      <div class="bar"><i style="width:${p}%"></i></div>`;
  });
  if (!total) html = `<div class="empty">Chưa có tài sản nào. Bấm "＋ Tạo tài sản" để bắt đầu.</div>`;
  $("checkStats").innerHTML = html;
}

/* ---------- Asset list ---------- */
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function updateAreaFilter() {
  const sel = $("filterArea");
  const current = sel.value;
  const areasSet = Array.from(new Set(assets.map(a => a.area).filter(Boolean))).sort();
  sel.innerHTML = '<option value="">Tất cả khu vực</option>' + areasSet.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
  if (areasSet.includes(current)) sel.value = current;
}
function badgeClass(status) {
  const c = classifyCheck(status);
  if (c === "checked") return "ok";
  if (c === "exception") return "bad";
  return "warn";
}
function renderAssetList() {
  const q = ($("search").value || "").trim().toLowerCase();
  const areaF = $("filterArea").value;
  const checkF = $("filterCheck").value;

  let list = assets.slice().sort((a, b) => (a.code || "").localeCompare(b.code || ""));
  if (q) {
    list = list.filter(a =>
      [a.code, a.serial, a.model, a.user, a.assetName].some(v => (v || "").toLowerCase().includes(q))
    );
  }
  if (areaF) list = list.filter(a => a.area === areaF);
  if (checkF) list = list.filter(a => classifyCheck(a.checkStatus) === checkF);

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
        <h3>${escapeHtml(a.code)} ${a.assetName ? "· " + escapeHtml(a.assetName) : ""}</h3>
        <div class="muted">${escapeHtml(a.type || "")} ${a.model ? "· " + escapeHtml(a.model) : ""}</div>
        <div class="muted">${a.area ? "📍 " + escapeHtml(a.area) : ""} ${a.user ? "· 👤 " + escapeHtml(a.user) : ""}</div>
        <span class="badge ${badgeClass(a.checkStatus)}">${escapeHtml(a.checkStatus || CHECK_UNCHECKED)}</span>
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
$("search").addEventListener("input", renderAssetList);
$("filterArea").addEventListener("change", renderAssetList);
$("filterCheck").addEventListener("change", renderAssetList);

/* ---------- Asset form ---------- */
function populateTypeSelect() {
  $("type").innerHTML = ASSET_TYPES.map(t => `<option>${t}</option>`).join("");
}
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
  $("assetLocked").checked = false;
  $("code").readOnly = false;
  setFormLocked(false);
}
$("resetForm").addEventListener("click", clearForm);

function fillFormFromAsset(a) {
  $("assetId").value = a._id || "";
  $("code").value = a.code || "";
  $("type").value = a.type || ASSET_TYPES[0];
  $("assetName").value = a.assetName || "";
  $("model").value = a.model || "";
  $("serial").value = a.serial || "";
  $("ip").value = a.ip || "";
  $("mac").value = a.mac || "";
  $("spec").value = a.spec || "";
  $("area").value = a.area || "";
  $("user").value = a.user || "";
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

  // Defense in depth: the form is already disabled for non-admins on any
  // EXISTING record, but double-check here too. Firestore Rules are the
  // real enforcement layer regardless — the collector account can only
  // ever create brand-new docs, never update one that already exists.
  if (!isAdmin && oldId) {
    alert("Bạn không có quyền sửa tài sản đã tồn tại. Liên hệ quản trị viên (IT) nếu cần chỉnh sửa.");
    return;
  }

  const data = {
    code,
    type: $("type").value,
    assetName: $("assetName").value.trim(),
    model: $("model").value.trim(),
    serial: $("serial").value.trim(),
    ip: $("ip").value.trim(),
    mac: $("mac").value.trim(),
    spec: $("spec").value.trim(),
    area: $("area").value.trim(),
    user: $("user").value.trim(),
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
$active = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }
$ipParts = @()
$macParts = @()
foreach ($a in $active) {
  $ips = (Get-NetIPAddress -InterfaceIndex $a.IfIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254.*' }).IPAddress
  foreach ($ip in $ips) { $ipParts += $ip }
  $macParts += "$($a.Name)=$($a.MacAddress)"
}
Write-Output "===== KET QUA - COPY TU DAY ====="
Write-Output "MODEL: $($cs.Model)"
Write-Output "SERIAL: $($bios.SerialNumber)"
Write-Output "CAUHINH: $($cpu.Name) / RAM \${ramGB}GB / $($disk.Model)"
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

$("btnAutofill").addEventListener("click", () => {
  const text = $("pasteInfoBox").value;
  if (!text.trim()) { alert("Chưa có nội dung để tự động điền."); return; }

  const map = { MODEL: "model", SERIAL: "serial", CAUHINH: "spec", IP: "ip", MAC: "mac" };
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
function onScanSuccess(decodedText) {
  if (!decodedText.startsWith("ITASSET:")) return;
  const code = decodedText.slice(8).trim();
  stopScanner();
  const resBox = $("scanResult");
  resBox.classList.remove("hidden");
  const existing = assets.find(a => a.code === code);
  if (existing) {
    resBox.innerHTML = `<b>${escapeHtml(code)}</b> — ${escapeHtml(existing.assetName || "")}<br>
      <span class="badge ${badgeClass(existing.checkStatus)}">${escapeHtml(existing.checkStatus || CHECK_UNCHECKED)}</span><br>
      <button style="margin-top:8px" onclick="editAsset('${existing._id}')">Mở để cập nhật kiểm kê</button>`;
  } else {
    resBox.innerHTML = `<b>${escapeHtml(code)}</b> — chưa có trong hệ thống.<br>
      <button style="margin-top:8px" onclick="quickCreate('${escapeHtml(code)}')">Tạo tài sản mới với mã này</button>`;
  }
}
window.quickCreate = function (code) {
  clearForm();
  $("code").value = code;
  renderQR(code);
  goPage("assetForm");
};

/* ---------- Excel export/import ---------- */
const COLUMNS = ["code", "type", "assetName", "model", "serial", "ip", "mac", "spec", "area", "user", "status", "checkStatus", "note"];
const COLUMN_LABELS_VN = {
  code: "Mã tài sản", type: "Loại thiết bị", assetName: "Tên tài sản", model: "Model", serial: "Serial",
  ip: "IP", mac: "MAC", spec: "Cấu hình", area: "Khu vực", user: "Người sử dụng",
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
    goPage("dashboard");
  } else {
    stopSync();
    assets = [];
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
