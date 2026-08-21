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
`ITASSET:LAP-AT-0001`

Không nhét toàn bộ thông tin thiết bị vào QR. Database mới là nơi lưu thông tin.

## Lưu ý
Thư viện XLSX, html5-qrcode và QRCodeJS đang dùng CDN nên lần đầu cần Internet để tải thư viện. Service Worker sẽ cache các tài nguyên sau khi đã tải.

## Excel chuẩn
Các cột có thể dùng:
- employeeCode
- user
- section
- group
- code
- type
- deviceName (Tên tài sản — điền tay hoặc tự điền qua PowerShell, xem mục dưới)
- model
- serial
- ip
- mac
- spec
- status
- checkStatus
- note

Có hỗ trợ tên cột tiếng Việt tương ứng như trong app.

## Nhân viên (autocomplete cho "Người sử dụng")
File `employees.js` chứa danh sách nhân viên (snapshot từ file HR export,
291 dòng gốc → 284 dòng có Mã NV + Tên) để gõ tên là gợi ý, chọn xong tự
điền **Mã nhân viên / Bộ phận (Section) / Tổ-Chuyền (Group)**. Ba ô này vẫn
sửa tay được hoặc để trống — không bắt buộc. Bộ phận (Section) còn được
dùng để tự gợi ý **Mã tài sản** — xem mục bên dưới.

**Cập nhật danh sách nhân viên:** khi HR xuất file mới, mở lại
`ImportEmployeeProfile` (sheet đầu, dữ liệu từ dòng 7), lấy 4 cột
`Employee Code`, `Full Name _VN`, `Section`, `Group`, sinh lại mảng
`EMPLOYEES` trong `employees.js` (mỗi người: `code`, `name`, `section`,
`group`, `active` — `active:false` nếu có ngày nghỉ việc) rồi thay nguyên
file. Nhân viên trùng tên vẫn phân biệt được vì danh sách gợi ý luôn hiện
kèm Mã NV.

## Dropdown gợi ý trên form tài sản
3 ô sau đều gõ-để-gợi-ý (bấm vào ô cũng hiện sẵn danh sách, không bắt
buộc chọn — vẫn gõ tay hoặc để trống được):
- **Người sử dụng** — gợi ý từ `employees.js`, chọn xong tự điền kèm Mã
  NV / Bộ phận / Tổ-Chuyền.
- **Mã nhân viên** — gợi ý từ `employees.js` theo mã, chọn xong tự điền
  kèm Tên / Bộ phận / Tổ-Chuyền (điền 2 chiều với "Người sử dụng").
- **Bộ phận (Section)** — gợi ý từ các Section có trong `employees.js`.
  Chọn ở đây chỉ điền riêng ô Bộ phận, không đụng Tên/Mã NV/Tổ-Chuyền, vì
  một Bộ phận có nhiều người nên không suy ngược ra 1 nhân viên cụ thể
  được.

**Mã tài sản** không còn phải gõ tay từ đầu — app tự gợi ý ngay khi chọn
Loại thiết bị và/hoặc Bộ phận, theo dạng
`[Viết tắt Thiết bị]-[Viết tắt Bộ phận]-[số thứ tự 4 số]`, ví dụ
`LAP-AT-0001`. Đây vẫn chỉ là gợi ý (giống các ô ở trên) — sửa tay thoải
mái, app sẽ không tự ghi đè lên mã đã sửa nữa. Viết tắt Loại thiết bị và
Bộ phận được khai báo trong `app.js` (`ASSET_TYPE_ABBR`, `SECTION_ABBR`);
Bộ phận chưa có trong bảng sẽ tự suy viết tắt từ chữ cái đầu mỗi từ.

Admin có thể chuẩn bị sẵn 1 file Excel (`it-asset-inventory-...xlsx` xuất
từ app, hoặc tự soạn theo đúng cột chuẩn ở trên) điền sẵn Người sử
dụng/Mã nhân viên/Bộ phận cho từng mã tài sản, rồi vào **Dữ liệu → Nhập
Excel** để import hàng loạt — không cần nhập tay từng cái.

## Phân quyền: Admin (IT) vs tài khoản Thu thập dữ liệu

App có 2 loại tài khoản:

- **Admin (IT)**: toàn quyền tạo/sửa/xóa mọi tài sản, dùng Excel/Backup.
- **Collector (thu thập dữ liệu)**: 1 tài khoản dùng chung, IT đăng nhập
  bằng tài khoản này ở mọi máy khi đi kiểm kê. Tài khoản này **chỉ tạo mới
  được**, xem được toàn bộ danh sách (để tránh trùng mã), nhưng **không sửa
  và không xóa được bất kỳ tài sản nào** — kể cả tài sản nó vừa tạo ra. Nếu
  phát hiện sai sót, phải đăng nhập lại bằng tài khoản Admin để chỉnh.

Việc phân quyền này được chốt chặn thật sự ở **Firestore Security Rules**
(`firestore.rules` đi kèm) — ẩn nút trên giao diện chỉ là tiện lợi hiển thị,
không phải bảo mật. Ai đó rành kỹ thuật vẫn có thể gọi thẳng Firestore nếu
Rules không publish đúng, nên bước dưới đây là bắt buộc.

### 1. Publish Firestore Rules
Firebase Console → Firestore Database → Rules → dán nội dung file
`firestore.rules` → Publish.

### 2. Tạo 2 tài khoản trong Authentication
Authentication → Users → Add user, tạo 2 tài khoản (email + mật khẩu do IT
tự đặt), ví dụ:
- `admin@congty.com` — dùng khi cần sửa/xóa/export/backup.
- `kiemke@congty.com` — dùng để đi kiểm kê ở từng máy.

### 3. Gán vai trò cho từng UID
Với mỗi tài khoản vừa tạo, mở tab **Authentication** để lấy **UID**, rồi vào
**Firestore Database → Data**, tạo collection `users` → tạo document với
**Document ID = UID đó** → thêm field `role` (kiểu string):
- Tài khoản admin → `role = "admin"`
- Tài khoản kiểm kê → `role = "collector"`

Tài khoản nào **không có** document trong `users` sẽ bị từ chối truy cập
hoàn toàn (app tự đăng xuất và báo "chưa được cấp quyền") — đây là lựa chọn
an toàn theo hướng "mặc định không có quyền", tránh lộ dữ liệu nếu quên gán
vai trò.

### 4. Quy trình khi đi kiểm kê
1. Trên điện thoại, đăng nhập bằng tài khoản **kiemke@congty.com**.
2. Quét QR/điền form/chụp ảnh cho từng máy, bấm Lưu — mỗi bản ghi tạo xong
   tự đánh dấu "Đã khóa" để biết cần Admin rà soát sau, nhưng bản thân tài
   khoản này không sửa lại được nữa (kể cả bản ghi vừa tạo).
3. Đi hết các máy xong thì đăng xuất.
4. Nếu phát hiện sai sót: đăng nhập bằng tài khoản **admin**, mở tài sản đó,
   admin luôn sửa được (có ô "Đã khóa" chỉ mang tính ghi chú, không chặn
   admin).

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
