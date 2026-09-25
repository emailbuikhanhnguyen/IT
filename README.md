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

## Phân quyền: Admin (IT) vs Thu thập dữ liệu vs Chỉ xem (Ban giám đốc)

App có 3 loại tài khoản:

- **Admin (IT)**: toàn quyền tạo/sửa/xóa mọi tài sản, dùng Excel/Backup.
- **Collector (thu thập dữ liệu)**: 1 tài khoản dùng chung, IT đăng nhập
  bằng tài khoản này ở mọi máy khi đi kiểm kê. Tài khoản này **chỉ tạo mới
  được**, xem được toàn bộ danh sách (để tránh trùng mã), nhưng **không sửa
  và không xóa được bất kỳ tài sản nào** — kể cả tài sản nó vừa tạo ra. Nếu
  phát hiện sai sót, phải đăng nhập lại bằng tài khoản Admin để chỉnh.
- **Viewer (chỉ xem)**: dành cho Ban giám đốc — xem được **toàn bộ** dữ
  liệu (tài sản, ticket...) giống Collector, nhưng **không tạo/sửa/xóa**
  được bất cứ gì. Giao diện tự ẩn hết các nút "Tạo mới"/"Thêm" khi đăng
  nhập bằng tài khoản này.

Việc phân quyền này được chốt chặn thật sự ở **Firestore Security Rules**
(`firestore.rules` đi kèm) — ẩn nút trên giao diện chỉ là tiện lợi hiển thị,
không phải bảo mật. Ai đó rành kỹ thuật vẫn có thể gọi thẳng Firestore nếu
Rules không publish đúng, nên bước dưới đây là bắt buộc.

### 1. Publish Firestore Rules
Firebase Console → Firestore Database → Rules → dán nội dung file
`firestore.rules` → Publish.

### 2. Tạo tài khoản trong Authentication
Authentication → Users → Add user, tạo tài khoản (email + mật khẩu do IT
tự đặt) cho từng vai trò cần dùng, ví dụ:
- `admin@congty.com` — dùng khi cần sửa/xóa/export/backup.
- `kiemke@congty.com` — dùng để đi kiểm kê ở từng máy.
- `giamdoc@congty.com` — cấp cho Ban giám đốc để xem/theo dõi (không sửa).

### 3. Gán vai trò cho từng UID
Với mỗi tài khoản vừa tạo, mở tab **Authentication** để lấy **UID**, rồi vào
**Firestore Database → Data**, tạo collection `users` → tạo document với
**Document ID = UID đó** → thêm field `role` (kiểu string):
- Tài khoản admin → `role = "admin"`
- Tài khoản kiểm kê → `role = "collector"`
- Tài khoản Ban giám đốc → `role = "viewer"`

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
- Mã nhân viên, Người yêu cầu, Phòng ban — gõ-để-gợi-ý từ danh sách nhân
  viên (giống form tài sản), điền 2 chiều: chọn Mã NV thì tự điền Người
  yêu cầu + Phòng ban, hoặc chọn Người yêu cầu thì tự điền Mã NV + Phòng ban.
- Liên kết tài sản (tuỳ chọn) — gõ mã/tên người dùng để tìm và chọn 1 tài
  sản đã có trong app; chọn xong tự điền hộ Thiết bị/Phòng ban/Mã nhân viên
  nếu đang trống. Gõ tay đè lên ô này sẽ hủy liên kết cũ.
  **Chiều ngược lại:** chọn/điền xong Mã nhân viên (hoặc chọn Người yêu
  cầu — cả hai đều suy ra Mã NV), app tự dò trong danh sách tài sản đã
  kiểm kê xem nhân viên đó đang được gán máy nào (theo Mã nhân viên lưu
  trên tài sản): đúng 1 máy thì tự điền luôn ô Liên kết tài sản (và
  Thiết bị nếu đang trống); nhiều hơn 1 máy thì hiện sẵn danh sách các
  máy đó ngay trong ô Liên kết tài sản để bấm chọn đúng cái đang cần.
  Việc này bỏ qua nếu ô Liên kết tài sản đã có sẵn 1 liên kết từ trước
  (để không ghi đè lựa chọn đã chọn tay).
