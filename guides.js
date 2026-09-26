/* guides.js — Hướng dẫn kỹ thuật: kho tài liệu PDF/Excel/Word/PowerPoint... của IT.

   Đây là chỗ ĐẦU TIÊN trong app thật sự dùng Firebase Storage để lưu file (trước
   đây storage.rules có sẵn 1 path cho "Dự án CNTT" nhưng module đó chỉ lưu LINK
   dán tay, không upload file thật — xem "🔗 Liên kết tài liệu" ở projectForm).

   Dữ liệu:
   - Firestore `guides/{autoId}`: title, category, desc, fileName, fileExt,
     fileSize, storagePath, url, createdAt/createdBy, updatedAt/updatedBy.
   - Storage   `guides/{docId}/{timestamp}_{fileName}`: file thật (tối đa 20MB,
     xem GUIDE_MAX_MB bên dưới — khớp với giới hạn ở storage.rules, sửa thì sửa
     cả 2 chỗ).

   Phân quyền (xem firestore.rules + storage.rules): Admin/Collector/Viewer đều
   xem & tải xuống được; chỉ Admin thêm/sửa/xóa (nút ẩn qua class "admin-only",
   Rules chặn lại lần nữa ở tầng dưới nên không thể bypass chỉ bằng sửa DOM).

   Nạp SAU app.js (dùng chung db/isAdmin/currentEmail/goPage/tr/$/escapeHtml/
   filterList/setupAutocomplete/formatAssetDate là global từ app.js). */
