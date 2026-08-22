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

**Cập nhật danh sách nhân viên:** vào **Dữ liệu → "Nhân viên (HR)"**, bấm
"⬆ Nhập Excel HR" và chọn thẳng file HR vừa xuất (sheet đầu
`ImportEmployeeProfile`, không cần sửa gì trước) — app tự đọc 4 cột
`Employee Code`, `Full Name _VN`, `Section`, `Group` (dò theo các
"machine tag" `@EmployeeID`/`@FullName`/`@SectionName`/`@GroupName` có sẵn
trong file, không phụ thuộc thứ tự cột) và cột "Terminate date" để suy ra
`active` (`false` nếu có ngày nghỉ việc), rồi lưu thẳng lên Firestore —
danh sách gợi ý cập nhật ngay trên **mọi thiết bị/tài khoản đang dùng app**,
không cần build lại `employees.js` hay deploy lại. `employees.js` giờ chỉ
còn là danh sách dự phòng (dùng khi mất mạng hoặc trước khi từng import lần
nào qua Firestore); vẫn có thể tự sửa tay file này như cũ nếu muốn, nhưng
sẽ bị danh sách trên Firestore ghi đè ngay khi có ai đó import lại qua app.
Chỉ tài khoản **Admin** mới thấy mục Dữ liệu và được import; Collector chỉ
đọc để dùng autocomplete. Nhân viên trùng tên vẫn phân biệt được vì danh
sách gợi ý luôn hiện kèm Mã NV.

## Máy không có mạng: lấy thông tin máy bằng QR (không cần gõ tay)
Trong khung "⚙ Lấy thông tin máy (PC/Laptop)" trên form tài sản có 2 nút:
- **📋 Copy lệnh PowerShell** — dùng cho máy có mạng: chạy xong tự copy
  kết quả vào khung dán, bấm "Tự động điền".
- **📱 Copy lệnh PowerShell (Tạo QR — máy không có mạng)** — dùng cho máy
  **không có Internet**. Chạy trên máy đó, script sẽ **tự mở 1 trang QR
  ngay trên trình duyệt của máy đó** (trang này tự chứa sẵn thư viện tạo
  QR, hoàn toàn không cần mạng). Sau đó chỉ cần bấm "▶ Bắt đầu quét" trên
  điện thoại (trang Quét QR trong app) và đưa camera vào mã QR đó — form
  tài sản trên điện thoại sẽ **tự điền Device name/Model/Serial/Cấu
  hình/Thông tin Windows/IP/MAC**, không cần chép tay bất kỳ thông tin
  nào qua lại giữa 2 máy. Loại thiết bị/Bộ phận/Người sử dụng vẫn cần
  chọn tay như bình thường rồi lưu.
- Nếu trình duyệt trên máy offline không tự mở, mở file
  `%TEMP%\asset-qr-...html` bằng tay rồi đưa điện thoại lên quét.
- Script vẫn in kèm bản tóm tắt dạng chữ ra cửa sổ PowerShell (giống nút
  trên) để dùng khung "Dán thông tin máy" làm phương án dự phòng nếu vì
  lý do gì đó không quét được QR.

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

## Ticket hỗ trợ IT (Helpdesk)
App có thêm mục **🎫 Ticket** (trang riêng + thẻ tóm tắt trên Tổng quan) để
ghi nhận và theo dõi các yêu cầu/sự cố IT — tương đương sổ Excel Helpdesk
cũ, nhưng đồng bộ realtime nhiều người dùng, có lịch sử thay đổi, và có
thể liên kết trực tiếp tới 1 tài sản đã kiểm kê trong app.

**Phân quyền giống hệt Tài sản:** Admin toàn quyền tạo/sửa/xóa/đổi trạng
thái; tài khoản Collector chỉ tạo ticket mới được, không sửa lại được (kể
cả ticket vừa tạo) — ticket họ tạo tự động đánh dấu "Đã khóa" để Admin biết
cần rà soát. Việc này được chốt chặn thật ở Firestore Rules, xem file
`firestore.rules` đi kèm (đã thêm collection `tickets` cùng logic với
`assets`) — publish lại file này trong Firebase Console → Firestore
Database → Rules nếu bạn đã publish 1 bản rules khác từ trước (file này
cũng đã có collection `employees` — dùng cho tính năng Nhập Excel HR ở
mục "Nhân viên (autocomplete...)" phía trên — publish lại nếu bạn đang
dùng bản rules cũ chưa có collection này).

**Các trường của 1 ticket:**
- Mã ticket — tự gợi ý dạng `IT-YYYYMMDD-NNN` theo ngày tạo (vẫn sửa tay
  được), là ID tài liệu Firestore nên luôn duy nhất.
- Mức ưu tiên: Thấp / Trung bình / Cao / Khẩn.
- Trạng thái: Chờ / Đang xử lý / Hoàn thành.
- Người yêu cầu, Phòng ban — gõ-để-gợi-ý từ `employees.js` giống form tài
  sản, chọn xong tự điền kèm Phòng ban.
- Liên kết tài sản (tuỳ chọn) — gõ mã/tên người dùng để tìm và chọn 1 tài
  sản đã có trong app; chọn xong tự điền hộ Thiết bị/Phòng ban nếu đang
  trống. Gõ tay đè lên ô này sẽ hủy liên kết cũ.
- Thiết bị — mô tả tự do (không bắt buộc phải là tài sản đã kiểm kê).
- Mô tả, Nguyên nhân, Cách xử lý, Ghi chú.
- Ảnh hiện trạng (chụp trực tiếp hoặc chọn ảnh có sẵn).
- Lịch sử thay đổi — tự động ghi lại mỗi lần tạo/sửa, giống hệt cơ chế của
  tài sản.

**Excel:** mục Dữ liệu → "Excel — Ticket" có Xuất/Nhập riêng cho ticket
(không lẫn với Excel tài sản). Cột file nhập khớp với cấu trúc file
Helpdesk cũ (Ticket ID, Ưu tiên, Trạng thái, Người yêu cầu, Phòng ban,
Thiết bị, Mô tả, Nguyên nhân, Cách xử lý, Ghi chú) nên có thể import thẳng
file Excel Helpdesk hiện có — cột "Mã tài sản liên kết" là cột riêng của
app này, không bắt buộc phải có khi import.

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