- Thiết bị — mô tả tự do (không bắt buộc phải là tài sản đã kiểm kê).
- Mô tả, Nguyên nhân, Cách xử lý, Ghi chú.
- Ảnh hiện trạng (chụp trực tiếp hoặc chọn ảnh có sẵn).
- Lịch sử thay đổi — tự động ghi lại mỗi lần tạo/sửa, giống hệt cơ chế của
  tài sản.

**Lịch sử xử lý (mốc theo thời gian):** khác với "Lịch sử thay đổi" (tự động
ghi lại mọi lần sửa field) và khác với ô "Cách xử lý" (chỉ 1 kết quả cuối
cùng), mục **🕒 Lịch sử xử lý** cho phép ghi nhiều dòng theo thời gian trong
lúc theo dõi 1 ticket (vd: "22/08 đã liên hệ NCC", "23/08 đang chờ linh
kiện", "25/08 đã thay xong") — mỗi dòng tự kèm thời gian và người ghi, xoá
được từng dòng trước khi Lưu ticket. Cả Admin và Collector đều thêm được
(Collector chỉ thêm được lúc đang tạo ticket mới, vì sửa ticket có sẵn vẫn
chỉ dành cho Admin như mọi field khác).

**Ticket liên quan (lỗi lặp lại):** mục **🔁 Ticket liên quan** (chỉ Admin
thấy, vì cần quyền sửa ticket khác) cho phép liên kết ticket đang mở với
(các) ticket khác cùng 1 lỗi — gõ mã ticket/mô tả để tìm và chọn. Liên kết
lưu 2 chiều: khi Lưu, app tự ghi thêm liên kết ngược sang từng ticket được
chọn nên mở ticket kia cũng thấy liên kết trở lại. Danh sách Ticket sẽ hiện
badge "🔁 Lặp lại N lần" (N = số ticket liên kết + chính nó) để nhận ra ngay
lỗi nào đang tái diễn nhiều lần. Lưu ý: gỡ 1 liên kết chỉ gỡ ở ticket đang
sửa — muốn gỡ hẳn 2 chiều thì vào ticket kia gỡ thêm lần nữa.

**Excel:** mục Dữ liệu → "Excel — Ticket" có Xuất/Nhập riêng cho ticket
(không lẫn với Excel tài sản). Cột file nhập khớp với cấu trúc file
Helpdesk cũ (Ticket ID, Ưu tiên, Trạng thái, Người yêu cầu, Phòng ban,
Thiết bị, Mô tả, Nguyên nhân, Cách xử lý, Ghi chú) nên có thể import thẳng
file Excel Helpdesk hiện có — 2 cột "Mã nhân viên" và "Mã tài sản liên kết"
là cột riêng của app này, không bắt buộc phải có khi import. Cột "Hình
ảnh" (nếu có) không được import — ảnh chỉ đính kèm được qua app (chụp/chọn
ảnh trong form ticket).