(function () {
  const GUIDE_COLLECTION = "guides";
  const GUIDE_MAX_MB = 20;
  const GUIDE_MAX_BYTES = GUIDE_MAX_MB * 1024 * 1024;

  let guideRecords = [];
  let unsubscribeGuideSync = null;

  const esc = s => escapeHtml(s);
  const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase();
  const tsToMs = ts => {
    if (ts && typeof ts.toMillis === "function") return ts.toMillis();
    if (ts instanceof Date) return ts.getTime();
    return 0;
  };
  const fmtSize = n => {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  };
  const ICONS = { pdf: "📕", xls: "📊", xlsx: "📊", csv: "📊", doc: "📄", docx: "📄", ppt: "📽", pptx: "📽", zip: "🗜", rar: "🗜", png: "🖼", jpg: "🖼", jpeg: "🖼" };
  const fileIcon = ext => ICONS[String(ext || "").toLowerCase()] || "📁";
  const categories = () => Array.from(new Set(guideRecords.map(g => g.category).filter(Boolean))).sort((a, b) => a.localeCompare(b));

  /* ---------- Sync (Firestore) ---------- */
  window.initGuidesSync = function () {
    if (unsubscribeGuideSync) return; // already listening
    unsubscribeGuideSync = db.collection(GUIDE_COLLECTION).onSnapshot(snapshot => {
      guideRecords = snapshot.docs.map(d => Object.assign({ _id: d.id }, d.data()));
      if (typeof window.renderGuidesAll === "function") window.renderGuidesAll();
    }, err => console.error("Guide sync error:", err));
  };
  window.stopGuidesSync = function () { if (unsubscribeGuideSync) { unsubscribeGuideSync(); unsubscribeGuideSync = null; } };
  window.renderGuidesAll = function () { if (typeof renderGuideList === "function") renderGuideList(); };
  window.onGuidesPage = function (name) { if (name === "guides") renderGuideList(); };

  /* ================= UI ================= */
  const $ = id => document.getElementById(id);
  if (!$("guideList")) return; // (harness/test không có trang này)

  function renderGuideList() {
    const f = norm($("guideSearch").value);
    const cf = $("guideFilterCat").value;
    const cats = categories();
    $("guideFilterCat").innerHTML = `<option value="">${esc(tr("guides.allCat"))}</option>` +
      cats.map(c => `<option value="${esc(c)}"${c === cf ? " selected" : ""}>${esc(c)}</option>`).join("");
    const list = guideRecords.filter(g => (!cf || g.category === cf) &&
      (!f || norm([g.title, g.desc, g.category, g.fileName].join(" ")).includes(f)))
      .sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
    $("guideList").innerHTML = list.map(g => `
      <div class="asset">
        <div>
          <h3>${fileIcon(g.fileExt)} ${esc(g.title)}</h3>
          <div class="muted">${g.category ? esc(g.category) + " · " : ""}${esc(g.fileName || "")}${g.fileSize ? " · " + esc(fmtSize(g.fileSize)) : ""}</div>
          ${g.desc ? `<div class="muted">${esc(g.desc)}</div>` : ""}
          <div class="muted">🗓 ${esc(formatAssetDate(tsToMs(g.createdAt)))}${g.createdBy ? " · " + esc(g.createdBy) : ""}</div>
        </div>
        <div class="asset-actions">
          <button onclick="downloadGuide('${g._id}')">⬇ ${esc(tr("guides.download"))}</button>
          <button class="secondary admin-only" onclick="openGuideForm('${g._id}')">✏ ${esc(tr("action.edit"))}</button>
          <button class="secondary admin-only" onclick="deleteGuide('${g._id}')">🗑 ${esc(tr("action.delete"))}</button>
        </div>
      </div>`).join("") || `<div class="card empty"><p>${esc(tr("guides.none"))}</p></div>`;
  }
  ["guideSearch", "guideFilterCat"].forEach(id => $(id).addEventListener("input", renderGuideList));

  window.downloadGuide = function (id) {
    const g = guideRecords.find(x => x._id === id);
    if (g && g.url) window.open(g.url, "_blank", "noopener");
  };

  /* ---------- Form thêm/sửa ---------- */
  function resetGuideForm() {
    $("guideDocId").value = "";
    $("guideFormTitle").textContent = tr("guides.formTitle");
    $("guideTitle").value = ""; $("guideCat").value = ""; $("guideDesc").value = "";
    $("guideFile").value = ""; $("guideFile").required = true;
    $("guideFileLabelTxt").textContent = tr("guides.f.file");
    $("guideCurrentFile").classList.add("hidden");
    $("guideFormMsg").className = "hidden";
    $("guideUploadBar").classList.add("hidden"); $("guideUploadBar").value = 0;
  }
  window.openGuideForm = function (id) {
    if (!isAdmin) return alert(tr("guides.noperm"));
    const g = id ? guideRecords.find(x => x._id === id) : null;
    resetGuideForm();
    if (g) {
      $("guideDocId").value = g._id;
      $("guideFormTitle").textContent = tr("guides.formTitle.edit");
      $("guideTitle").value = g.title || ""; $("guideCat").value = g.category || ""; $("guideDesc").value = g.desc || "";
      $("guideFile").required = false;
      $("guideFileLabelTxt").textContent = tr("guides.f.fileReplace");
      $("guideCurrentFile").classList.remove("hidden");
      $("guideCurrentFile").textContent = tr("guides.f.currentFile", { name: g.fileName || "", size: fmtSize(g.fileSize) });
    }
    goPage("guideForm");
  };
  $("guidesAddBtn").addEventListener("click", resetGuideForm);

  setupAutocomplete("guideCat", "guideCatSuggest",
    q => filterList(categories(), q, 20).map(v => ({ value: v })),
    it => esc(it.value),
    it => { $("guideCat").value = it.value; }
  );

  function showFormMsg(text) {
    const el = $("guideFormMsg");
    el.className = "pr-alert warn"; el.textContent = text;
  }

  $("guideFormEl").addEventListener("submit", async e => {
    e.preventDefault();
    if (!isAdmin) return alert(tr("guides.noperm"));
    const id = $("guideDocId").value;
    const title = $("guideTitle").value.trim();
    if (!title) return showFormMsg(tr("guides.f.titleRequired"));
    const file = $("guideFile").files[0];
    if (!file && !id) return showFormMsg(tr("guides.f.fileRequired"));
    if (file && file.size > GUIDE_MAX_BYTES) return showFormMsg(tr("guides.f.tooBig", { mb: GUIDE_MAX_MB }));

    const btn = $("guideSubmitBtn"); btn.disabled = true;
    $("guideFormMsg").className = "hidden";
    const ts = firebase.firestore.FieldValue.serverTimestamp;
    try {
      const docRef = id ? db.collection(GUIDE_COLLECTION).doc(id) : db.collection(GUIDE_COLLECTION).doc();
      const data = {
        title, category: $("guideCat").value.trim(), desc: $("guideDesc").value.trim(),
        updatedAt: ts(), updatedBy: currentEmail || "?"
      };
      if (!id) Object.assign(data, { createdAt: ts(), createdBy: currentEmail || "?" });

      if (file) {
        const ext = (file.name.split(".").pop() || "").toLowerCase();
        const storagePath = `guides/${docRef.id}/${Date.now()}_${file.name}`;
        const old = id ? guideRecords.find(x => x._id === id) : null;
        const task = firebase.storage().ref(storagePath).put(file);
        $("guideUploadBar").classList.remove("hidden"); $("guideUploadBar").value = 0;
        await new Promise((resolve, reject) => {
          task.on("state_changed",
            snap => { $("guideUploadBar").value = Math.round(snap.bytesTransferred / snap.totalBytes * 100); },
            reject, resolve);
        });
        const url = await task.snapshot.ref.getDownloadURL();
        Object.assign(data, { fileName: file.name, fileExt: ext, fileSize: file.size, storagePath, url });
        await docRef.set(data, { merge: true });
        // Sửa & đổi file mới thành công -> dọn file cũ trên Storage (không chặn
        // luồng chính nếu xóa lỗi, chỉ là dọn rác, không phải dữ liệu quan trọng).
        if (old && old.storagePath && old.storagePath !== storagePath) {
          firebase.storage().ref(old.storagePath).delete().catch(() => {});
        }
      } else {
        await docRef.set(data, { merge: true }); // chỉ sửa tên/danh mục/mô tả, giữ nguyên file
      }
      goPage("guides");
    } catch (err) {
      showFormMsg(tr("guides.f.err", { err: err.message }));
    } finally {
      btn.disabled = false;
      $("guideUploadBar").classList.add("hidden");
    }
  });

  window.deleteGuide = async function (id) {
    if (!isAdmin) return alert(tr("guides.noperm"));
    const g = guideRecords.find(x => x._id === id); if (!g) return;
    if (!confirm(tr("guides.delConfirm", { title: g.title }))) return;
    try {
      await db.collection(GUIDE_COLLECTION).doc(id).delete();
      if (g.storagePath) firebase.storage().ref(g.storagePath).delete().catch(() => {});
    } catch (e) { alert(tr("msg.errDelete", { err: e.message })); }
  };
})();
