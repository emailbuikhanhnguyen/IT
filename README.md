# IT Asset Inventory PWA v2

Bản này dành cho quy trình:
**kiểm kê lần đầu → tạo mã → sinh QR → dán QR → lần sau quét QR bằng điện thoại → bổ sung thông tin/chụp ảnh → xác nhận kiểm kê.**

## Chạy
Không mở `index.html` bằng file:// nếu muốn camera/Service Worker.

Máy tính:
```bash
python -m http.server 8080 --bind 0.0.0.0
```
Điện thoại cùng WiFi mở:
`http://IP-MAY-TINH:8080`

Camera thường yêu cầu secure context. Nếu Android không mở camera qua HTTP LAN, dùng HTTPS/local secure hosting.

## QR
QR chứa mã dạng:
`ITASSET:LAB-PC-001`

Không nhét toàn bộ thông tin thiết bị vào QR. Database mới là nơi lưu thông tin.

## Lưu ý
Thư viện XLSX, html5-qrcode và QRCodeJS đang dùng CDN nên lần đầu cần Internet để tải thư viện. Service Worker sẽ cache các tài nguyên sau khi đã tải.

## Excel chuẩn
Các cột có thể dùng:
- code
- type
- assetName
- model
- serial
- ip
- mac
- spec
- area
- user
- status
- checkStatus
- note

Có hỗ trợ tên cột tiếng Việt tương ứng như trong app.

## Quy trình thực tế
1. Import danh sách Lab nếu đã có.
2. Hoặc tạo từng tài sản khi kiểm kê.
3. Xác minh Serial/Model/Cấu hình.
4. Sinh QR và in/dán.
5. Quét QR bằng điện thoại.
6. Chụp ảnh thiết bị.
7. Bổ sung IP/MAC/Serial nếu còn thiếu.
8. Chọn `Đã kiểm - OK`, `Sai thông tin`, `Không tìm thấy` hoặc `Thiết bị mới`.
9. Export Excel cuối đợt.