Khi nhập file cũ, "Ưu tiên"/"Trạng thái" được so khớp không phân biệt
hoa/thường và chấp nhận vài cách viết hay gặp (VD: "đang xử lí" ~ "Đang xử
lý") thay vì so khớp tuyệt đối, để tránh âm thầm rơi về giá trị mặc định.
Nếu trong file có 2 dòng trùng Mã ticket (dữ liệu khác nhau — hay gặp ở
file đánh số tay), app tự thêm hậu tố (VD: "IT-20260817-001-2") cho dòng
trùng để không mất dữ liệu; sau khi import nên vào sửa lại Mã cho gọn nếu
muốn.

## Máy in (🛠 Vận hành & Hỗ trợ IT → 🖨 Máy in)
Theo dõi máy in **thuê** và **tự mua**, nhà cung cấp (NCC), công nợ và lịch sử sửa chữa. Code ở `printers.js` (+ chuỗi VI/EN/ZH ở `printers-i18n.js`).

- **Quét QR/barcode khi thêm máy in**: nút "Bắt đầu quét" (hoặc chọn ảnh chứa mã) ở đầu form. Nhận tem tài sản của app (liên kết + điền thông tin), QR hãng (`S/N:`, `Model:`, `?sn=`), barcode trơn (= Serial), DEVINFO từ PowerShell; cảnh báo nếu Serial trùng máy in khác và gợi ý liên kết tài sản trùng Serial.
  Nút **📸 Chụp ảnh tem** / **🖼 Chọn ảnh** đọc mọi QR/barcode trong ảnh (BarcodeDetector của trình duyệt, dự phòng html5-qrcode) rồi **đọc chữ trên tem bằng OCR** (Tesseract.js, tải từ CDN — lần đầu cần mạng) để điền Hãng / Model / Serial / Loại máy khi tem không có mã. OCR chỉ điền ô đang trống.
- **Danh sách máy in**: mã `MI-0001` tự gợi ý; hãng/model/serial/loại, bộ phận, vị trí, IP, tình trạng; có thể liên kết với tài sản đã kiểm kê. Máy thuê: số HĐ, ngày bắt đầu/hết hạn, tiền thuê/tháng, số trang miễn phí, đơn giá trang vượt. Máy tự mua: ngày mua, giá, bảo hành.
- **Lịch sử sửa chữa/bảo trì**: từng lần (ngày, loại, nội dung, chi phí, NCC). Tick "Ghi nhận công nợ" để khi Lưu máy in tự tạo hóa đơn phải trả cho NCC. Form còn hiện các Ticket liên quan (qua Mã tài sản hoặc mã máy in ghi ở ô Thiết bị).
- **NCC**: bên cho thuê / sửa chữa / mực & vật tư / bán máy, liên hệ, MST, thời hạn thanh toán (dùng tự tính hạn thanh toán hóa đơn).
- **Công nợ**: hóa đơn theo NCC, ghi nhận nhiều lần thanh toán (trả một phần được); số còn nợ, trạng thái, quá hạn đều **tự tính**. Nút "Tạo tiền thuê tháng này" sinh hóa đơn thuê cho mọi máy thuê đang trong hợp đồng (không tạo trùng).
- **Cảnh báo** ở trang tổng quan: hợp đồng thuê còn ≤ 60 ngày/đã hết hạn, hóa đơn quá hạn. **Xuất Excel** 4 sheet: Máy in, Nhà cung cấp, Công nợ, Sửa chữa.
- **Phân quyền**: Admin toàn quyền; Viewer (Ban giám đốc) chỉ xem; **Collector không thấy** mục này (có giá thuê/công nợ).
- **Bắt buộc publish lại `firestore.rules`** (thêm 3 collection `printers`, `printer_vendors`, `printer_invoices`), nếu không module sẽ báo permission-denied.

## Đề nghị thanh toán (🛠 Vận hành & Hỗ trợ IT → 📝 Đề nghị thanh toán)
Trang chung để lập **Giấy đề nghị thanh toán** từ hóa đơn/chứng từ PDF của **mọi NCC** (Internet/viễn thông, máy in – máy photo, mực & vật tư, dịch vụ khác). Thay cho trang "Chuyển đổi báo cáo (Word → JPG)" cũ. Code ở `payreq.js`.

1. **Chọn file PDF** (nhiều file, nhiều NCC cùng lúc). App đọc chữ trong PDF ngay trên thiết bị (pdf.js — không upload lên server) và tự nhận dạng: hóa đơn VNPT, hóa đơn FTTH Viettel, Thông báo cước Viettel, và hóa đơn điện tử VN dạng chuẩn của các NCC khác (DNP, Việt Bảo...). Bảng báo giá và bảng kê đính kèm được tự bỏ qua.
2. **Kiểm tra từng chứng từ**: NCC/MST, số, ký hiệu, ngày, nội dung, trước thuế/VAT/tổng — sửa được tất cả, thêm dòng nhập tay được. Cảnh báo: thiếu số liệu, tổng lệch, MST người mua khác công ty, trùng trong cùng lượt, **đã có trong lịch sử đề nghị** (tránh trả 2 lần), đã có trong công nợ Máy in/Network.
3. **Mỗi NCC = 1 giấy đề nghị** (Excel theo mẫu `pay-template.xlsx`, nhiều dòng chứng từ, số tiền bằng chữ VN/EN tự điền). STK/ngân hàng/hạn thanh toán tự điền từ hóa đơn hoặc danh bạ NCC (VNPT/Viettel nạp sẵn; NCC từ Máy in/Network; NCC đã từng lập trên máy này). Nhiều NCC → tải từng file hoặc **tải tất cả (.zip)**.
4. **Lịch sử** (Admin ghi, Viewer xem): mỗi lần tạo lưu 1 bản ghi vào `pay_requests` — dùng để cảnh báo trùng và **tạo lại file Excel** bất cứ lúc nào.

- PDF dạng ảnh (scan) không có chữ: nhập tay hoặc bấm **Thử đọc bằng OCR** (Tesseract.js tải từ CDN, lần đầu cần mạng; kết quả OCR phải kiểm tra kỹ).
- Người ký (người đề nghị, trưởng bộ phận, kế toán trưởng, quản lý tài chính, mã số) được nhớ trên trình duyệt, dùng chung với trang Đề nghị thanh toán trong Máy in/Network.
- Vai trò `reportonly` (cũ: "Chuyển đổi báo cáo") giờ chỉ thấy đúng trang này; không cần đọc Firestore nên không thấy lịch sử.
- Collector không thấy trang này (có số tiền/tài khoản NCC).
- **Bắt buộc publish lại `firestore.rules`** (thêm collection `pay_requests`) nếu muốn lưu/xem lịch sử; nếu chưa publish, phần tạo Excel vẫn chạy bình thường, chỉ báo lỗi khi lưu lịch sử.
- **Đây là nơi DUY NHẤT để lập giấy đề nghị thanh toán** — Máy in và Network không còn trang "Đề nghị thanh toán" riêng nữa (đã bỏ). Khi Admin lưu 1 giấy đề nghị (tick "Lưu lịch sử đề nghị"), nếu NCC trên hóa đơn khớp với NCC đã có trong danh bạ Máy in (`printer_vendors`) hoặc Network (`net_providers`) — khớp theo mã số thuế trước, không có thì khớp gần đúng theo tên — hóa đơn được **tự động thêm/cập nhật vào `printer_invoices`/`net_invoices`** để Công nợ ở 2 module đó tự cập nhật theo, không cần nhập lại. Hóa đơn trùng số của cùng NCC chỉ cập nhật, không tạo trùng. NCC chưa từng tạo ở Máy in/Network thì **không tự tạo hóa đơn** (tránh hóa đơn "mồ côi" không có vendorId/providerId) — ứng dụng báo số hóa đơn chưa khớp được, vào tạo NCC ở Máy in/Network trước rồi lập lại giấy đề nghị. Máy in vẫn còn form "Thêm hóa đơn" thủ công riêng ở trang Công nợ cho trường hợp cần nhập tay ngay mà chưa qua Đề nghị thanh toán.

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

### Máy in — Báo cáo sửa chữa & nạp dữ liệu DNP
- **Máy in → Báo cáo sửa chữa**: lọc theo NCC / máy / loại / kết quả / khoảng ngày, thống kê theo NCC, xuất Excel (2 sheet: chi tiết + tổng hợp NCC).
- Mỗi lần sửa chữa có thêm: Tình trạng, Xử lý, Kết quả (🟩 Thành công / 🟨 Đang theo dõi / 🟥 Chưa thành công), Đề xuất tiếp theo.
- Nút **Nạp dữ liệu máy in DNP** (admin) ở trang Máy in: tạo NCC DNP, 6 máy in và 16 lần sửa từ file theo dõi 18/09/2026 (dữ liệu trong `printers-seed.js`); bấm lại không bị trùng.

### Máy in — Đề nghị thanh toán
- **Đã bỏ trang "Máy in → Đề nghị thanh toán"** (đọc PDF + xuất Excel riêng cho máy in). Lập giấy đề nghị thanh toán cho NCC máy in ở trang chung **🛠 Vận hành & Hỗ trợ IT → 📝 Đề nghị thanh toán** — hóa đơn sẽ tự được thêm vào Công nợ máy in nếu NCC khớp (xem mục "Đề nghị thanh toán" phía trên).
- Trang Công nợ máy in vẫn còn nút **＋ Thêm hóa đơn** để nhập tay khi cần (không qua PDF).
- Máy thuê có thêm **VAT (%)** (tiền thuê khai báo là giá chưa VAT); công nợ tiền thuê tính cả VAT. NCC có thêm số tài khoản/ngân hàng.
- Muốn đổi mẫu in giấy đề nghị: thay file `pay-template.xlsx` (giữ nguyên vị trí các ô: F1, C2–C8, C10–C13, D14, G14, A19–G19, G20, A28/B28/D28).

## Network › Thanh toán cước Internet (network-isp.js)

Vào **Vận hành & Hỗ trợ IT → Network**. Chỉ Admin/Viewer thấy (Collector thì không).

- **Đường truyền & NCC**: bấm “Nạp NCC & đường truyền VNPT/Viettel” để tạo sẵn 2 NCC (kèm tài khoản nhận tiền) và 6 đường truyền. Sửa/thêm tùy ý.
- **Đã bỏ trang "Đề nghị thanh toán cước"** (đọc PDF + xuất Excel riêng cho Network). Lập giấy đề nghị thanh toán cho NCC mạng ở trang chung **🛠 Vận hành & Hỗ trợ IT → 📝 Đề nghị thanh toán** — hóa đơn sẽ tự được thêm vào Công nợ cước Internet nếu NCC khớp (khớp theo mã số thuế + mã KH/số hợp đồng/tên thuê bao để xác định đúng đường truyền — xem mục "Đề nghị thanh toán" phía trên).
- **Công nợ cước Internet**: hóa đơn từng tháng, ghi nhận thanh toán, quá hạn. Không còn cách thêm hóa đơn thủ công riêng ở trang này — thêm qua trang Đề nghị thanh toán chung (NCC phải có sẵn trong "Đường truyền & NCC" ở trên thì mới tự khớp được).
- Firestore: `net_providers`, `net_lines`, `net_invoices` — **nhớ Publish lại `firestore.rules`**.

## 🤖 Trợ lý AI (ai.js + ai-worker/) — Google Gemini gói miễn phí

Dùng Gemini API (gói miễn phí, không cần thẻ) cho 5 việc. **AI không bao giờ tự ghi Firestore**: mọi thay đổi đều đi qua form hoặc bảng duyệt, người dùng bấm Lưu/Áp dụng, rồi Firestore Rules kiểm tra như bình thường.

| Chức năng | Ở đâu | Vai trò | Kỹ thuật |
|---|---|---|---|
| Đọc hóa đơn/chứng từ | Đề nghị thanh toán → nút **🤖 Đọc bằng AI** trên từng dòng | admin, viewer, reportonly | Structured output (responseSchema), đọc thẳng PDF/scan |
| Tạo ticket từ tin nhắn | Form ticket → khung 🤖 → **✨ Phân tích & điền form** | admin, collector | Structured output + few-shot, thang ưu tiên |
| Gợi ý nguyên nhân / cách xử lý / ticket lặp lại | Form ticket → **💡 Gợi ý** | admin, collector, viewer | RAG đơn giản (app tự lọc ticket cũ tương tự) + hậu kiểm chống bịa mã ticket |
| Hỏi đáp dữ liệu IT | Tổng quan → **🤖 Trợ lý AI** | admin, collector, viewer | Agent + function calling, tool chạy trên trình duyệt |
| Tóm tắt điều hành | Trang Trợ lý AI | admin, viewer | App tự tính số liệu → AI chỉ diễn đạt |
| Chuẩn hóa Model/Cấu hình + tìm trùng Serial/MAC/IP | Trang Trợ lý AI | admin | Structured output, duyệt từng thay đổi, có ghi lịch sử |

### ⚠ Lưu ý gói miễn phí
- **Google được dùng dữ liệu gửi lên để cải thiện sản phẩm** (hóa đơn NCC, tên/mã nhân viên, nội dung ticket...). Nếu không chấp nhận, bật billing cho project trong Google AI Studio (chuyển sang gói trả phí, Google không dùng dữ liệu nữa) — không cần sửa code.
- Giới hạn khoảng 10–15 request/phút và khoảng 1.000 request/ngày cho mỗi model. Mỗi câu hỏi Trợ lý có thể tốn 2–4 request (mỗi lần gọi tool là 1 request). Hết hạn mức thì app báo "thử lại sau ít phút"; Worker tự chuyển sang model dự phòng `MODEL_FALLBACK`.

### Kiến trúc
```
Trình duyệt ──Firebase ID token──▶ Cloudflare Worker ──API key──▶ Gemini API
   └─ tool của agent chạy ngay trên dữ liệu đã đồng bộ (assets, tickets, ...)
```
- **Worker** (`ai-worker/worker.js`) giữ API key, prompt, schema và danh sách tool. Worker xác minh chữ ký token Firebase, đọc `users/{uid}` để lấy vai trò, lọc tool theo vai trò (Collector không có tool công nợ/máy in) và giới hạn 10 request/phút cho mỗi tài khoản.
- Worker chuyển đổi định dạng hội thoại của app sang định dạng Gemini (functionCall/functionResponse, giữ nguyên thoughtSignature). Muốn đổi sang nhà cung cấp AI khác chỉ cần sửa Worker, không phải sửa app.
- Mô hình mặc định: `MODEL_FAST` = `gemini-3.5-flash-lite` (trích xuất), `MODEL_SMART` = `gemini-3.8-flash` (agent, tóm tắt), `MODEL_FALLBACK` = `gemini-3.1-flash-lite`. Đổi trong biến môi trường của Worker.

### Cài đặt (1 lần, miễn phí)
1. **Lấy API key Gemini:** vào **aistudio.google.com/apikey** → đăng nhập Google → **Create API key** → copy key.
2. **Tạo Worker:** dash.cloudflare.com → Workers & Pages → Create → Create Worker → tên `it-main-ai` → Deploy → **Edit code** → xóa code mẫu, dán toàn bộ `ai-worker/worker.js` → Deploy. Vào Settings → Variables and Secrets → Add → loại **Secret**, tên `GEMINI_API_KEY`, giá trị là key ở bước 1.
3. Trong app, đăng nhập Admin → **🤖 Trợ lý AI → Cấu hình AI** → dán URL Worker (`https://it-main-ai.<tên>.workers.dev`) → **Lưu** → **Kiểm tra kết nối**.
4. Tài khoản `reportonly` không đọc được `meta/ai`. Muốn họ dùng AI đọc hóa đơn thì điền URL vào hằng `AI_ENDPOINT_DEFAULT` đầu file `ai.js`.
5. Không cần sửa `firestore.rules`.

### Test
Có thể chạy bằng `node`: các hàm thuần trong `window.AIX.pure` và hàm `handle()` của Worker (dùng fetch giả, gồm cả chuyển đổi định dạng Gemini).
