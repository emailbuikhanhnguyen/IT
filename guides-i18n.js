/* guides-i18n.js — chuỗi giao diện (VI / EN / ZH) cho module Hướng dẫn kỹ thuật.
   Nạp NGAY SAU i18n.js. Tự gộp vào I18N nên không phải sửa i18n.js. */
(function () {
  const T = {
    "guides.hint": ["Tài liệu tham khảo, hướng dẫn xử lý sự cố thường gặp, quy trình chuẩn cho IT — PDF, Excel, Word, PowerPoint...", "Reference docs, common troubleshooting guides, standard IT procedures — PDF, Excel, Word, PowerPoint...", "参考文档、常见故障处理指南、IT标准流程 — PDF、Excel、Word、PowerPoint..."],
    "guides.add": ["＋ Thêm tài liệu", "＋ Add document", "＋ 添加文档"],
    "guides.searchPh": ["Tìm tên tài liệu, mô tả...", "Search document name, description...", "搜索文档名称、描述..."],
    "guides.allCat": ["Tất cả danh mục", "All categories", "所有分类"],
    "guides.none": ["Chưa có tài liệu nào.", "No documents yet.", "暂无文档。"],
    "guides.download": ["Tải xuống", "Download", "下载"],
    "guides.formTitle": ["📘 Thêm tài liệu", "📘 Add document", "📘 添加文档"],
    "guides.formTitle.edit": ["📘 Sửa tài liệu", "📘 Edit document", "📘 编辑文档"],
    "guides.f.title": ["Tên tài liệu*", "Document title*", "文档名称*"],
    "guides.f.title.ph": ["VD: Hướng dẫn cấu hình VLAN Ruijie", "E.g. Ruijie VLAN configuration guide", "例：Ruijie VLAN 配置指南"],
    "guides.f.cat": ["Danh mục", "Category", "分类"],
    "guides.f.cat.ph": ["VD: Mạng, Máy in, Camera, Quy trình chung...", "E.g. Network, Printers, Camera, General process...", "例：网络、打印机、摄像头、通用流程..."],
    "guides.f.file": ["Chọn file*", "Choose file*", "选择文件*"],
    "guides.f.fileReplace": ["Chọn file mới (bỏ trống để giữ file cũ)", "Choose new file (leave empty to keep current file)", "选择新文件（留空则保留原文件）"],
    "guides.f.fileHint": ["PDF, Excel, Word, PowerPoint, ảnh, file nén... tối đa 20MB.", "PDF, Excel, Word, PowerPoint, images, archives... max 20MB.", "PDF、Excel、Word、PowerPoint、图片、压缩包... 最大20MB。"],
    "guides.f.currentFile": ["Đang có: {{name}} ({{size}})", "Current file: {{name}} ({{size}})", "当前文件：{{name}}（{{size}}）"],
    "guides.f.submit": ["⬆ Tải lên", "⬆ Upload", "⬆ 上传"],
    "guides.f.titleRequired": ["Nhập tên tài liệu.", "Please enter a document title.", "请输入文档名称。"],
    "guides.f.fileRequired": ["Chọn file cần tải lên.", "Please choose a file to upload.", "请选择要上传的文件。"],
    "guides.f.tooBig": ["File quá lớn (tối đa {{mb}}MB).", "File too large (max {{mb}}MB).", "文件过大（最大{{mb}}MB）。"],
    "guides.f.err": ["Không lưu được: {{err}}", "Could not save: {{err}}", "无法保存：{{err}}"],
    "guides.noperm": ["Bạn không có quyền thực hiện.", "You don't have permission.", "您没有权限执行此操作。"],
    "guides.delConfirm": ["Xóa tài liệu \"{{title}}\"?", "Delete document \"{{title}}\"?", "删除文档\"{{title}}\"？"]
  };

  const langs = ["vi", "en", "zh"];
  langs.forEach((lang, li) => {
    if (typeof I18N === "undefined" || !I18N[lang]) return;
    Object.keys(T).forEach(k => { I18N[lang][k] = T[k][li]; });
  });
})();
