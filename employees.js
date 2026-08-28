/* employees.js — Danh sách nhân viên "dự phòng" (fallback), dùng CHỈ khi:
   1) app chưa đăng nhập xong, hoặc
   2) đăng nhập rồi nhưng đang offline và chưa từng đồng bộ Firestore lần nào
      trên chính thiết bị này (xem initEmployeesSync trong app.js).

   ⚠️ KHÔNG chép danh sách nhân viên thật (tên/mã NV/bộ phận) vào file này.
   Đây là file JS tĩnh, được trình duyệt tải công khai cùng với index.html/
   app.js — KHÔNG bị chặn bởi màn hình đăng nhập hay Firestore Rules, vì nó
   nằm ngoài Firestore hoàn toàn. Bất kỳ ai biết URL của app đều tải được
   file này, kể cả khi chưa đăng nhập.

   Nguồn dữ liệu nhân viên thật là collection Firestore "employees" —
   được nạp qua "Dữ liệu → Nhân viên (HR) → Nhập Excel HR" (xem
   importEmployeesXlsx trong app.js) và chỉ đọc được khi đã đăng nhập với
   vai trò Admin/Collector/Viewer (xem firestore.rules, match /employees/{id}).
   Sau khi import ít nhất 1 lần, dữ liệu Firestore sẽ tự động GHI ĐÈ mảng
   rỗng bên dưới ngay khi ứng dụng đăng nhập + đồng bộ xong — file này chỉ
   còn tác dụng cho 2 trường hợp hiếm ở trên, và không cần cập nhật tay nữa.
*/
window.EMPLOYEES = [];
